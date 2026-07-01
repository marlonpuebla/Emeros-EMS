'use strict';
const XLSX         = require('xlsx');
const { execFile } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const multer       = require('multer');
const config       = require('../config');
const { auth, editorOrAbove, adminOnly, audit } = require('../middleware/auth');

// Preserve the uploaded file's extension — openpyxl 3.1 validates by file
// suffix, not magic bytes, so a stripped extension triggers InvalidFileException.
const importStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.xlsx').toLowerCase();
    cb(null, `import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const upload = multer({ storage: importStorage });

function runPython(args) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '..', 'generate_report.py');
    execFile('python3', [script, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error('Report script error: ' + stdout.trim())); }
    });
  });
}

function sendPdf(res, outPath, filename) {
  try {
    const buf = fs.readFileSync(outPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
    fs.unlink(outPath, () => {});
  } catch (e) {
    if (!res.headersSent)
      res.status(500).json({ error: 'Could not read generated PDF: ' + e.message });
  }
}

module.exports = function (app) {
  const { dbAll, dbGet, dbRun } = app.locals;

  /* ── Excel export ───────────────────────────────────────── */
  app.get('/api/export/excel', auth, editorOrAbove, (req, res) => {
    const { status } = req.query;
    let sql = 'SELECT * FROM employees WHERE 1=1';
    const p = [];
    if (status && status !== 'all') { sql += ' AND status=?'; p.push(status); }
    sql += ' ORDER BY last_name, first_name';
    const emps = dbAll(sql, p);

    const header = [
      'STATUS','LAST NAME','FIRST NAME','EMPLOYMENT DATE','DOB','GENDER',
      'PHONE','EMAIL','ADDRESS','POSITION (AHCA)','POSITION',
      'EMPLOYMENT TYPE','SCHEDULE','SUPERVISOR',
      'EMERGENCY CONTACT','EC PHONE',
      'LICENSE #','LICENSE TYPE','LICENSE STATE','LICENSE ISSUE DATE','LICENSE EXP','LICENSE NOTES',
      'CAQH#','NPI','TAXONOMY','MEDICARE','MEDICAID',
      'DEA #','DEA EXP','DEA NOTES','SUNBIZ CO','EIN',
      'DRIVER LICENSE','DRIVER LICENSE EXP','SSN',
      'AHCA BG EXP','AHCA NOTES','PROF LIABILITY EXP','LIABILITY NOTES',
      'CEU EXP','CEU NOTES','CPR/BLS EXP','CPR NOTES','PASSPORT EXP',
      'E-VERIFIED','I9 EXP','I9 NOTES','WORKER COMP EXEMP EXP',
      'YEARLY EVAL DUE','REHIRED DATE','TERMINATION DATE','NOTES'
    ];

    const rows = emps.map(e => [
      (e.status||'').toUpperCase(), e.last_name, e.first_name,
      e.employment_date, e.dob, e.gender, e.phone, e.email, e.address,
      e.position_ahca, e.position_om, e.employment_type, e.schedule_type, e.supervisor,
      e.emergency_contact, e.emergency_contact_phone,
      e.license_number, e.license_type, e.license_state, e.license_issue_date, e.license_expiration, e.license_notes,
      e.caqh, e.npi, e.taxonomy, e.medicare, e.medicaid,
      e.dea, e.dea_expiration, e.dea_notes, e.sunbiz_co, e.ein,
      e.driver_license, e.driver_license_expiration, e.ssn,
      e.ahca_background_expiration, e.ahca_notes,
      e.professional_liability_expiration, e.liability_notes,
      e.ceu_expiration, e.ceu_notes, e.cpr_bls_expiration, e.cpr_notes,
      e.passport_expiration, e.e_verified, e.i9_expiration, e.i9_notes,
      e.exemption_worker_comp_expiration, e.yearly_evaluation_due,
      e.rehired_date, e.termination_date, e.notes
    ]);

    const ws  = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb  = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'EMPLOYEES');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const tag = status && status !== 'all' ? `_${status}` : '';
    const dt  = new Date().toISOString().slice(0, 10);
    audit(req, 'EXPORT_EXCEL', 'employees', null, { status, count: emps.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="EMS_Roster${tag}_${dt}.xlsx"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  });

  /* ── PDF reports ────────────────────────────────────────── */
  app.get('/api/reports/monthly-roster', auth, async (req, res) => {
    const month   = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const year    = parseInt(req.query.year)  || new Date().getFullYear();
    const outPath = path.join(os.tmpdir(), `ems_roster_${Date.now()}.pdf`);
    try {
      const r = await runPython(['monthly_roster', outPath, String(month), String(year)]);
      if (r.error) return res.status(500).json({ error: r.error });
      audit(req, 'REPORT_MONTHLY_ROSTER', null, null, { month, year, count: r.count });
      sendPdf(res, outPath, `Monthly_Roster_${year}_${String(month).padStart(2,'0')}.pdf`);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  app.get('/api/reports/new-hires', auth, async (req, res) => {
    const month   = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const year    = parseInt(req.query.year)  || new Date().getFullYear();
    const outPath = path.join(os.tmpdir(), `ems_newhires_${Date.now()}.pdf`);
    try {
      const r = await runPython(['new_hires', outPath, String(month), String(year)]);
      if (r.error) return res.status(500).json({ error: r.error });
      audit(req, 'REPORT_NEW_HIRES', null, null, { month, year, count: r.count });
      sendPdf(res, outPath, `New_Hires_${year}_${String(month).padStart(2,'0')}.pdf`);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  app.get('/api/reports/license-verification', auth, async (req, res) => {
    const outPath = path.join(os.tmpdir(), `ems_license_${Date.now()}.pdf`);
    try {
      const r = await runPython(['license_verification', outPath]);
      if (r.error) return res.status(500).json({ error: r.error });
      audit(req, 'REPORT_LICENSE', null, null, { count: r.count });
      sendPdf(res, outPath, `License_Verification_${new Date().toISOString().slice(0,10)}.pdf`);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  app.get('/api/reports/fingerprinting', auth, async (req, res) => {
    const includeAll = req.query.include_discharged !== 'false';
    const outPath    = path.join(os.tmpdir(), `ems_fp_${Date.now()}.pdf`);
    try {
      const r = await runPython(['fingerprinting', outPath, String(includeAll)]);
      if (r.error) return res.status(500).json({ error: r.error });
      audit(req, 'REPORT_FINGERPRINTING', null, null, { includeAll, count: r.count });
      sendPdf(res, outPath, `Fingerprinting_Roster_${new Date().toISOString().slice(0,10)}.pdf`);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  /* ── Excel import ───────────────────────────────────────── */
  app.post('/api/import/excel', auth, adminOnly, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const importScript = path.join(__dirname, '..', 'import_excel.py');
    execFile('python3', [importScript, req.file.path, config.DB_PATH],
      { timeout: 60000 }, (err, stdout, stderr) => {
        fs.unlink(req.file.path, () => {});
        if (err) return res.status(500).json({ error: (stderr || err.message).trim() });
        try {
          const result = JSON.parse(stdout.trim());
          // Python wrote directly to the SQLite file; reload the in-memory DB
          // before the next dbRun (inside audit) overwrites it.
          app.locals.reloadDb();
          audit(req, 'IMPORT_EXCEL', null, null, result);
          res.json(result);
        } catch { res.status(500).json({ error: 'Import error: ' + stdout.trim() }); }
      });
  });
};
