'use strict';
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');
const config = require('../config');

function wrap(fn) {
  return function (req, res, next) {
    try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); }
    catch (e) { next(e); }
  };
}

// ── Proof-of-compliance attachment upload (images + PDF) ──────────────
const attachStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase() || '.bin';
    cb(null, `comp_${req.params.id}_${Date.now()}${ext}`);
  },
});
const ALLOWED_ATTACH = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];
const attachUpload = multer({
  storage: attachStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_ATTACH.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PNG, JPEG, WebP images and PDF files are allowed'), false);
  },
});

function employeeBucket(emp) {
  const text = `${emp.position_om || ''} ${emp.position_ahca || ''}`.toLowerCase();
  return /(therap|clin|nurse|rn|lpn|physician|medical|psychiatr|counsel|social|case manager|bcba|rbt|doctor|prescrib)/.test(text)
    ? 'clinical'
    : 'administrative';
}

function appliesToEmployee(req, emp) {
  const appliesTo = req.applies_to || 'all';
  return appliesTo === 'all' || appliesTo === employeeBucket(emp);
}

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── REQUIREMENTS ─────────────────────────────────────────── */

  app.get('/api/compliance/requirements', auth, wrap((req, res) => {
    res.json(dbAll('SELECT * FROM compliance_requirements ORDER BY category, name'));
  }));

  app.post('/api/compliance/requirements', auth, managerOrAdmin, wrap((req, res) => {
    const { name, category, applies_to, frequency, frequency_months, grace_period_days, can_decline, requires_attachment, notes } = req.body || {};
    if (!name)     return res.status(400).json({ error: 'name is required' });
    if (!category) return res.status(400).json({ error: 'category is required' });
    dbRun(
      `INSERT INTO compliance_requirements
        (name, category, applies_to, frequency, frequency_months, grace_period_days, can_decline, requires_attachment, notes, active, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,1,?)`,
      [name, category, applies_to || 'all', frequency || 'once',
       frequency_months ? Number(frequency_months) : null,
       grace_period_days ? Number(grace_period_days) : 30,
       can_decline ? 1 : 0, requires_attachment ? 1 : 0, notes || null, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'CREATE_COMPLIANCE_REQ', 'compliance_requirements', id, { name, category });
    res.status(201).json({ id, success: true });
  }));

  app.put('/api/compliance/requirements/:id', auth, managerOrAdmin, wrap((req, res) => {
    const req_row = dbGet('SELECT id FROM compliance_requirements WHERE id=?', [req.params.id]);
    if (!req_row) return res.status(404).json({ error: 'Requirement not found' });
    const { name, category, applies_to, frequency, frequency_months, grace_period_days, can_decline, requires_attachment, notes, active } = req.body || {};
    dbRun(
      `UPDATE compliance_requirements SET
        name=?, category=?, applies_to=?, frequency=?, frequency_months=?,
        grace_period_days=?, can_decline=?, requires_attachment=?, notes=?, active=?
       WHERE id=?`,
      [name, category, applies_to || 'all', frequency || 'once',
       frequency_months ? Number(frequency_months) : null,
       grace_period_days ? Number(grace_period_days) : 30,
       can_decline ? 1 : 0, requires_attachment ? 1 : 0, notes || null,
       active !== undefined ? (active ? 1 : 0) : 1,
       req.params.id]
    );
    audit(req, 'UPDATE_COMPLIANCE_REQ', 'compliance_requirements', Number(req.params.id));
    res.json({ success: true });
  }));

  app.delete('/api/compliance/requirements/:id', auth, managerOrAdmin, wrap((req, res) => {
    const req_row = dbGet('SELECT id FROM compliance_requirements WHERE id=?', [req.params.id]);
    if (!req_row) return res.status(404).json({ error: 'Requirement not found' });
    dbRun('DELETE FROM compliance_requirements WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_COMPLIANCE_REQ', 'compliance_requirements', Number(req.params.id));
    res.json({ success: true });
  }));

  /* ── RECORDS — per employee ───────────────────────────────── */

  app.get('/api/employees/:id/compliance', auth, wrap((req, res) => {
    const emp = dbGet('SELECT id, position_om, position_ahca FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const records = dbAll(
      `SELECT cr.*, req.name AS req_name, req.category AS req_category,
              req.frequency, req.frequency_months, req.can_decline, req.requires_attachment, req.applies_to
       FROM compliance_records cr
       JOIN compliance_requirements req ON cr.requirement_id = req.id
       WHERE cr.employee_id=?
       ORDER BY req.category, req.name`,
      [req.params.id]
    );
    const reqs = dbAll('SELECT * FROM compliance_requirements WHERE active=1 ORDER BY category, name')
      .filter(r => appliesToEmployee(r, emp));
    res.json({ records, requirements: reqs });
  }));

  app.post('/api/employees/:id/compliance', auth, editorOrAbove, wrap((req, res) => {
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const {
      requirement_id, status, completed_date, expiration_date,
      lot_number, administered_by, administration_site,
      notes, declined, declined_reason, declined_date, verified_by
    } = req.body || {};
    if (!requirement_id) return res.status(400).json({ error: 'requirement_id is required' });
    const req_row = dbGet('SELECT id, requires_attachment FROM compliance_requirements WHERE id=?', [requirement_id]);
    if (!req_row) return res.status(400).json({ error: 'Requirement not found' });
    const existing = dbGet(
      'SELECT id, attachment_filename FROM compliance_records WHERE employee_id=? AND requirement_id=?',
      [req.params.id, requirement_id]
    );
    // Enforce proof attachment: a requirement flagged requires_attachment cannot be
    // marked Compliant unless a file is already attached (and it isn't declined).
    if (req_row.requires_attachment && (status || 'compliant') === 'compliant' && !declined
        && !(existing && existing.attachment_filename)) {
      return res.status(400).json({ error: 'This requirement requires a proof attachment (image or PDF) before it can be marked Compliant.' });
    }
    if (existing) {
      dbRun(
        `UPDATE compliance_records SET
          status=?, completed_date=?, expiration_date=?, lot_number=?, administered_by=?,
          administration_site=?, notes=?, declined=?, declined_reason=?, declined_date=?,
          verified_by=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [status || 'compliant', completed_date || null, expiration_date || null,
         lot_number || null, administered_by || null, administration_site || null,
         notes || null, declined ? 1 : 0, declined_reason || null, declined_date || null,
         verified_by || null, existing.id]
      );
      audit(req, 'UPDATE_COMPLIANCE_RECORD', 'compliance_records', existing.id,
        { employee: `${emp.first_name} ${emp.last_name}`, requirement_id });
      res.json({ id: existing.id, success: true });
    } else {
      dbRun(
        `INSERT INTO compliance_records
          (employee_id, requirement_id, status, completed_date, expiration_date, lot_number,
           administered_by, administration_site, notes, declined, declined_reason, declined_date,
           verified_by, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, requirement_id, status || 'compliant', completed_date || null,
         expiration_date || null, lot_number || null, administered_by || null,
         administration_site || null, notes || null, declined ? 1 : 0,
         declined_reason || null, declined_date || null, verified_by || null, req.user.username]
      );
      const id = lastInsertId();
      audit(req, 'CREATE_COMPLIANCE_RECORD', 'compliance_records', id,
        { employee: `${emp.first_name} ${emp.last_name}`, requirement_id });
      res.status(201).json({ id, success: true });
    }
  }));

  app.put('/api/compliance/records/:id', auth, editorOrAbove, wrap((req, res) => {
    const rec = dbGet(
      `SELECT cr.id, cr.attachment_filename, req.requires_attachment
       FROM compliance_records cr JOIN compliance_requirements req ON cr.requirement_id = req.id
       WHERE cr.id=?`, [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    const {
      status, completed_date, expiration_date, lot_number, administered_by,
      administration_site, notes, declined, declined_reason, declined_date, verified_by
    } = req.body || {};
    if (rec.requires_attachment && (status || 'compliant') === 'compliant' && !declined && !rec.attachment_filename) {
      return res.status(400).json({ error: 'This requirement requires a proof attachment (image or PDF) before it can be marked Compliant.' });
    }
    dbRun(
      `UPDATE compliance_records SET
        status=?, completed_date=?, expiration_date=?, lot_number=?, administered_by=?,
        administration_site=?, notes=?, declined=?, declined_reason=?, declined_date=?,
        verified_by=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [status || 'compliant', completed_date || null, expiration_date || null,
       lot_number || null, administered_by || null, administration_site || null,
       notes || null, declined ? 1 : 0, declined_reason || null, declined_date || null,
       verified_by || null, req.params.id]
    );
    audit(req, 'UPDATE_COMPLIANCE_RECORD', 'compliance_records', Number(req.params.id));
    res.json({ success: true });
  }));

  app.get('/api/compliance/records/:id', auth, editorOrAbove, wrap((req, res) => {
    const rec = dbGet(
      `SELECT cr.*, req.name AS req_name, req.category AS req_category,
              req.frequency, req.frequency_months, req.can_decline,
              req.requires_attachment, req.applies_to,
              e.first_name, e.last_name, e.badge_number, e.position_om, e.position_ahca
       FROM compliance_records cr
       JOIN compliance_requirements req ON cr.requirement_id = req.id
       JOIN employees e ON cr.employee_id = e.id
       WHERE cr.id=?`,
      [req.params.id]
    );
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    res.json(rec);
  }));

  app.delete('/api/compliance/records/:id', auth, editorOrAbove, wrap((req, res) => {
    const rec = dbGet('SELECT id, attachment_filename FROM compliance_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    if (rec.attachment_filename) {
      const fp = path.join(config.UPLOAD_DIR, rec.attachment_filename);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
    dbRun('DELETE FROM compliance_records WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_COMPLIANCE_RECORD', 'compliance_records', Number(req.params.id));
    res.json({ success: true });
  }));

  /* ── RECORD ATTACHMENT — proof of compliance (image/PDF) ──── */

  app.post('/api/compliance/records/:id/attachment', auth, editorOrAbove,
    (req, res, next) => attachUpload.single('attachment')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
    wrap((req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const rec = dbGet('SELECT id, attachment_filename FROM compliance_records WHERE id=?', [req.params.id]);
      if (!rec) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Record not found' });
      }
      // Remove the previous attachment if one is being replaced
      if (rec.attachment_filename) {
        const oldPath = path.join(config.UPLOAD_DIR, rec.attachment_filename);
        if (rec.attachment_filename.startsWith(`comp_${req.params.id}_`) && fs.existsSync(oldPath)) {
          fs.unlink(oldPath, () => {});
        }
      }
      dbRun(
        'UPDATE compliance_records SET attachment_filename=?, attachment_original_name=?, attachment_uploaded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?',
        [req.file.filename, req.file.originalname, req.params.id]
      );
      audit(req, 'UPLOAD_COMPLIANCE_ATTACHMENT', 'compliance_records', Number(req.params.id),
        { file: req.file.originalname });
      res.json({ ok: true, attachment_filename: req.file.filename, attachment_original_name: req.file.originalname });
    }));

  app.get('/api/compliance/records/:id/attachment', auth, wrap((req, res) => {
    const rec = dbGet('SELECT attachment_filename, attachment_original_name FROM compliance_records WHERE id=?', [req.params.id]);
    if (!rec || !rec.attachment_filename) return res.status(404).json({ error: 'No attachment' });
    const filePath = path.join(config.UPLOAD_DIR, rec.attachment_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment missing from disk' });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  }));

  app.delete('/api/compliance/records/:id/attachment', auth, editorOrAbove, wrap((req, res) => {
    const rec = dbGet('SELECT id, attachment_filename FROM compliance_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    if (rec.attachment_filename) {
      const fp = path.join(config.UPLOAD_DIR, rec.attachment_filename);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
    dbRun('UPDATE compliance_records SET attachment_filename=NULL, attachment_original_name=NULL, attachment_uploaded_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [req.params.id]);
    audit(req, 'DELETE_COMPLIANCE_ATTACHMENT', 'compliance_records', Number(req.params.id));
    res.json({ ok: true });
  }));

  /* ── RECORDS — all (manager+) ─────────────────────────────── */

  app.get('/api/compliance/records', auth, editorOrAbove, wrap((req, res) => {
    const { category, status, search, expiring } = req.query;
    let sql = `SELECT cr.*, req.name AS req_name, req.category AS req_category,
                      req.frequency, req.can_decline, req.applies_to,
                      e.first_name, e.last_name, e.badge_number, e.position_om, e.position_ahca
               FROM compliance_records cr
               JOIN compliance_requirements req ON cr.requirement_id = req.id
               JOIN employees e ON cr.employee_id = e.id
               WHERE e.status='active'`;
    const p = [];
    if (category) { sql += ' AND req.category=?'; p.push(category); }
    if (status)   { sql += ' AND cr.status=?';    p.push(status); }
    if (search) {
      sql += ' AND (e.last_name LIKE ? OR e.first_name LIKE ? OR req.name LIKE ?)';
      p.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (expiring === '1') {
      const in60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
      sql += ' AND cr.expiration_date IS NOT NULL AND cr.expiration_date <= ? AND cr.status != ?';
      p.push(in60, 'declined');
    }
    sql += ' ORDER BY e.last_name, e.first_name, req.category, req.name LIMIT 1000';
    res.json(dbAll(sql, p).filter(r => appliesToEmployee(r, r)));
  }));

  /* ── DASHBOARD — org-wide compliance stats ────────────────── */

  app.get('/api/compliance/dashboard', auth, editorOrAbove, wrap((req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const in30  = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const in60  = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

    let totalRecs = 0;
    let compliant = 0;
    let expired = 0;
    let expiring30 = 0;
    let expiring60 = 0;
    let declined = 0;

    const employees  = dbAll("SELECT id, first_name, last_name, badge_number, position_om, position_ahca FROM employees WHERE status='active' ORDER BY last_name, first_name");
    const reqs       = dbAll('SELECT id, applies_to FROM compliance_requirements WHERE active=1');
    const records    = dbAll(
      `SELECT cr.employee_id, cr.requirement_id, cr.status, cr.expiration_date, cr.declined
       FROM compliance_records cr JOIN employees e ON cr.employee_id=e.id WHERE e.status='active'`
    );
    const recMap = {};
    for (const r of records) {
      if (!recMap[r.employee_id]) recMap[r.employee_id] = [];
      recMap[r.employee_id].push(r);
    }
    const empSummary = employees.map(e => {
      const recs = recMap[e.id] || [];
      const applicableReqs = reqs.filter(r => appliesToEmployee(r, e));
      const applicableIds = new Set(applicableReqs.map(r => r.id));
      const applicableRecs = recs.filter(r => applicableIds.has(r.requirement_id));
      totalRecs += applicableRecs.length;
      compliant += applicableRecs.filter(r => r.status === 'compliant').length;
      expired += applicableRecs.filter(r => !r.declined && r.expiration_date && r.expiration_date < today).length;
      expiring30 += applicableRecs.filter(r => !r.declined && r.expiration_date && r.expiration_date >= today && r.expiration_date <= in30).length;
      expiring60 += applicableRecs.filter(r => !r.declined && r.expiration_date && r.expiration_date >= today && r.expiration_date <= in60).length;
      declined += applicableRecs.filter(r => r.declined).length;
      const met    = applicableRecs.filter(r => r.declined || (r.status === 'compliant' && (!r.expiration_date || r.expiration_date >= today))).length;
      const expR   = applicableRecs.filter(r => !r.declined && r.expiration_date && r.expiration_date < today).length;
      const exp60R = applicableRecs.filter(r => !r.declined && r.expiration_date && r.expiration_date >= today && r.expiration_date <= in60).length;
      return { ...e, total_reqs: applicableReqs.length, met, expired: expR, expiring60: exp60R };
    });

    const totalReqs = empSummary.reduce((sum, e) => sum + e.total_reqs, 0);
    res.json({ totalReqs, totalRecs, compliant, expired, expiring30, expiring60, declined, employees: empSummary });
  }));
};
