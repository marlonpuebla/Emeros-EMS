'use strict';
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { auth, editorOrAbove, audit } = require('../middleware/auth');
const config = require('../config');

const DOC_TYPES = [
  'Identification Card','Social Security Card','Professional Liability',
  'Certification & Diploma','E-Verify','Passport / Resident Card / Work Permit',
  'I-9 Form','Medicare Letter','Medicaid Letter','Other Certifications',
  'DEA Card','Educational Diploma','Application Letter',
  'AHCA Background Check','Other Background Check','Drug Panel',
  'Vaccination Card & Waiver','TB & HepB Denial Form','Other Medical Forms',
  'Employee Evaluation','Other',
];

const docStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const safe = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safe);
  },
});
const docUpload = multer({
  storage: docStorage,
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png', 'image/jpeg', 'image/jpg',
    ];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF, Word, PNG, and JPEG files are allowed'), false);
  },
});

module.exports = function (app) {
  const { dbAll, dbGet, dbRun } = app.locals;

  app.get('/api/doc-types', auth, (_req, res) => res.json(DOC_TYPES));

  app.get('/api/employees/:id/documents', auth, (req, res) => {
    res.json(dbAll('SELECT * FROM employee_documents WHERE employee_id=? ORDER BY uploaded_at DESC', [req.params.id]));
  });

  app.get('/api/employees/:id/documents/file/:filename', auth, (req, res) => {
    const doc = dbGet('SELECT * FROM employee_documents WHERE filename=? AND employee_id=?',
      [req.params.filename, req.params.id]);
    if (!doc) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(config.UPLOAD_DIR, doc.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.original_name)}"`);
    res.setHeader('Content-Type', doc.mime_type);
    res.sendFile(filePath);
  });

  app.post('/api/employees/:id/documents', auth, editorOrAbove,
    (req, res, next) => docUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { doc_type, notes } = req.body;
      if (!doc_type || !DOC_TYPES.includes(doc_type))
        return res.status(400).json({ error: 'Invalid document type' });
      const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
      if (!emp) return res.status(404).json({ error: 'Employee not found' });
      dbRun(`INSERT INTO employee_documents
        (employee_id, doc_type, filename, original_name, mime_type, size_bytes, uploaded_by, notes)
        VALUES (?,?,?,?,?,?,?,?)`,
        [req.params.id, doc_type, req.file.filename, req.file.originalname,
         req.file.mimetype, req.file.size, req.user?.username || 'unknown', notes || null]);
      audit(req, 'UPLOAD_DOCUMENT', 'employees', Number(req.params.id),
        { doc_type, file: req.file.originalname });
      res.json({ ok: true, doc_type, filename: req.file.filename });
    }
  );

  app.delete('/api/employees/:id/documents/:docId', auth, editorOrAbove, (req, res) => {
    const doc = dbGet('SELECT * FROM employee_documents WHERE id=? AND employee_id=?',
      [req.params.docId, req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    fs.unlink(path.join(config.UPLOAD_DIR, doc.filename), () => {});
    dbRun('DELETE FROM employee_documents WHERE id=?', [doc.id]);
    audit(req, 'DELETE_DOCUMENT', 'employees', Number(req.params.id),
      { doc_type: doc.doc_type, file: doc.original_name });
    res.json({ ok: true });
  });
};
