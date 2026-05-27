'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');
const { generateIncidentNumber } = require('../db');

const VALID_TYPES   = ['workplace_injury','near_miss','patient_complaint','property_damage','security','medication_error','fall','exposure','other'];
const VALID_STATUSES = ['open','under_review','closed'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST ────────────────────────────────────────────────── */
  app.get('/api/incidents', auth, editorOrAbove, (req, res) => {
    const { status, type, osha, search } = req.query;
    let sql = 'SELECT * FROM incident_reports WHERE 1=1';
    const p = [];
    if (status) { sql += ' AND status=?'; p.push(status); }
    if (type)   { sql += ' AND type=?'; p.push(type); }
    if (osha === '1') { sql += ' AND osha_recordable=1'; }
    if (search) { sql += ' AND (description LIKE ? OR report_number LIKE ? OR location LIKE ?)'; p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    sql += ' ORDER BY incident_date DESC, id DESC LIMIT 500';
    const incidents = dbAll(sql, p);
    // Attach involved for each
    for (const inc of incidents) {
      inc.involved = dbAll('SELECT * FROM incident_involved WHERE incident_id=?', [inc.id]);
    }
    res.json(incidents);
  });

  /* ── GET ONE ─────────────────────────────────────────────── */
  app.get('/api/incidents/:id', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT * FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    inc.involved = dbAll('SELECT * FROM incident_involved WHERE incident_id=?', [inc.id]);
    res.json(inc);
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/incidents', auth, editorOrAbove, (req, res) => {
    const { report_date, incident_date, incident_time, location, type, description,
            immediate_action, osha_recordable, days_away, days_restricted, involved } = req.body;
    if (!incident_date) return res.status(400).json({ error: 'incident_date is required' });
    if (!type || !VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    if (!description) return res.status(400).json({ error: 'description is required' });

    const report_number = generateIncidentNumber(dbGet);
    const rDate = report_date || new Date().toISOString().split('T')[0];

    dbRun(
      `INSERT INTO incident_reports
        (report_number, report_date, incident_date, incident_time, location, type, description,
         immediate_action, osha_recordable, days_away, days_restricted, reported_by, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [report_number, rDate, incident_date, incident_time || null, location || null,
       type, description, immediate_action || null,
       osha_recordable ? 1 : 0, days_away ? Number(days_away) : 0,
       days_restricted ? Number(days_restricted) : 0,
       req.user.username, req.user.username]
    );
    const id = lastInsertId();

    // Insert involved parties
    if (Array.isArray(involved)) {
      for (const p of involved) {
        dbRun(
          'INSERT INTO incident_involved (incident_id, employee_id, employee_name, role) VALUES (?,?,?,?)',
          [id, p.employee_id || null, p.employee_name || null, p.role || null]
        );
      }
    }

    audit(req, 'CREATE_INCIDENT', 'incident_reports', id,
      { report_number, type, incident_date });
    res.status(201).json({ id, report_number, success: true });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/incidents/:id', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT * FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const { incident_date, incident_time, location, type, description, immediate_action,
            osha_recordable, osha_case_number, days_away, days_restricted,
            root_cause, corrective_action, status, reviewed_by, involved } = req.body;

    const newStatus = status || inc.status;
    const reviewedAt = reviewed_by && inc.reviewed_by !== reviewed_by ? new Date().toISOString() : inc.reviewed_at;
    const closedAt   = newStatus === 'closed' && inc.status !== 'closed' ? new Date().toISOString() : inc.closed_at;

    dbRun(
      `UPDATE incident_reports SET
        incident_date=?, incident_time=?, location=?, type=?, description=?,
        immediate_action=?, osha_recordable=?, osha_case_number=?,
        days_away=?, days_restricted=?, root_cause=?, corrective_action=?,
        status=?, reviewed_by=?, reviewed_at=?, closed_at=?, updated_at=?
       WHERE id=?`,
      [incident_date || inc.incident_date, incident_time ?? inc.incident_time,
       location ?? inc.location, type || inc.type, description || inc.description,
       immediate_action ?? inc.immediate_action,
       osha_recordable !== undefined ? (osha_recordable ? 1 : 0) : inc.osha_recordable,
       osha_case_number ?? inc.osha_case_number,
       days_away !== undefined ? Number(days_away) : inc.days_away,
       days_restricted !== undefined ? Number(days_restricted) : inc.days_restricted,
       root_cause ?? inc.root_cause, corrective_action ?? inc.corrective_action,
       newStatus, reviewed_by ?? inc.reviewed_by, reviewedAt, closedAt,
       new Date().toISOString(), req.params.id]
    );

    // Replace involved
    if (Array.isArray(involved)) {
      dbRun('DELETE FROM incident_involved WHERE incident_id=?', [req.params.id]);
      for (const p of involved) {
        dbRun(
          'INSERT INTO incident_involved (incident_id, employee_id, employee_name, role) VALUES (?,?,?,?)',
          [req.params.id, p.employee_id || null, p.employee_name || null, p.role || null]
        );
      }
    }

    audit(req, 'UPDATE_INCIDENT', 'incident_reports', Number(req.params.id), { status: newStatus });
    res.json({ success: true });
  });

  /* ── DELETE (manager+) ──────────────────────────────────── */
  app.delete('/api/incidents/:id', auth, managerOrAdmin, (req, res) => {
    const inc = dbGet('SELECT id, report_number FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    dbRun('DELETE FROM incident_reports WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_INCIDENT', 'incident_reports', Number(req.params.id), { report_number: inc.report_number });
    res.json({ success: true });
  });

  /* ── STATS ───────────────────────────────────────────────── */
  app.get('/api/incidents/stats', auth, editorOrAbove, (req, res) => {
    const total     = dbGet("SELECT COUNT(*) as n FROM incident_reports").n;
    const open      = dbGet("SELECT COUNT(*) as n FROM incident_reports WHERE status='open'").n;
    const osha      = dbGet("SELECT COUNT(*) as n FROM incident_reports WHERE osha_recordable=1").n;
    const ytd       = dbGet(`SELECT COUNT(*) as n FROM incident_reports WHERE incident_date >= date('now','start of year')`).n;
    const byType    = dbAll("SELECT type, COUNT(*) as n FROM incident_reports GROUP BY type ORDER BY n DESC");
    res.json({ total, open, osha, ytd, byType });
  });
};
