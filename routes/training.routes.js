'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');

const VALID_CATEGORIES = ['required', 'ceu', 'certification', 'safety', 'compliance', 'hipaa', 'clinical', 'other'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST for one employee ──────────────────────────────── */
  app.get('/api/employees/:id/training', auth, (req, res) => {
    const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json(dbAll(
      'SELECT * FROM training_records WHERE employee_id=? ORDER BY completion_date DESC, id DESC',
      [req.params.id]
    ));
  });

  /* ── LIST all (manager+) ────────────────────────────────── */
  app.get('/api/training', auth, managerOrAdmin, (req, res) => {
    const { category, expiring, search } = req.query;
    let sql = `SELECT tr.*, e.first_name, e.last_name, e.badge_number
               FROM training_records tr JOIN employees e ON tr.employee_id=e.id
               JOIN employees es ON es.id=tr.employee_id WHERE es.status='active'`;
    const p = [];
    if (category) { sql += ' AND tr.category=?'; p.push(category); }
    if (expiring === '1') {
      const in60 = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];
      sql += ' AND tr.expiration_date IS NOT NULL AND tr.expiration_date <= ?'; p.push(in60);
    }
    if (search) { sql += ' AND (e.last_name LIKE ? OR e.first_name LIKE ? OR tr.training_name LIKE ?)'; p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    sql += ' ORDER BY tr.completion_date DESC LIMIT 500';
    res.json(dbAll(sql, p));
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/employees/:id/training', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const { training_name, category, provider, completion_date, expiration_date, hours, certificate_number, notes } = req.body;
    if (!training_name)   return res.status(400).json({ error: 'training_name is required' });
    if (!completion_date) return res.status(400).json({ error: 'completion_date is required' });
    dbRun(
      `INSERT INTO training_records
        (employee_id, training_name, category, provider, completion_date, expiration_date, hours, certificate_number, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, training_name, category || null, provider || null,
       completion_date, expiration_date || null, hours ? Number(hours) : null,
       certificate_number || null, notes || null, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'CREATE_TRAINING', 'training_records', id,
      { employee: `${emp.first_name} ${emp.last_name}`, training_name, completion_date });
    res.status(201).json({ id, success: true });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/training/:id', auth, editorOrAbove, (req, res) => {
    const rec = dbGet('SELECT id FROM training_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Training record not found' });
    const { training_name, category, provider, completion_date, expiration_date, hours, certificate_number, notes } = req.body;
    dbRun(
      `UPDATE training_records SET
        training_name=?, category=?, provider=?, completion_date=?, expiration_date=?,
        hours=?, certificate_number=?, notes=?
       WHERE id=?`,
      [training_name, category || null, provider || null, completion_date,
       expiration_date || null, hours ? Number(hours) : null,
       certificate_number || null, notes || null, req.params.id]
    );
    audit(req, 'UPDATE_TRAINING', 'training_records', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── DELETE ─────────────────────────────────────────────── */
  app.delete('/api/training/:id', auth, editorOrAbove, (req, res) => {
    const rec = dbGet('SELECT id FROM training_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Training record not found' });
    dbRun('DELETE FROM training_records WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_TRAINING', 'training_records', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── MATRIX — all active employees × required trainings ─── */
  app.get('/api/training/matrix', auth, managerOrAdmin, (req, res) => {
    const employees = dbAll("SELECT id, first_name, last_name, badge_number, position_om FROM employees WHERE status='active' ORDER BY last_name, first_name");
    const training  = dbAll("SELECT employee_id, training_name, completion_date, expiration_date FROM training_records ORDER BY completion_date DESC");
    // Group training by employee
    const map = {};
    for (const t of training) {
      if (!map[t.employee_id]) map[t.employee_id] = [];
      map[t.employee_id].push(t);
    }
    res.json(employees.map(e => ({ ...e, training: map[e.id] || [] })));
  });
};
