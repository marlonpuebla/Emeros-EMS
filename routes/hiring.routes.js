'use strict';
const { auth, adminOnly, managerOrAdmin, editorOrAbove, audit } = require('../middleware/auth');

module.exports = function (app) {

  /* ================================================================
     TEMPLATES
  ================================================================ */

  // GET /api/hiring/templates — list all templates
  app.get('/api/hiring/templates', auth, (req, res) => {
    try {
      const { dbAll } = req.app.locals;
      const templates = dbAll('SELECT * FROM package_templates ORDER BY id');
      res.json(templates);
    } catch (err) {
      console.error('[hiring] list templates error:', err);
      res.status(500).json({ error: 'Failed to list templates' });
    }
  });

  // GET /api/hiring/templates/:id — get template with all items
  app.get('/api/hiring/templates/:id', auth, (req, res) => {
    try {
      const { dbGet, dbAll } = req.app.locals;
      const template = dbGet('SELECT * FROM package_templates WHERE id = ?', [req.params.id]);
      if (!template) return res.status(404).json({ error: 'Template not found' });

      const items = dbAll(
        'SELECT * FROM template_items WHERE template_id = ? ORDER BY phase, sort_order',
        [req.params.id]
      );
      template.items = items;
      res.json(template);
    } catch (err) {
      console.error('[hiring] get template error:', err);
      res.status(500).json({ error: 'Failed to get template' });
    }
  });

  /* ================================================================
     HIRING PACKAGES
  ================================================================ */

  // GET /api/hiring/packages — list all packages with progress stats
  app.get('/api/hiring/packages', auth, (req, res) => {
    try {
      const { dbAll } = req.app.locals;
      const status = req.query.status || 'all';

      let where = '';
      const params = [];
      if (status === 'in_progress') {
        where = "WHERE hp.status = 'in_progress'";
      } else if (status === 'completed') {
        where = "WHERE hp.status = 'completed'";
      }

      const packages = dbAll(`
        SELECT hp.*,
          pt.name AS template_name,
          pt.role_type,
          (SELECT COUNT(*) FROM package_items pi WHERE pi.package_id = hp.id) AS total_items,
          (SELECT COUNT(*) FROM package_items pi WHERE pi.package_id = hp.id AND pi.status IN ('completed','waived','not_applicable')) AS completed_items
        FROM hiring_packages hp
        LEFT JOIN package_templates pt ON pt.id = hp.template_id
        ${where}
        ORDER BY hp.created_at DESC
      `, params);

      for (const pkg of packages) {
        pkg.completion_pct = pkg.total_items > 0
          ? Math.round((pkg.completed_items / pkg.total_items) * 100)
          : 0;
      }

      res.json(packages);
    } catch (err) {
      console.error('[hiring] list packages error:', err);
      res.status(500).json({ error: 'Failed to list packages' });
    }
  });

  // GET /api/hiring/packages/:id — get package with all items grouped by phase/category
  app.get('/api/hiring/packages/:id', auth, (req, res) => {
    try {
      const { dbGet, dbAll } = req.app.locals;
      const pkg = dbGet(`
        SELECT hp.*,
          pt.name AS template_name,
          pt.role_type
        FROM hiring_packages hp
        LEFT JOIN package_templates pt ON pt.id = hp.template_id
        WHERE hp.id = ?
      `, [req.params.id]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });

      const items = dbAll(
        'SELECT * FROM package_items WHERE package_id = ? ORDER BY phase, sort_order',
        [req.params.id]
      );

      // Group by phase, then by category
      const phases = {};
      for (const item of items) {
        if (!phases[item.phase]) phases[item.phase] = {};
        if (!phases[item.phase][item.category]) phases[item.phase][item.category] = [];
        phases[item.phase][item.category].push(item);
      }
      pkg.phases = phases;

      // Progress stats
      const total = items.length;
      const completed = items.filter(i => ['completed', 'waived', 'not_applicable'].includes(i.status)).length;
      pkg.total_items = total;
      pkg.completed_items = completed;
      pkg.completion_pct = total > 0 ? Math.round((completed / total) * 100) : 0;

      res.json(pkg);
    } catch (err) {
      console.error('[hiring] get package error:', err);
      res.status(500).json({ error: 'Failed to get package' });
    }
  });

  // POST /api/hiring/packages — create from template
  app.post('/api/hiring/packages', auth, managerOrAdmin, (req, res) => {
    try {
      const { dbGet, dbAll, dbRun, lastInsertId } = req.app.locals;
      const { template_id, candidate_name, position, applicant_id, employee_id, assigned_to } = req.body;

      if (!template_id || !candidate_name) {
        return res.status(400).json({ error: 'template_id and candidate_name are required' });
      }

      const template = dbGet('SELECT * FROM package_templates WHERE id = ?', [template_id]);
      if (!template) return res.status(404).json({ error: 'Template not found' });

      dbRun(`
        INSERT INTO hiring_packages (template_id, candidate_name, position, applicant_id, employee_id, assigned_to, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [template_id, candidate_name, position || null, applicant_id || null, employee_id || null, assigned_to || null, req.user.username]);

      const packageId = lastInsertId();

      // Copy template items into package items
      const templateItems = dbAll(
        'SELECT * FROM template_items WHERE template_id = ? ORDER BY phase, sort_order',
        [template_id]
      );
      for (const item of templateItems) {
        dbRun(`
          INSERT INTO package_items (package_id, phase, category, item_name, description, authority, required, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [packageId, item.phase, item.category, item.item_name, item.description, item.authority, item.required, item.sort_order]);
      }

      audit(req, 'CREATE_HIRING_PACKAGE', 'hiring_package', packageId,
        `Created package for ${candidate_name} from template "${template.name}"`);

      const created = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [packageId]);
      res.status(201).json(created);
    } catch (err) {
      console.error('[hiring] create package error:', err);
      res.status(500).json({ error: 'Failed to create package' });
    }
  });

  // PUT /api/hiring/packages/:id — update metadata
  app.put('/api/hiring/packages/:id', auth, managerOrAdmin, (req, res) => {
    try {
      const { dbGet, dbRun } = req.app.locals;
      const pkg = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [req.params.id]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });

      const { candidate_name, position, assigned_to, status, applicant_id, employee_id } = req.body;
      const updates = [];
      const params = [];

      if (candidate_name !== undefined) { updates.push('candidate_name = ?'); params.push(candidate_name); }
      if (position !== undefined)       { updates.push('position = ?'); params.push(position); }
      if (assigned_to !== undefined)    { updates.push('assigned_to = ?'); params.push(assigned_to); }
      if (status !== undefined)         { updates.push('status = ?'); params.push(status); }
      if (applicant_id !== undefined)   { updates.push('applicant_id = ?'); params.push(applicant_id); }
      if (employee_id !== undefined)    { updates.push('employee_id = ?'); params.push(employee_id); }

      if (status === 'completed') {
        updates.push("completed_at = datetime('now')");
      }
      updates.push("updated_at = datetime('now')");

      if (updates.length === 1) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      params.push(req.params.id);
      dbRun(`UPDATE hiring_packages SET ${updates.join(', ')} WHERE id = ?`, params);

      audit(req, 'UPDATE_HIRING_PACKAGE', 'hiring_package', Number(req.params.id),
        `Updated package fields: ${Object.keys(req.body).join(', ')}`);

      const updated = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [req.params.id]);
      res.json(updated);
    } catch (err) {
      console.error('[hiring] update package error:', err);
      res.status(500).json({ error: 'Failed to update package' });
    }
  });

  // DELETE /api/hiring/packages/:id — admin only
  app.delete('/api/hiring/packages/:id', auth, adminOnly, (req, res) => {
    try {
      const { dbGet, dbRun } = req.app.locals;
      const pkg = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [req.params.id]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });

      dbRun('DELETE FROM package_items WHERE package_id = ?', [req.params.id]);
      dbRun('DELETE FROM hiring_packages WHERE id = ?', [req.params.id]);

      audit(req, 'DELETE_HIRING_PACKAGE', 'hiring_package', Number(req.params.id),
        `Deleted package for ${pkg.candidate_name}`);

      res.json({ message: 'Package deleted' });
    } catch (err) {
      console.error('[hiring] delete package error:', err);
      res.status(500).json({ error: 'Failed to delete package' });
    }
  });

  /* ================================================================
     PACKAGE ITEMS
  ================================================================ */

  // PUT /api/hiring/packages/:pkgId/items/batch — batch update (must be before :itemId route)
  app.put('/api/hiring/packages/:pkgId/items/batch', auth, editorOrAbove, (req, res) => {
    try {
      const { dbGet, dbRun, dbAll } = req.app.locals;
      const pkg = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [req.params.pkgId]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });

      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items array is required' });
      }

      const results = [];
      for (const entry of items) {
        const item = dbGet('SELECT * FROM package_items WHERE id = ? AND package_id = ?',
          [entry.id, req.params.pkgId]);
        if (!item) {
          results.push({ id: entry.id, error: 'Item not found' });
          continue;
        }

        const updates = [];
        const params = [];

        if (entry.status) {
          updates.push('status = ?');
          params.push(entry.status);
          if (entry.status === 'completed') {
            updates.push('completed_by = ?');
            params.push(req.user.username);
            updates.push("completed_at = datetime('now')");
          }
        }
        if (entry.notes !== undefined) {
          updates.push('notes = ?');
          params.push(entry.notes);
        }

        if (updates.length > 0) {
          params.push(entry.id);
          dbRun(`UPDATE package_items SET ${updates.join(', ')} WHERE id = ?`, params);
        }
        results.push({ id: entry.id, status: entry.status || item.status });
      }

      audit(req, 'BATCH_UPDATE_PACKAGE_ITEMS', 'hiring_package', Number(req.params.pkgId),
        `Batch updated ${items.length} items`);

      res.json({ updated: results });
    } catch (err) {
      console.error('[hiring] batch update items error:', err);
      res.status(500).json({ error: 'Failed to batch update items' });
    }
  });

  // PUT /api/hiring/packages/:pkgId/items/:itemId — update single item
  app.put('/api/hiring/packages/:pkgId/items/:itemId', auth, editorOrAbove, (req, res) => {
    try {
      const { dbGet, dbRun } = req.app.locals;
      const pkg = dbGet('SELECT * FROM hiring_packages WHERE id = ?', [req.params.pkgId]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });

      const item = dbGet('SELECT * FROM package_items WHERE id = ? AND package_id = ?',
        [req.params.itemId, req.params.pkgId]);
      if (!item) return res.status(404).json({ error: 'Item not found' });

      const { status, notes, expiration_date, document_id } = req.body;
      const updates = [];
      const params = [];

      if (status !== undefined) {
        updates.push('status = ?');
        params.push(status);
        if (status === 'completed') {
          updates.push('completed_by = ?');
          params.push(req.user.username);
          updates.push("completed_at = datetime('now')");
        }
      }
      if (notes !== undefined)           { updates.push('notes = ?'); params.push(notes); }
      if (expiration_date !== undefined)  { updates.push('expiration_date = ?'); params.push(expiration_date); }
      if (document_id !== undefined)      { updates.push('document_id = ?'); params.push(document_id); }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      params.push(req.params.itemId);
      dbRun(`UPDATE package_items SET ${updates.join(', ')} WHERE id = ?`, params);

      audit(req, 'UPDATE_PACKAGE_ITEM', 'package_item', Number(req.params.itemId),
        `Updated item "${item.item_name}" in package ${req.params.pkgId}`);

      const updated = dbGet('SELECT * FROM package_items WHERE id = ?', [req.params.itemId]);
      res.json(updated);
    } catch (err) {
      console.error('[hiring] update item error:', err);
      res.status(500).json({ error: 'Failed to update item' });
    }
  });

  /* ================================================================
     STATS
  ================================================================ */

  // GET /api/hiring/stats
  app.get('/api/hiring/stats', auth, (req, res) => {
    try {
      const { dbGet } = req.app.locals;

      const active = dbGet("SELECT COUNT(*) AS cnt FROM hiring_packages WHERE status = 'in_progress'");
      const completed = dbGet("SELECT COUNT(*) AS cnt FROM hiring_packages WHERE status = 'completed'");

      const avgRow = dbGet(`
        SELECT AVG(pct) AS avg_pct FROM (
          SELECT hp.id,
            CASE WHEN COUNT(pi.id) = 0 THEN 0
              ELSE ROUND(100.0 * SUM(CASE WHEN pi.status IN ('completed','waived','not_applicable') THEN 1 ELSE 0 END) / COUNT(pi.id))
            END AS pct
          FROM hiring_packages hp
          LEFT JOIN package_items pi ON pi.package_id = hp.id
          WHERE hp.status = 'in_progress'
          GROUP BY hp.id
        )
      `);

      const pending = dbGet("SELECT COUNT(*) AS cnt FROM package_items WHERE status = 'pending'");
      const completedItems = dbGet("SELECT COUNT(*) AS cnt FROM package_items WHERE status = 'completed'");
      const waived = dbGet("SELECT COUNT(*) AS cnt FROM package_items WHERE status = 'waived'");
      const notApplicable = dbGet("SELECT COUNT(*) AS cnt FROM package_items WHERE status = 'not_applicable'");

      const overdue = dbGet(`
        SELECT COUNT(*) AS cnt FROM package_items pi
        JOIN hiring_packages hp ON hp.id = pi.package_id
        WHERE hp.status = 'in_progress'
          AND pi.status = 'pending'
          AND hp.created_at < datetime('now', '-30 days')
      `);

      res.json({
        active_packages: active ? active.cnt : 0,
        completed_packages: completed ? completed.cnt : 0,
        avg_completion_pct: avgRow && avgRow.avg_pct !== null ? Math.round(avgRow.avg_pct) : 0,
        items_by_status: {
          pending: pending ? pending.cnt : 0,
          completed: completedItems ? completedItems.cnt : 0,
          waived: waived ? waived.cnt : 0,
          not_applicable: notApplicable ? notApplicable.cnt : 0,
        },
        overdue_items: overdue ? overdue.cnt : 0,
      });
    } catch (err) {
      console.error('[hiring] stats error:', err);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  /* ================================================================
     WET-INK PDF UPLOAD — attach signed documents to a hiring package
  ================================================================ */
  const path   = require('path');
  const fs     = require('fs');
  const multer = require('multer');
  const config = require('../config');

  const pkgDocStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
    filename:    (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `hpkg_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`);
    },
  });
  const pkgDocUpload = multer({
    storage: pkgDocStorage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['application/pdf','image/png','image/jpeg','image/jpg'];
      cb(null, allowed.includes(file.mimetype));
    },
  });

  // Upload a signed/wet-ink document to a hiring package
  app.post('/api/hiring/packages/:pkgId/documents', auth, editorOrAbove,
    (req, res, next) => pkgDocUpload.single('file')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
    (req, res) => {
      const { dbGet, dbRun, lastInsertId } = req.app.locals;
      const pkg = dbGet('SELECT * FROM hiring_packages WHERE id=?', [req.params.pkgId]);
      if (!pkg) return res.status(404).json({ error: 'Package not found' });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const docName = req.body.document_name || req.file.originalname;
      dbRun(
        `INSERT INTO employee_documents
          (employee_id, doc_type, filename, original_name, mime_type, size_bytes, uploaded_by, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [pkg.employee_id || 0, 'Hiring Package: ' + docName, req.file.filename,
         req.file.originalname, req.file.mimetype, req.file.size,
         req.user.username, `Hiring Package #${req.params.pkgId} — ${docName}`]
      );
      const docId = lastInsertId();
      audit(req, 'UPLOAD_HIRING_DOC', 'hiring_package', Number(req.params.pkgId),
        { document_name: docName, file: req.file.originalname });
      res.status(201).json({ id: docId, filename: req.file.filename, document_name: docName });
    }
  );

  // List documents attached to a hiring package
  app.get('/api/hiring/packages/:pkgId/documents', auth, (req, res) => {
    const { dbAll } = req.app.locals;
    const docs = dbAll(
      "SELECT * FROM employee_documents WHERE doc_type LIKE ? ORDER BY uploaded_at DESC",
      [`Hiring Package:%`]
    ).filter(d => d.notes && d.notes.includes(`#${req.params.pkgId}`));
    res.json(docs);
  });

};
