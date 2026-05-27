'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');

const VALID_MODALITIES = ['in_person', 'telehealth', 'group', 'phone', 'other'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST for one supervisee ────────────────────────────── */
  app.get('/api/employees/:id/supervision', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const logs = dbAll(
      'SELECT sl.*, e.first_name AS sup_first, e.last_name AS sup_last FROM supervision_logs sl LEFT JOIN employees e ON sl.supervisor_id=e.id WHERE sl.supervisee_id=? ORDER BY sl.session_date DESC',
      [req.params.id]
    );
    // Cumulative hours
    const total_minutes = logs.reduce((s, l) => s + (l.duration_minutes || 0), 0);
    res.json({ logs, total_hours: +(total_minutes / 60).toFixed(2) });
  });

  /* ── LIST all (manager+) ────────────────────────────────── */
  app.get('/api/supervision', auth, managerOrAdmin, (req, res) => {
    const { supervisee_id, supervisor_id } = req.query;
    let sql = `SELECT sl.*,
                 sv.first_name AS supervisee_first, sv.last_name AS supervisee_last,
                 sp.first_name AS supervisor_first, sp.last_name AS supervisor_last
               FROM supervision_logs sl
               JOIN employees sv ON sl.supervisee_id=sv.id
               LEFT JOIN employees sp ON sl.supervisor_id=sp.id
               WHERE 1=1`;
    const p = [];
    if (supervisee_id) { sql += ' AND sl.supervisee_id=?'; p.push(supervisee_id); }
    if (supervisor_id) { sql += ' AND sl.supervisor_id=?'; p.push(supervisor_id); }
    sql += ' ORDER BY sl.session_date DESC LIMIT 500';
    res.json(dbAll(sql, p));
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/employees/:id/supervision', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const { supervisor_id, supervisor_name, session_date, duration_minutes, modality, topics, client_cases_reviewed, notes } = req.body;
    if (!session_date) return res.status(400).json({ error: 'session_date is required' });

    let supName = supervisor_name || null;
    if (supervisor_id) {
      const sup = dbGet('SELECT first_name, last_name FROM employees WHERE id=?', [supervisor_id]);
      if (sup) supName = `${sup.first_name} ${sup.last_name}`;
    }

    dbRun(
      `INSERT INTO supervision_logs
        (supervisee_id, supervisor_id, supervisor_name, session_date, duration_minutes, modality, topics, client_cases_reviewed, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, supervisor_id || null, supName,
       session_date, duration_minutes ? Number(duration_minutes) : null,
       modality || null, topics || null, client_cases_reviewed || null,
       notes || null, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'CREATE_SUPERVISION_LOG', 'supervision_logs', id,
      { supervisee: `${emp.first_name} ${emp.last_name}`, session_date });
    res.status(201).json({ id, success: true });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/supervision/:id', auth, editorOrAbove, (req, res) => {
    const rec = dbGet('SELECT id FROM supervision_logs WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Log entry not found' });
    const { supervisor_id, supervisor_name, session_date, duration_minutes, modality, topics, client_cases_reviewed, notes } = req.body;
    dbRun(
      `UPDATE supervision_logs SET supervisor_id=?, supervisor_name=?, session_date=?,
        duration_minutes=?, modality=?, topics=?, client_cases_reviewed=?, notes=? WHERE id=?`,
      [supervisor_id || null, supervisor_name || null, session_date,
       duration_minutes ? Number(duration_minutes) : null, modality || null,
       topics || null, client_cases_reviewed || null, notes || null, req.params.id]
    );
    audit(req, 'UPDATE_SUPERVISION_LOG', 'supervision_logs', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── DELETE ─────────────────────────────────────────────── */
  app.delete('/api/supervision/:id', auth, editorOrAbove, (req, res) => {
    const rec = dbGet('SELECT id FROM supervision_logs WHERE id=?', [req.params.id]);
    if (!rec) return res.status(404).json({ error: 'Log entry not found' });
    dbRun('DELETE FROM supervision_logs WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_SUPERVISION_LOG', 'supervision_logs', Number(req.params.id));
    res.json({ success: true });
  });
};
