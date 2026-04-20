'use strict';
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { auth, editorOrAbove, adminOnly, audit } = require('../middleware/auth');
const config = require('../config');

const photoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `emp_${req.params.id}_${Date.now()}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits:  { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PNG, JPEG, and WebP images are allowed'), false);
  },
});

const EMP_FIELDS = [
  'status','last_name','first_name','employment_date','dob','gender',
  'phone','email','address',
  'position_ahca','position_om','employment_type','schedule_type','supervisor',
  'emergency_contact','emergency_contact_phone',
  'license_number','license_type','license_state','license_issue_date',
  'license_expiration','license_notes',
  'caqh','npi','taxonomy','medicare','medicaid',
  'dea','dea_expiration','dea_notes',
  'sunbiz_co','ein',
  'driver_license','driver_license_expiration','ssn',
  'ahca_background_expiration','ahca_notes',
  'professional_liability_expiration','liability_notes',
  'wc_exemption_number','wc_carrier','liability_carrier','liability_policy','liability_coverage',
  'board_cert','board_cert_number','board_cert_expiration',
  'supervising_physician','supervision_expiration',
  'caqh_attested','medicare_status','medicaid_status',
  'telehealth_states','hospital_privileges','hospital_privileges_expiration',
  'ceu_expiration','ceu_notes',
  'cpr_bls_expiration','cpr_notes',
  'passport_expiration',
  'e_verified','i9_expiration','i9_notes',
  'exemption_worker_comp_expiration',
  'yearly_evaluation_due',
  'rehired_date','termination_date','notes',
  'pay_type','pay_rate','pay_frequency'
];

const EXP_FIELDS = [
  ['license_expiration',                'License'],
  ['dea_expiration',                    'DEA'],
  ['driver_license_expiration',         'Driver License'],
  ['ahca_background_expiration',        'AHCA Background'],
  ['professional_liability_expiration', 'Prof. Liability'],
  ['ceu_expiration',                    'CEU'],
  ['cpr_bls_expiration',                'CPR/BLS'],
  ['passport_expiration',               'Passport'],
  ['i9_expiration',                     'I-9'],
  ['exemption_worker_comp_expiration',  'Worker Comp Exemption'],
  ['yearly_evaluation_due',             'Yearly Evaluation'],
];

function pickEmp(body) {
  const obj = {};
  EMP_FIELDS.forEach(k => { if (body[k] !== undefined) obj[k] = body[k] || null; });
  return obj;
}

function nextBadgeNumber(dbGet) {
  const row = dbGet(
    "SELECT MAX(CAST(SUBSTR(badge_number, 5) AS INTEGER)) AS n " +
    "FROM employees WHERE badge_number LIKE 'EMP-%'"
  );
  const next = (row?.n || 0) + 1;
  return `EMP-${String(next).padStart(4, '0')}`;
}

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST ────────────────────────────────────────────────── */
  app.get('/api/employees', auth, (req, res) => {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM employees WHERE 1=1';
    const p = [];
    if (status && status !== 'all') { sql += ' AND status=?'; p.push(status); }
    if (search) {
      const terms = search.split(',').map(t => t.trim()).filter(Boolean);
      for (const term of terms) {
        sql += ` AND (last_name LIKE ? OR first_name LIKE ? OR email LIKE ?
                 OR position_om LIKE ? OR position_ahca LIKE ? OR license_number LIKE ?
                 OR npi LIKE ? OR caqh LIKE ? OR phone LIKE ? OR dea LIKE ?)`;
        const s = `%${term}%`;
        p.push(s, s, s, s, s, s, s, s, s, s);
      }
    }
    sql += ' ORDER BY last_name, first_name';
    res.json(dbAll(sql, p));
  });

  /* ── GET ONE ────────────────────────────────────────────── */
  app.get('/api/employees/:id', auth, (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    res.json(e);
  });

  /* ── SSN ────────────────────────────────────────────────── */
  app.get('/api/employees/:id/ssn', auth, editorOrAbove, (req, res) => {
    const e = dbGet('SELECT ssn, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    audit(req, 'VIEW_SSN', 'employees', Number(req.params.id), { name: `${e.first_name} ${e.last_name}` });
    res.json({ ssn: e.ssn });
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/employees', auth, editorOrAbove, (req, res) => {
    const fields = pickEmp(req.body);
    if (!fields.last_name || !fields.first_name)
      return res.status(400).json({ error: 'First and last name are required' });
    fields.badge_number = nextBadgeNumber(dbGet);
    const cols = Object.keys(fields).join(',');
    const phs  = Object.keys(fields).map(() => '?').join(',');
    dbRun(`INSERT INTO employees (${cols}) VALUES (${phs})`, Object.values(fields));
    const id = lastInsertId();
    audit(req, 'CREATE_EMPLOYEE', 'employees', id,
      { name: `${fields.first_name} ${fields.last_name}`, badge_number: fields.badge_number });
    res.json({ success: true, id, badge_number: fields.badge_number });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/employees/:id', auth, editorOrAbove, (req, res) => {
    const fields = pickEmp(req.body);
    fields.updated_at = new Date().toISOString();
    const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
    dbRun(`UPDATE employees SET ${sets} WHERE id=?`, [...Object.values(fields), req.params.id]);
    audit(req, 'UPDATE_EMPLOYEE', 'employees', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── DELETE ─────────────────────────────────────────────── */
  app.delete('/api/employees/:id', auth, adminOnly, (req, res) => {
    const e = dbGet('SELECT first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    dbRun('DELETE FROM employees WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_EMPLOYEE', 'employees', Number(req.params.id), { name: `${e?.first_name} ${e?.last_name}` });
    res.json({ success: true });
  });

  /* ── PHOTO upload / serve / remove ──────────────────────── */
  app.post('/api/employees/:id/photo', auth, editorOrAbove,
    (req, res, next) => photoUpload.single('photo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
      const emp = dbGet('SELECT id, photo_url FROM employees WHERE id=?', [req.params.id]);
      if (!emp) {
        fs.unlink(req.file.path, () => {});
        return res.status(404).json({ error: 'Employee not found' });
      }
      if (emp.photo_url) {
        const oldName = emp.photo_url.split('/').pop();
        const oldPath = path.join(config.UPLOAD_DIR, oldName);
        if (oldName && oldName.startsWith(`emp_${req.params.id}_`) && fs.existsSync(oldPath)) {
          fs.unlink(oldPath, () => {});
        }
      }
      dbRun('UPDATE employees SET photo_url=?, updated_at=? WHERE id=?',
        [req.file.filename, new Date().toISOString(), req.params.id]);
      audit(req, 'UPLOAD_EMPLOYEE_PHOTO', 'employees', Number(req.params.id),
        { file: req.file.originalname });
      res.json({ ok: true, photo_url: req.file.filename });
    });

  app.get('/api/employees/:id/photo', auth, (req, res) => {
    const emp = dbGet('SELECT photo_url FROM employees WHERE id=?', [req.params.id]);
    if (!emp || !emp.photo_url) return res.status(404).json({ error: 'No photo' });
    const filePath = path.join(config.UPLOAD_DIR, emp.photo_url);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Photo missing from disk' });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  });

  app.delete('/api/employees/:id/photo', auth, editorOrAbove, (req, res) => {
    const emp = dbGet('SELECT photo_url FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    if (emp.photo_url) {
      const filePath = path.join(config.UPLOAD_DIR, emp.photo_url);
      if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
    }
    dbRun('UPDATE employees SET photo_url=NULL, updated_at=? WHERE id=?',
      [new Date().toISOString(), req.params.id]);
    audit(req, 'DELETE_EMPLOYEE_PHOTO', 'employees', Number(req.params.id));
    res.json({ ok: true });
  });

  /* ── DISCHARGE / REACTIVATE ─────────────────────────────── */
  app.put('/api/employees/:id/discharge', auth, editorOrAbove, (req, res) => {
    const date = req.body.termination_date || new Date().toISOString().split('T')[0];
    const e = dbGet('SELECT first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    dbRun("UPDATE employees SET status='discharged',termination_date=?,updated_at=? WHERE id=?",
      [date, new Date().toISOString(), req.params.id]);
    audit(req, 'DISCHARGE_EMPLOYEE', 'employees', Number(req.params.id),
      { name: `${e?.first_name} ${e?.last_name}`, termination_date: date });
    res.json({ success: true });
  });

  app.put('/api/employees/:id/reactivate', auth, editorOrAbove, (req, res) => {
    const date = req.body.rehired_date || new Date().toISOString().split('T')[0];
    const e = dbGet('SELECT first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    dbRun("UPDATE employees SET status='active',rehired_date=?,termination_date=NULL,updated_at=? WHERE id=?",
      [date, new Date().toISOString(), req.params.id]);
    audit(req, 'REACTIVATE_EMPLOYEE', 'employees', Number(req.params.id),
      { name: `${e?.first_name} ${e?.last_name}`, rehired_date: date });
    res.json({ success: true });
  });

  /* ── STATS ──────────────────────────────────────────────── */
  app.get('/api/stats', auth, (req, res) => {
    const total      = dbGet('SELECT COUNT(*) as n FROM employees').n;
    const active     = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='active'").n;
    const discharged = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='discharged'").n;

    const today = new Date().toISOString().split('T')[0];
    const in30  = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const in60  = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

    const clause30 = EXP_FIELDS.map(([f]) => `(${f} IS NOT NULL AND ${f}!='' AND ${f}<=? AND ${f}>=?)`).join(' OR ');
    const clause60 = EXP_FIELDS.map(([f]) => `(${f} IS NOT NULL AND ${f}!='' AND ${f}<=?)`).join(' OR ');

    const expiring30 = dbGet(
      `SELECT COUNT(*) as n FROM employees WHERE status='active' AND (${clause30})`,
      EXP_FIELDS.flatMap(() => [in30, today])
    ).n;

    const expiring60 = dbGet(
      `SELECT COUNT(*) as n FROM employees WHERE status='active' AND (${clause60})`,
      EXP_FIELDS.map(() => in60)
    ).n;

    // Next 8 expiring credentials
    const allActive = dbAll("SELECT * FROM employees WHERE status='active'");
    const alerts = [];
    for (const emp of allActive) {
      for (const [field, label] of EXP_FIELDS) {
        const d = emp[field];
        if (!d || d === '') continue;
        const days = Math.ceil((new Date(d) - new Date(today)) / 86400000);
        if (days <= 60) {
          alerts.push({ id: emp.id, name: `${emp.last_name}, ${emp.first_name}`,
                        field, label, date: d, days });
        }
      }
    }
    alerts.sort((a, b) => a.days - b.days);
    res.json({ total, active, discharged, expiring30, expiring60, next_expiring: alerts.slice(0, 8) });
  });
};
