'use strict';
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const initSqlJs = require('sql.js');
const bcrypt   = require('bcryptjs');
const { DATA_DIR, DB_PATH, UPLOAD_DIR } = require('./config');

/* ─── Token generator ─────────────────────────────────────────
   Produces a 128-bit cryptographically random access token for
   use as barcode/QR payload on physical ID badges.
   Format: EMS-<32 uppercase hex chars>
   Example: EMS-A3F2B8C9D1E4F7A28B4C6D9E0F1A2B3C
   Never sequential, never guessable, revokable per-employee.
─────────────────────────────────────────────────────────────── */
function generateAccessToken() {
  return 'EMS-' + crypto.randomBytes(16).toString('hex').toUpperCase();
}

let db = null;
let SQL = null;

/* ─── Helpers ─────────────────────────────────────────────── */
function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// Reload the DB from disk into the in-memory instance. Required after any
// external writer (e.g. a Python script called via execFile) modifies the
// file directly; otherwise the next saveDb() overwrites their changes.
function reloadDb() {
  if (!SQL) throw new Error('DB not initialized — cannot reload');
  if (db) { try { db.close(); } catch (_) { /* ignore */ } }
  db = new SQL.Database(fs.readFileSync(DB_PATH));
}

function dbAll(sql, params = []) {
  const result = db.exec(sql, params);
  if (!result.length) return [];
  const { columns, values } = result[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function lastInsertId() {
  return db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
}

/* ─── Init ────────────────────────────────────────────────── */
async function initDb() {
  if (!fs.existsSync(DATA_DIR))  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  SQL = await initSqlJs();

  // Startup backup
  if (fs.existsSync(DB_PATH)) {
    const ts = new Date().toISOString().slice(0, 10);
    const backups = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('ems_backup_') && f.endsWith('.db')).sort();
    const todaysBackup = path.join(DATA_DIR, `ems_backup_${ts}.db`);
    if (!fs.existsSync(todaysBackup)) {
      fs.copyFileSync(DB_PATH, todaysBackup);
      console.log(`[db] Backup: ems_backup_${ts}.db`);
    }
    if (backups.length > 30) {
      backups.slice(0, backups.length - 30).forEach(f =>
        fs.unlinkSync(path.join(DATA_DIR, f)));
    }
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  /* ── WAL mode for better write concurrency ──────────────── */
  try { db.run('PRAGMA journal_mode=WAL'); } catch (_) {}

  /* ── Tables ─────────────────────────────────────────────── */
  dbRun(`CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    role       TEXT DEFAULT 'viewer',
    display_name TEXT,
    active     INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT DEFAULT 'active',
    last_name TEXT NOT NULL, first_name TEXT NOT NULL,
    employment_date TEXT, dob TEXT, gender TEXT, phone TEXT, email TEXT,
    address TEXT, position_ahca TEXT, position_om TEXT,
    employment_type TEXT DEFAULT 'employee',
    schedule_type TEXT DEFAULT 'full-time',
    supervisor TEXT,
    emergency_contact TEXT, emergency_contact_phone TEXT,
    license_number TEXT, license_type TEXT, license_state TEXT,
    license_issue_date TEXT, license_expiration TEXT, license_notes TEXT,
    caqh TEXT, npi TEXT, taxonomy TEXT, medicare TEXT, medicaid TEXT,
    dea TEXT, dea_expiration TEXT, dea_notes TEXT,
    sunbiz_co TEXT, ein TEXT,
    driver_license TEXT, driver_license_expiration TEXT, ssn TEXT,
    ahca_background_expiration TEXT, ahca_notes TEXT,
    professional_liability_expiration TEXT, liability_notes TEXT,
    ceu_expiration TEXT, ceu_notes TEXT,
    cpr_bls_expiration TEXT, cpr_notes TEXT,
    passport_expiration TEXT,
    e_verified TEXT, i9_expiration TEXT, i9_notes TEXT,
    exemption_worker_comp_expiration TEXT,
    yearly_evaluation_due TEXT,
    rehired_date TEXT, termination_date TEXT, notes TEXT,
    wc_exemption_number TEXT, wc_carrier TEXT,
    liability_carrier TEXT, liability_policy TEXT, liability_coverage TEXT,
    board_cert TEXT, board_cert_number TEXT, board_cert_expiration TEXT,
    supervising_physician TEXT, supervision_expiration TEXT,
    caqh_attested TEXT, medicare_status TEXT, medicaid_status TEXT,
    telehealth_states TEXT, hospital_privileges TEXT, hospital_privileges_expiration TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id   INTEGER, username TEXT,
    action    TEXT NOT NULL,
    entity    TEXT, entity_id INTEGER, detail TEXT, ip TEXT
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS token_blacklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    jti        TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    ts         DATETIME DEFAULT CURRENT_TIMESTAMP,
    success    INTEGER DEFAULT 0
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS employee_documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    doc_type    TEXT NOT NULL,
    filename    TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER DEFAULT 0,
    uploaded_by TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes       TEXT
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS job_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    department TEXT,
    location TEXT,
    employment_type TEXT DEFAULT 'full-time',
    salary_min REAL,
    salary_max REAL,
    salary_type TEXT DEFAULT 'yearly',
    description TEXT,
    requirements TEXT,
    status TEXT DEFAULT 'open',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_posting_id INTEGER REFERENCES job_postings(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    resume_text TEXT,
    source TEXT DEFAULT 'indeed',
    indeed_job_id TEXT,
    stage TEXT DEFAULT 'applied',
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    hired_at DATETIME,
    rejected_at DATETIME,
    employee_id INTEGER REFERENCES employees(id)
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS package_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    role_type TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS template_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES package_templates(id) ON DELETE CASCADE,
    phase INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL,
    item_name TEXT NOT NULL,
    description TEXT,
    authority TEXT,
    required INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS hiring_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER REFERENCES applicants(id),
    employee_id INTEGER REFERENCES employees(id),
    template_id INTEGER REFERENCES package_templates(id),
    candidate_name TEXT NOT NULL,
    position TEXT,
    status TEXT DEFAULT 'in_progress',
    assigned_to TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS package_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES hiring_packages(id) ON DELETE CASCADE,
    phase INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL,
    item_name TEXT NOT NULL,
    description TEXT,
    authority TEXT,
    required INTEGER DEFAULT 1,
    status TEXT DEFAULT 'pending',
    completed_by TEXT,
    completed_at DATETIME,
    expiration_date TEXT,
    document_id INTEGER,
    notes TEXT,
    sort_order INTEGER DEFAULT 0
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS compensation_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_type TEXT NOT NULL,
    rate REAL NOT NULL,
    frequency TEXT,
    effective_date TEXT NOT NULL,
    end_date TEXT,
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS payment_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    pay_period_start TEXT,
    pay_period_end TEXT,
    payment_date TEXT NOT NULL,
    gross_amount REAL NOT NULL,
    payment_method TEXT,
    check_number TEXT,
    invoice_number TEXT,
    hours_worked REAL,
    sessions INTEGER,
    days_worked REAL,
    category TEXT DEFAULT 'regular',
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  dbRun(`CREATE TABLE IF NOT EXISTS digital_signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signer_name TEXT NOT NULL,
    signer_role TEXT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    document_name TEXT NOT NULL,
    signature_data TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    signed_by_user_id INTEGER,
    signed_by_username TEXT,
    signed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  /* ── Safe migrations for existing DBs ────────────────── */
  const migrations = [
    'ALTER TABLE employees ADD COLUMN wc_exemption_number TEXT',
    'ALTER TABLE employees ADD COLUMN wc_carrier TEXT',
    'ALTER TABLE employees ADD COLUMN liability_carrier TEXT',
    'ALTER TABLE employees ADD COLUMN liability_policy TEXT',
    'ALTER TABLE employees ADD COLUMN liability_coverage TEXT',
    'ALTER TABLE employees ADD COLUMN board_cert TEXT',
    'ALTER TABLE employees ADD COLUMN board_cert_number TEXT',
    'ALTER TABLE employees ADD COLUMN board_cert_expiration TEXT',
    'ALTER TABLE employees ADD COLUMN supervising_physician TEXT',
    'ALTER TABLE employees ADD COLUMN supervision_expiration TEXT',
    'ALTER TABLE employees ADD COLUMN caqh_attested TEXT',
    'ALTER TABLE employees ADD COLUMN medicare_status TEXT',
    'ALTER TABLE employees ADD COLUMN medicaid_status TEXT',
    'ALTER TABLE employees ADD COLUMN telehealth_states TEXT',
    'ALTER TABLE employees ADD COLUMN hospital_privileges TEXT',
    'ALTER TABLE employees ADD COLUMN hospital_privileges_expiration TEXT',
    'ALTER TABLE users ADD COLUMN display_name TEXT',
    'ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1',
    'ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0',
    'ALTER TABLE employees ADD COLUMN pay_type TEXT',
    'ALTER TABLE employees ADD COLUMN pay_rate REAL',
    'ALTER TABLE employees ADD COLUMN pay_frequency TEXT',
    // 003 — access token for physical badge barcodes
    'ALTER TABLE employees ADD COLUMN access_token TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_access_token ON employees(access_token)',
  ];
  for (const sql of migrations) { try { db.run(sql); } catch (_) {} }

  // Backfill access_token for any existing employees that don't have one yet
  const noToken = db.exec("SELECT id FROM employees WHERE access_token IS NULL OR access_token = ''");
  if (noToken.length && noToken[0].values.length) {
    for (const [empId] of noToken[0].values) {
      db.run('UPDATE employees SET access_token=? WHERE id=?', [generateAccessToken(), empId]);
    }
    console.log(`[db] Backfilled access_token for ${noToken[0].values.length} employee(s)`);
  }
  saveDb();

  /* ── Seed admin ─────────────────────────────────────────── */
  if (!dbGet('SELECT id FROM users LIMIT 1')) {
    dbRun('INSERT INTO users (username,password,role,display_name,must_change_password) VALUES (?,?,?,?,?)',
      ['admin', bcrypt.hashSync('Admin2026!', 10), 'admin', 'Administrator', 1]);
    console.log('[db] Seeded admin account (admin / Admin2026!)');
  }

  /* ── Seed settings ───────────────────────────────────────── */
  seedSettings();

  /* ── Seed hiring package templates ───────────────────────── */
  seedTemplates();

  /* ── Housekeeping ──────────────────────────────────────── */
  dbRun('DELETE FROM token_blacklist WHERE expires_at < ?', [Math.floor(Date.now() / 1000)]);
  dbRun("DELETE FROM login_attempts WHERE ts < datetime('now', '-24 hours')");

  console.log('[db] Ready');
  return { dbAll, dbGet, dbRun, lastInsertId, saveDb };
}


/* ─── Seed default settings ──────────────────────────────── */
function seedSettings() {
  const existing = dbGet('SELECT key FROM app_settings LIMIT 1');
  if (!existing) {
    const defaults = {
      org_name: 'Emeros EMS',
      org_address: '',
      org_city: '',
      org_state: 'FL',
      org_zip: '',
      org_phone: '',
      org_email: '',
      org_website: '',
      org_logo_url: '',
      medical_director: '',
      ms_client_id: '',
      ms_tenant_id: '',
    };
    for (const [key, value] of Object.entries(defaults)) {
      db.run('INSERT INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
    }
    saveDb();
    console.log('[db] Seeded default app settings');
  }
}

/* ─── Seed hiring package templates ─────────────────────────── */
function seedTemplates() {
  const existing = dbGet('SELECT id FROM package_templates LIMIT 1');
  if (existing) return;

  function insertTemplate(name, description, roleType) {
    db.run('INSERT INTO package_templates (name, description, role_type) VALUES (?, ?, ?)',
      [name, description, roleType]);
    return db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  }

  function insertItems(templateId, items) {
    for (const item of items) {
      db.run(
        'INSERT INTO template_items (template_id, phase, category, item_name, description, authority, required, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [templateId, item.phase, item.category, item.item_name, item.description || null, item.authority || null, item.required !== undefined ? item.required : 1, item.sort_order]
      );
    }
  }

  /* ── Shared item definitions ────────────────────────────── */

  const phase1Application = [
    { phase: 1, category: 'Application', item_name: 'Completed Employment Application', authority: 'Facility Policy', sort_order: 10 },
    { phase: 1, category: 'Application', item_name: 'Resume / Curriculum Vitae', authority: 'Facility Policy', sort_order: 20 },
    { phase: 1, category: 'Application', item_name: 'Professional References (minimum 3)', authority: 'Joint Commission HRM', sort_order: 30 },
    { phase: 1, category: 'Application', item_name: 'Cover Letter', authority: 'Facility Policy', required: 0, sort_order: 40 },
  ];

  const phase2ConditionalOffer = [
    { phase: 2, category: 'Offer', item_name: 'Signed Offer Letter / Employment Agreement', authority: 'Facility Policy', sort_order: 10 },
    { phase: 2, category: 'Offer', item_name: 'Background Screening Consent Form', authority: 'FL §408.809', sort_order: 20 },
    { phase: 2, category: 'Offer', item_name: 'Drug Screening Consent Form', authority: 'FL §440.102', sort_order: 30 },
    { phase: 2, category: 'Background', item_name: 'AHCA Level 2 Background Screening (Livescan)', authority: 'FL §408.809, §435.04', sort_order: 40 },
    { phase: 2, category: 'Background', item_name: 'AHCA Clearinghouse Eligibility Verified', authority: 'FL §408.809', sort_order: 50 },
    { phase: 2, category: 'Background', item_name: 'Attestation of Compliance with Background Screening', authority: 'AHCA Form 3100-0008', sort_order: 60 },
    { phase: 2, category: 'Background', item_name: 'OIG/SAM Exclusion Check', authority: 'Joint Commission HRM, 42 CFR §1001', sort_order: 70 },
    { phase: 2, category: 'Health Screening', item_name: 'Pre-Employment Drug Screen — Negative Result', authority: 'FL §440.102', sort_order: 80 },
    { phase: 2, category: 'Health Screening', item_name: 'TB Screening (PPD or Blood Test)', authority: 'CDC/OSHA', sort_order: 90 },
    { phase: 2, category: 'Health Screening', item_name: 'Hepatitis B Vaccination or Signed Declination', authority: 'OSHA 29 CFR §1910.1030', sort_order: 100 },
  ];

  const phase3LicensureClinician = [
    { phase: 3, category: 'Licensure', item_name: 'Active FL Professional License Verified (Primary Source)', authority: 'FL Ch. 491, Joint Commission HRM', sort_order: 10 },
    { phase: 3, category: 'Licensure', item_name: 'License Type and Number Documented', authority: 'FL Ch. 491', sort_order: 20 },
    { phase: 3, category: 'Licensure', item_name: 'License Expiration Date Tracked', authority: 'FL Ch. 491', sort_order: 30 },
    { phase: 3, category: 'Licensure', item_name: 'FL Laws & Rules Course (8 hours) — Completed', authority: 'FL §491.005', sort_order: 40 },
    { phase: 3, category: 'Licensure', item_name: 'HIV/AIDS Course (3 hours) — Completed', authority: 'FL §491.005', sort_order: 50 },
    { phase: 3, category: 'Licensure', item_name: 'Domestic Violence Course (2 hours) — Completed', authority: 'FL §491.005', sort_order: 60 },
  ];

  const phase3Credentials = [
    { phase: 3, category: 'Credentials', item_name: 'NPI Number Verified (NPPES)', authority: 'CMS/Joint Commission', sort_order: 70 },
    { phase: 3, category: 'Credentials', item_name: 'CAQH ProView Profile Active', authority: 'Payer Credentialing', sort_order: 80 },
    { phase: 3, category: 'Credentials', item_name: 'Medicare Enrollment (if applicable)', authority: 'CMS PECOS', required: 0, sort_order: 90 },
    { phase: 3, category: 'Credentials', item_name: 'Medicaid Enrollment (if applicable)', authority: 'FL MMIS', required: 0, sort_order: 100 },
    { phase: 3, category: 'Credentials', item_name: 'Professional Liability Insurance ($1M/$3M)', authority: 'Joint Commission, Facility Policy', sort_order: 110 },
    { phase: 3, category: 'Credentials', item_name: 'Board Certification Verified (if applicable)', authority: 'Joint Commission HRM', required: 0, sort_order: 120 },
  ];

  const phase3Identity = [
    { phase: 3, category: 'Identity', item_name: 'Form I-9 — Employment Eligibility Verification', authority: 'Federal (USCIS)', sort_order: 130 },
    { phase: 3, category: 'Identity', item_name: 'E-Verify Confirmation', authority: 'FL §448.095 (SB 1718)', sort_order: 140 },
    { phase: 3, category: 'Identity', item_name: 'W-4 Federal Tax Withholding', authority: 'IRS', sort_order: 150 },
    { phase: 3, category: 'Identity', item_name: 'Florida New Hire Reporting Filed', authority: 'FL Dept of Revenue', sort_order: 160 },
    { phase: 3, category: 'Identity', item_name: 'Copy of Government-Issued Photo ID', authority: 'Federal I-9', sort_order: 170 },
    { phase: 3, category: 'Identity', item_name: 'Social Security Card or Acceptable I-9 Document', authority: 'Federal I-9', sort_order: 180 },
  ];

  const phase3Insurance = [
    { phase: 3, category: 'Insurance', item_name: 'Workers\' Compensation Coverage or Exemption Verified', authority: 'FL §440', sort_order: 190 },
  ];

  const phase4TrainingClinician = [
    { phase: 4, category: 'Training', item_name: 'HIPAA Privacy & Security Training', authority: 'HIPAA §164.530', sort_order: 10 },
    { phase: 4, category: 'Training', item_name: 'HIPAA Breach Notification Training', authority: 'HITECH Act', sort_order: 20 },
    { phase: 4, category: 'Training', item_name: 'Abuse & Neglect Mandatory Reporting Training', authority: 'FL §39.201, §415.1034', sort_order: 30 },
    { phase: 4, category: 'Training', item_name: 'Bloodborne Pathogens / Infection Control Training', authority: 'OSHA 29 CFR §1910.1030, Joint Commission IC', sort_order: 40 },
    { phase: 4, category: 'Training', item_name: 'Workplace Violence Prevention Training', authority: 'OSHA, Joint Commission', sort_order: 50 },
    { phase: 4, category: 'Training', item_name: 'Sexual Harassment Prevention Training', authority: 'Federal/State', sort_order: 60 },
    { phase: 4, category: 'Training', item_name: 'Cultural Competency Training', authority: 'Joint Commission, CMS', sort_order: 70 },
    { phase: 4, category: 'Training', item_name: 'Baker Act (Involuntary Examination) Orientation', authority: 'FL §394.463', sort_order: 80 },
    { phase: 4, category: 'Training', item_name: 'Marchman Act (Substance Abuse) Orientation', authority: 'FL §397', sort_order: 90 },
    { phase: 4, category: 'Training', item_name: 'Suicide Risk Screening & Assessment Protocol', authority: 'Joint Commission NPG 8', sort_order: 100 },
    { phase: 4, category: 'Training', item_name: 'Emergency / Fire Safety Orientation', authority: 'Joint Commission EC, OSHA', sort_order: 110 },
    { phase: 4, category: 'Training', item_name: 'Environment of Care Orientation', authority: 'Joint Commission EC', sort_order: 120 },
    { phase: 4, category: 'Training', item_name: 'Incident Reporting Procedures', authority: 'AHCA, Joint Commission', sort_order: 130 },
    { phase: 4, category: 'Training', item_name: 'Patient Rights & Confidentiality', authority: 'Joint Commission RI, FL §394', sort_order: 140 },
  ];

  const phase4CompetencyClinician = [
    { phase: 4, category: 'Competency', item_name: 'Initial Competency Assessment Completed', authority: 'Joint Commission HRM', sort_order: 150 },
    { phase: 4, category: 'Competency', item_name: 'FPPE (Focused Professional Practice Evaluation) Plan Created', authority: 'Joint Commission MS', sort_order: 160 },
    { phase: 4, category: 'Competency', item_name: 'Departmental Orientation Documented', authority: 'Joint Commission HRM', sort_order: 170 },
  ];

  const phase4Documents = [
    { phase: 4, category: 'Documents', item_name: 'Employee Handbook Acknowledgment Signed', authority: 'Facility Policy', sort_order: 180 },
    { phase: 4, category: 'Documents', item_name: 'Confidentiality / NDA Agreement Signed', authority: 'Facility Policy', sort_order: 190 },
    { phase: 4, category: 'Documents', item_name: 'Direct Deposit Authorization', authority: 'Facility Policy', sort_order: 200 },
    { phase: 4, category: 'Documents', item_name: 'Emergency Contact Form', authority: 'Facility Policy', sort_order: 210 },
    { phase: 4, category: 'Documents', item_name: 'Credential Verification Organization (CVO) Report', authority: 'Joint Commission HRM', required: 0, sort_order: 220 },
  ];

  const phase4IT = [
    { phase: 4, category: 'IT', item_name: 'EHR System Access Provisioned', authority: 'Facility Policy', sort_order: 230 },
    { phase: 4, category: 'IT', item_name: 'Email / Communication Access Set Up', authority: 'Facility Policy', sort_order: 240 },
  ];

  const phase4CPR = [
    { phase: 4, category: 'CPR', item_name: 'CPR/BLS Certification Current', authority: 'Facility Policy, Joint Commission', sort_order: 250 },
  ];

  /* ── Template 1: Licensed Mental Health Clinician ───────── */
  const t1Id = insertTemplate(
    'Licensed Mental Health Clinician',
    'Covers: LMHC, LCSW, LMFT, Psychologist',
    'licensed_clinician'
  );
  insertItems(t1Id, [
    ...phase1Application,
    ...phase2ConditionalOffer,
    ...phase3LicensureClinician,
    ...phase3Credentials,
    ...phase3Identity,
    ...phase3Insurance,
    ...phase4TrainingClinician,
    ...phase4CompetencyClinician,
    ...phase4Documents,
    ...phase4IT,
    ...phase4CPR,
  ]);

  /* ── Template 2: Prescribing Provider ───────────────────── */
  const t2Id = insertTemplate(
    'Prescribing Provider',
    'Covers: Psychiatrist, ARNP (Psychiatric)',
    'prescriber'
  );
  const prescriberLicensureAdditions = [
    { phase: 3, category: 'Licensure', item_name: 'DEA Registration Verified', authority: 'DEA, 21 CFR §1301', sort_order: 65 },
    { phase: 3, category: 'Licensure', item_name: 'DEA Expiration Date Tracked', authority: 'DEA', sort_order: 66 },
    { phase: 3, category: 'Licensure', item_name: 'FL Controlled Substance Prescribing Authority Verified', authority: 'FL Board of Medicine/Nursing', sort_order: 67 },
  ];
  const prescriberCredentialAdditions = [
    { phase: 3, category: 'Credentials', item_name: 'Collaborative Practice Agreement (if ARNP)', authority: 'FL §464.012', required: 0, sort_order: 125 },
    { phase: 3, category: 'Credentials', item_name: 'Hospital Privileges Documentation (if applicable)', authority: 'Joint Commission MS', required: 0, sort_order: 126 },
    { phase: 3, category: 'Credentials', item_name: 'Medication Management Privileges Granted', authority: 'Joint Commission MM', sort_order: 127 },
  ];
  insertItems(t2Id, [
    ...phase1Application,
    ...phase2ConditionalOffer,
    ...phase3LicensureClinician,
    ...prescriberLicensureAdditions,
    ...phase3Credentials,
    ...prescriberCredentialAdditions,
    ...phase3Identity,
    ...phase3Insurance,
    ...phase4TrainingClinician,
    ...phase4CompetencyClinician,
    ...phase4Documents,
    ...phase4IT,
    ...phase4CPR,
  ]);

  /* ── Template 3: TMS Technician ─────────────────────────── */
  const t3Id = insertTemplate(
    'TMS Technician',
    'Covers: TMS operators who are NOT independently licensed clinicians',
    'tms_tech'
  );
  const tmsCertification = [
    { phase: 3, category: 'Certification', item_name: 'TMS Operator Certification (Level 2) Completed', authority: 'Facility Policy, FDA', sort_order: 10 },
    { phase: 3, category: 'Certification', item_name: 'TMS Safety Training & Written Exam Passed', authority: 'Facility Policy', sort_order: 20 },
    { phase: 3, category: 'Certification', item_name: 'TMS Device-Specific Training Documented', authority: 'Manufacturer, FDA 510(k)', sort_order: 30 },
    { phase: 3, category: 'Certification', item_name: 'Seizure First-Responder Training', authority: 'Facility Policy', sort_order: 40 },
    { phase: 3, category: 'CPR', item_name: 'CPR/BLS Certification Current', authority: 'AHA, Facility Policy', sort_order: 50 },
  ];
  // Phase 4 without FPPE and CVO Report
  const phase4CompetencyTMS = [
    { phase: 4, category: 'Competency', item_name: 'Initial Competency Assessment Completed', authority: 'Joint Commission HRM', sort_order: 150 },
    { phase: 4, category: 'Competency', item_name: 'Departmental Orientation Documented', authority: 'Joint Commission HRM', sort_order: 170 },
  ];
  const phase4DocumentsTMS = [
    { phase: 4, category: 'Documents', item_name: 'Employee Handbook Acknowledgment Signed', authority: 'Facility Policy', sort_order: 180 },
    { phase: 4, category: 'Documents', item_name: 'Confidentiality / NDA Agreement Signed', authority: 'Facility Policy', sort_order: 190 },
    { phase: 4, category: 'Documents', item_name: 'Direct Deposit Authorization', authority: 'Facility Policy', sort_order: 200 },
    { phase: 4, category: 'Documents', item_name: 'Emergency Contact Form', authority: 'Facility Policy', sort_order: 210 },
  ];
  insertItems(t3Id, [
    ...phase1Application,
    ...phase2ConditionalOffer,
    ...tmsCertification,
    ...phase3Identity,
    ...phase3Insurance,
    ...phase4TrainingClinician,
    ...phase4CompetencyTMS,
    ...phase4DocumentsTMS,
    ...phase4IT,
    ...phase4CPR,
  ]);

  /* ── Template 4: Registered Intern ──────────────────────── */
  const t4Id = insertTemplate(
    'Registered Intern',
    'Covers: RMHCI, RCSWI, RMFTI',
    'intern'
  );
  const internLicensure = [
    { phase: 3, category: 'Licensure', item_name: 'Registered Intern Status Verified with FL DOH', authority: 'FL Ch. 491, Joint Commission HRM', sort_order: 10 },
    { phase: 3, category: 'Licensure', item_name: 'License Type and Number Documented', authority: 'FL Ch. 491', sort_order: 20 },
    { phase: 3, category: 'Licensure', item_name: 'License Expiration Date Tracked', authority: 'FL Ch. 491', sort_order: 30 },
    { phase: 3, category: 'Licensure', item_name: 'FL Laws & Rules Course (8 hours) — Completed', authority: 'FL §491.005', sort_order: 40 },
    { phase: 3, category: 'Licensure', item_name: 'HIV/AIDS Course (3 hours) — Completed', authority: 'FL §491.005', sort_order: 50 },
    { phase: 3, category: 'Licensure', item_name: 'Domestic Violence Course (2 hours) — Completed', authority: 'FL §491.005', sort_order: 60 },
  ];
  const internSupervision = [
    { phase: 3, category: 'Supervision', item_name: 'Qualified Supervisor Identified and Letter on File', authority: 'FL §491.0045', sort_order: 65 },
    { phase: 3, category: 'Supervision', item_name: 'Supervision Plan Submitted to Board', authority: 'FL §491.0045', sort_order: 66 },
    { phase: 3, category: 'Supervision', item_name: 'Supervision Agreement Signed', authority: 'FL §491.0045', sort_order: 67 },
  ];
  const internCredentials = [
    { phase: 3, category: 'Credentials', item_name: 'NPI Number Verified (NPPES)', authority: 'CMS/Joint Commission', sort_order: 70 },
    { phase: 3, category: 'Credentials', item_name: 'CAQH ProView Profile Active', authority: 'Payer Credentialing', sort_order: 80 },
    { phase: 3, category: 'Credentials', item_name: 'Professional Liability Insurance ($1M/$3M)', authority: 'Joint Commission, Facility Policy', sort_order: 110 },
  ];
  // Phase 4 without FPPE
  const phase4CompetencyIntern = [
    { phase: 4, category: 'Competency', item_name: 'Initial Competency Assessment Completed', authority: 'Joint Commission HRM', sort_order: 150 },
    { phase: 4, category: 'Competency', item_name: 'Departmental Orientation Documented', authority: 'Joint Commission HRM', sort_order: 170 },
  ];
  insertItems(t4Id, [
    ...phase1Application,
    ...phase2ConditionalOffer,
    ...internLicensure,
    ...internSupervision,
    ...internCredentials,
    ...phase3Identity,
    ...phase3Insurance,
    ...phase4TrainingClinician,
    ...phase4CompetencyIntern,
    ...phase4Documents,
    ...phase4IT,
    ...phase4CPR,
  ]);

  /* ── Template 5: Administrative / Support Staff ─────────── */
  const t5Id = insertTemplate(
    'Administrative / Support Staff',
    'Covers: Front desk, billing, non-clinical roles',
    'admin_support'
  );
  const phase2AdminSupport = [
    { phase: 2, category: 'Offer', item_name: 'Signed Offer Letter / Employment Agreement', authority: 'Facility Policy', sort_order: 10 },
    { phase: 2, category: 'Offer', item_name: 'Background Screening Consent Form', authority: 'FL §408.809', sort_order: 20 },
    { phase: 2, category: 'Offer', item_name: 'Drug Screening Consent Form', authority: 'FL §440.102', required: 0, sort_order: 30 },
    { phase: 2, category: 'Background', item_name: 'AHCA Level 2 Background Screening (Livescan)', authority: 'FL §408.809, §435.04', sort_order: 40 },
    { phase: 2, category: 'Background', item_name: 'AHCA Clearinghouse Eligibility Verified', authority: 'FL §408.809', sort_order: 50 },
    { phase: 2, category: 'Background', item_name: 'Attestation of Compliance with Background Screening', authority: 'AHCA Form 3100-0008', sort_order: 60 },
    { phase: 2, category: 'Background', item_name: 'OIG/SAM Exclusion Check', authority: 'Joint Commission HRM, 42 CFR §1001', sort_order: 70 },
    { phase: 2, category: 'Health Screening', item_name: 'Pre-Employment Drug Screen — Negative Result', authority: 'FL §440.102', sort_order: 80 },
    { phase: 2, category: 'Health Screening', item_name: 'TB Screening (PPD or Blood Test)', authority: 'CDC/OSHA', sort_order: 90 },
    { phase: 2, category: 'Health Screening', item_name: 'Hepatitis B Vaccination or Signed Declination', authority: 'OSHA 29 CFR §1910.1030', sort_order: 100 },
  ];
  const phase3AdminVerification = [
    { phase: 3, category: 'Verification', item_name: 'Education Verification (if applicable)', authority: 'Joint Commission HRM', required: 0, sort_order: 10 },
    { phase: 3, category: 'Verification', item_name: 'Previous Employment Verification', authority: 'Facility Policy', sort_order: 20 },
  ];
  // Phase 4: remove Baker Act, Marchman Act, Suicide Risk Screening, FPPE, CVO Report
  const phase4TrainingAdmin = [
    { phase: 4, category: 'Training', item_name: 'HIPAA Privacy & Security Training', authority: 'HIPAA §164.530', sort_order: 10 },
    { phase: 4, category: 'Training', item_name: 'HIPAA Breach Notification Training', authority: 'HITECH Act', sort_order: 20 },
    { phase: 4, category: 'Training', item_name: 'Abuse & Neglect Mandatory Reporting Training', authority: 'FL §39.201, §415.1034', sort_order: 30 },
    { phase: 4, category: 'Training', item_name: 'Bloodborne Pathogens / Infection Control Training', authority: 'OSHA 29 CFR §1910.1030, Joint Commission IC', sort_order: 40 },
    { phase: 4, category: 'Training', item_name: 'Workplace Violence Prevention Training', authority: 'OSHA, Joint Commission', sort_order: 50 },
    { phase: 4, category: 'Training', item_name: 'Sexual Harassment Prevention Training', authority: 'Federal/State', sort_order: 60 },
    { phase: 4, category: 'Training', item_name: 'Cultural Competency Training', authority: 'Joint Commission, CMS', sort_order: 70 },
    { phase: 4, category: 'Training', item_name: 'Emergency / Fire Safety Orientation', authority: 'Joint Commission EC, OSHA', sort_order: 110 },
    { phase: 4, category: 'Training', item_name: 'Environment of Care Orientation', authority: 'Joint Commission EC', sort_order: 120 },
    { phase: 4, category: 'Training', item_name: 'Incident Reporting Procedures', authority: 'AHCA, Joint Commission', sort_order: 130 },
    { phase: 4, category: 'Training', item_name: 'Patient Rights & Confidentiality', authority: 'Joint Commission RI, FL §394', sort_order: 140 },
  ];
  const phase4CompetencyAdmin = [
    { phase: 4, category: 'Competency', item_name: 'Initial Competency Assessment Completed', authority: 'Joint Commission HRM', sort_order: 150 },
    { phase: 4, category: 'Competency', item_name: 'Departmental Orientation Documented', authority: 'Joint Commission HRM', sort_order: 170 },
  ];
  const phase4DocumentsAdmin = [
    { phase: 4, category: 'Documents', item_name: 'Employee Handbook Acknowledgment Signed', authority: 'Facility Policy', sort_order: 180 },
    { phase: 4, category: 'Documents', item_name: 'Confidentiality / NDA Agreement Signed', authority: 'Facility Policy', sort_order: 190 },
    { phase: 4, category: 'Documents', item_name: 'Direct Deposit Authorization', authority: 'Facility Policy', sort_order: 200 },
    { phase: 4, category: 'Documents', item_name: 'Emergency Contact Form', authority: 'Facility Policy', sort_order: 210 },
  ];
  insertItems(t5Id, [
    ...phase1Application,
    ...phase2AdminSupport,
    ...phase3AdminVerification,
    ...phase3Identity,
    ...phase3Insurance,
    ...phase4TrainingAdmin,
    ...phase4CompetencyAdmin,
    ...phase4DocumentsAdmin,
    ...phase4IT,
    ...phase4CPR,
  ]);

  /* ── Template 6: Contracted Employee (1099) ───────────── */
  const t6Id = insertTemplate(
    'Contracted Employee (1099)',
    'Covers: Independent contractors, subcontractors — licensed clinicians or service providers on 1099',
    'contracted'
  );
  const phase2Contracted = [
    { phase: 2, category: 'Offer', item_name: 'Signed Independent Contractor Agreement', authority: 'Facility Policy, IRS §530', sort_order: 10 },
    { phase: 2, category: 'Offer', item_name: 'Scope of Services Addendum', authority: 'Facility Policy', sort_order: 20 },
    { phase: 2, category: 'Offer', item_name: 'Background Screening Consent Form', authority: 'FL §408.809', sort_order: 30 },
    { phase: 2, category: 'Offer', item_name: 'Drug Screening Consent Form', authority: 'FL §440.102', sort_order: 40 },
    { phase: 2, category: 'Background', item_name: 'AHCA Level 2 Background Screening (Livescan)', authority: 'FL §408.809, §435.04', sort_order: 50 },
    { phase: 2, category: 'Background', item_name: 'AHCA Clearinghouse Eligibility Verified', authority: 'FL §408.809', sort_order: 60 },
    { phase: 2, category: 'Background', item_name: 'Attestation of Compliance with Background Screening', authority: 'AHCA Form 3100-0008', sort_order: 70 },
    { phase: 2, category: 'Background', item_name: 'OIG/SAM Exclusion Check', authority: 'Joint Commission HRM, 42 CFR §1001', sort_order: 80 },
    { phase: 2, category: 'Health Screening', item_name: 'Pre-Employment Drug Screen — Negative Result', authority: 'FL §440.102', sort_order: 90 },
    { phase: 2, category: 'Health Screening', item_name: 'TB Screening (PPD or Blood Test)', authority: 'CDC/OSHA', sort_order: 100 },
    { phase: 2, category: 'Health Screening', item_name: 'Hepatitis B Vaccination or Signed Declination', authority: 'OSHA 29 CFR §1910.1030', sort_order: 110 },
  ];
  const phase3Contracted = [
    { phase: 3, category: 'Licensure', item_name: 'Active FL Professional License Verified (Primary Source)', authority: 'FL Ch. 491, Joint Commission HRM', sort_order: 10 },
    { phase: 3, category: 'Licensure', item_name: 'License Type and Number Documented', authority: 'FL Ch. 491', sort_order: 20 },
    { phase: 3, category: 'Licensure', item_name: 'License Expiration Date Tracked', authority: 'FL Ch. 491', sort_order: 30 },
    { phase: 3, category: 'Credentials', item_name: 'NPI Number Verified (NPPES)', authority: 'CMS/Joint Commission', sort_order: 40 },
    { phase: 3, category: 'Credentials', item_name: 'CAQH ProView Profile Active', authority: 'Payer Credentialing', sort_order: 50 },
    { phase: 3, category: 'Credentials', item_name: 'Professional Liability Insurance ($1M/$3M)', authority: 'Joint Commission, Facility Policy', sort_order: 60 },
    { phase: 3, category: 'Credentials', item_name: 'Certificate of Insurance on File', authority: 'Facility Policy', sort_order: 70 },
    { phase: 3, category: 'Credentials', item_name: 'Medicare Enrollment (if applicable)', authority: 'CMS PECOS', required: 0, sort_order: 80 },
    { phase: 3, category: 'Credentials', item_name: 'Medicaid Enrollment (if applicable)', authority: 'FL MMIS', required: 0, sort_order: 90 },
    { phase: 3, category: 'Tax & Legal', item_name: 'W-9 Request for Taxpayer Identification', authority: 'IRS', sort_order: 100 },
    { phase: 3, category: 'Tax & Legal', item_name: 'Copy of Government-Issued Photo ID', authority: 'Facility Policy', sort_order: 110 },
    { phase: 3, category: 'Tax & Legal', item_name: 'Proof of Business Entity (SunBiz / LLC / Corp)', authority: 'FL Dept of State', required: 0, sort_order: 120 },
    { phase: 3, category: 'Tax & Legal', item_name: 'EIN or SSN for 1099 Reporting', authority: 'IRS', sort_order: 130 },
    { phase: 3, category: 'Insurance', item_name: "Workers' Compensation Exemption or Coverage Verified", authority: 'FL §440, FL DFS', sort_order: 140 },
    { phase: 3, category: 'Insurance', item_name: "WC Exemption Certificate on File (if exempt)", authority: 'FL DFS', required: 0, sort_order: 150 },
  ];
  const phase4ContractedTraining = [
    { phase: 4, category: 'Training', item_name: 'HIPAA Privacy & Security Training', authority: 'HIPAA §164.530', sort_order: 10 },
    { phase: 4, category: 'Training', item_name: 'HIPAA Breach Notification Training', authority: 'HITECH Act', sort_order: 20 },
    { phase: 4, category: 'Training', item_name: 'Abuse & Neglect Mandatory Reporting Training', authority: 'FL §39.201, §415.1034', sort_order: 30 },
    { phase: 4, category: 'Training', item_name: 'Bloodborne Pathogens / Infection Control Training', authority: 'OSHA 29 CFR §1910.1030, Joint Commission IC', sort_order: 40 },
    { phase: 4, category: 'Training', item_name: 'Suicide Risk Screening & Assessment Protocol', authority: 'Joint Commission NPG 8', sort_order: 50 },
    { phase: 4, category: 'Training', item_name: 'Baker Act (Involuntary Examination) Orientation', authority: 'FL §394.463', sort_order: 60 },
    { phase: 4, category: 'Training', item_name: 'Marchman Act (Substance Abuse) Orientation', authority: 'FL §397', sort_order: 70 },
    { phase: 4, category: 'Training', item_name: 'Emergency / Fire Safety Orientation', authority: 'Joint Commission EC, OSHA', sort_order: 80 },
    { phase: 4, category: 'Training', item_name: 'Environment of Care Orientation', authority: 'Joint Commission EC', sort_order: 90 },
    { phase: 4, category: 'Training', item_name: 'Incident Reporting Procedures', authority: 'AHCA, Joint Commission', sort_order: 100 },
    { phase: 4, category: 'Training', item_name: 'Patient Rights & Confidentiality', authority: 'Joint Commission RI, FL §394', sort_order: 110 },
  ];
  const phase4ContractedDocs = [
    { phase: 4, category: 'Competency', item_name: 'Initial Competency Assessment Completed', authority: 'Joint Commission HRM', sort_order: 120 },
    { phase: 4, category: 'Competency', item_name: 'FPPE (Focused Professional Practice Evaluation) Plan Created', authority: 'Joint Commission MS', sort_order: 130 },
    { phase: 4, category: 'Documents', item_name: 'Confidentiality / NDA Agreement Signed', authority: 'Facility Policy', sort_order: 140 },
    { phase: 4, category: 'Documents', item_name: 'Contractor Orientation Acknowledgment Signed', authority: 'Facility Policy', sort_order: 150 },
    { phase: 4, category: 'Documents', item_name: 'Emergency Contact Form', authority: 'Facility Policy', sort_order: 160 },
  ];
  insertItems(t6Id, [
    ...phase1Application,
    ...phase2Contracted,
    ...phase3Contracted,
    ...phase4ContractedTraining,
    ...phase4ContractedDocs,
    ...phase4IT,
    ...phase4CPR,
  ]);

  saveDb();
  console.log('[db] Seeded 6 hiring package templates');
}

module.exports = { initDb, dbAll, dbGet, dbRun, lastInsertId, saveDb, reloadDb, generateAccessToken };
