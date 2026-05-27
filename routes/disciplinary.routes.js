'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');

const VALID_TYPES = [
  'verbal_warning', 'written_warning', 'final_warning',
  'pip', 'counseling', 'performance_review', 'commendation', 'termination_warning'
];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST for one employee ──────────────────────────────── */
  app.get('/api/employees/:id/disciplinary', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json(dbAll(
      'SELECT * FROM disciplinary_records WHERE employee_id=? ORDER BY incident_date DESC, id DESC',
      [req.params.id]
    ));
  });

  /* ── LIST all (manager+, for overview dashboard) ────────── */
  app.get('/api/disciplinary', auth, managerOrAdmin, (req, res) => {
    const { type, resolved, search } = req.query;
    let sql = `SELECT dr.*, e.first_name, e.last_name, e.badge_number, e.position_om
               FROM disciplinary_records dr JOIN employees e ON dr.employee_id=e.id WHERE 1=1`;
    const p = [];
    if (type)     { sql += ' AND dr.type=?'; p.push(type); }
    if (resolved !== undefined && resolved !== '') { sql += ' AND dr.resolved=?'; p.push(Number(resolved)); }
    if (search)   { sql += ' AND (e.last_name LIKE ? OR e.first_name LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY dr.incident_date DESC, dr.id DESC LIMIT 200';
    res.json(dbAll(sql, p));
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/employees/:id/disciplinary', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const { type, incident_date, description, action_taken, follow_up_date, follow_up_notes, witness, employee_acknowledged } = req.body;
    if (!type || !VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    if (!incident_date) return res.status(400).json({ error: 'incident_date is required' });
    if (!description)   return res.status(400).json({ error: 'description is required' });

    dbRun(
      `INSERT INTO disciplinary_records
        (employee_id, type, incident_date, description, action_taken, follow_up_date, follow_up_notes, witness, employee_acknowledged, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, type, incident_date, description,
       action_taken || null, follow_up_date || null, follow_up_notes || null,
       witness || null, employee_acknowledged ? 1 : 0, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'CREATE_DISCIPLINARY', 'disciplinary_records', id,
      { employee: `${emp.first_name} ${emp.last_name}`, type, incident_date });
    res.status(201).json({ id, success: true });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/disciplinary/:id', auth, editorOrAbove, (req, res) => {
    const rec = dbGet('SELECT * FROM disciplinary_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    const { type, incident_date, description, action_taken, follow_up_date, follow_up_notes,
            witness, employee_acknowledged, resolved, resolved_date } = req.body;
    dbRun(
      `UPDATE disciplinary_records SET
        type=?, incident_date=?, description=?, action_taken=?, follow_up_date=?,
        follow_up_notes=?, witness=?, employee_acknowledged=?, resolved=?, resolved_date=?,
        updated_at=?
       WHERE id=?`,
      [type || rec.type, incident_date || rec.incident_date, description || rec.description,
       action_taken ?? rec.action_taken, follow_up_date ?? rec.follow_up_date,
       follow_up_notes ?? rec.follow_up_notes, witness ?? rec.witness,
       employee_acknowledged !== undefined ? (employee_acknowledged ? 1 : 0) : rec.employee_acknowledged,
       resolved !== undefined ? (resolved ? 1 : 0) : rec.resolved,
       resolved_date ?? rec.resolved_date,
       new Date().toISOString(), req.params.id]
    );
    audit(req, 'UPDATE_DISCIPLINARY', 'disciplinary_records', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── DELETE (manager+) ──────────────────────────────────── */
  app.delete('/api/disciplinary/:id', auth, managerOrAdmin, (req, res) => {
    const rec = dbGet('SELECT * FROM disciplinary_records WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Record not found' });
    dbRun('DELETE FROM disciplinary_records WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_DISCIPLINARY', 'disciplinary_records', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── STATS ──────────────────────────────────────────────── */
  app.get('/api/disciplinary/stats', auth, managerOrAdmin, (req, res) => {
    const total    = dbGet("SELECT COUNT(*) as n FROM disciplinary_records").n;
    const open     = dbGet("SELECT COUNT(*) as n FROM disciplinary_records WHERE resolved=0").n;
    const followup = dbGet("SELECT COUNT(*) as n FROM disciplinary_records WHERE resolved=0 AND follow_up_date IS NOT NULL AND follow_up_date <= date('now')").n;
    const byType   = dbAll("SELECT type, COUNT(*) as n FROM disciplinary_records GROUP BY type ORDER BY n DESC");
    res.json({ total, open, followup, byType });
  });
};
