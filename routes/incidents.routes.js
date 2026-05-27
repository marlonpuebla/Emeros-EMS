'use strict';
/**
 * Incident Reports — Healthcare Compliance Module
 *
 * Compliant with:
 *   - Joint Commission Sentinel Event Policy & NPSG
 *   - FL §395.0197 (Adverse Incident Reporting — AHCA, 15-day window)
 *   - FL §39.201 (Abuse/Neglect/Exploitation mandatory report — 24 hours)
 *   - FL §394 (Baker Act — mental health incidents)
 *   - OSHA 300 / 300A (workplace injury / illness log)
 *   - HIPAA Breach Notification Rule (60-day notification window)
 *   - FDA Medical Device Reporting (MDR) — equipment_involved flag
 *   - CMS Conditions of Participation
 *   - NCC MERP severity index (A–I) for medication errors
 *
 * Print endpoint: GET /api/incidents/:id/print
 *   Returns a CONFIDENTIAL-marked, print-optimized HTML page including
 *   all fields, notification log, signature lines, and the FL §395.0197(4)
 *   legal privilege notice.
 */

const path = require('path');
const fs   = require('fs');
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');
const { generateIncidentNumber } = require('../db');
const config = require('../config');

const VALID_TYPES = [
  'workplace_injury',       // OSHA 300
  'near_miss',              // No harm reached patient/employee
  'fall',                   // Patient/employee fall — OSHA + Joint Commission
  'medication_error',       // NCC MERP A–I severity
  'adverse_drug_reaction',  // Unexpected drug reaction (not an error)
  'patient_complaint',      // Formal patient/family complaint
  'abuse_neglect_exploitation', // FL §39.201 — mandatory 24h DCF report
  'elopement',              // Patient leaving without authorization
  'suicide_attempt_self_harm',  // FL §394, Joint Commission NPSG 15
  'restraint_seclusion',    // Joint Commission & CMS CoP
  'sentinel_event',         // Unexpected death / serious harm — Joint Commission
  'hipaa_breach',           // HIPAA Breach Notification Rule
  'property_damage',        // Facility / equipment damage
  'security',               // Threat, assault, unauthorized access
  'equipment_failure',      // Potential FDA MDR trigger
  'exposure',               // Bloodborne pathogen / chemical
  'other',
];

const VALID_STATUSES   = ['open', 'under_review', 'closed'];
const VALID_SEVERITIES = ['none', 'near_miss', 'minor', 'moderate', 'serious', 'death'];
const VALID_TREATMENTS = ['none', 'first_aid', 'physician_visit', 'er', 'hospitalization', 'death'];

// Fields to persist on create/update
const INC_FIELDS = [
  'incident_date','incident_time','location','type','description',
  'immediate_action','osha_recordable','osha_case_number','days_away','days_restricted',
  'severity','patient_involved','patient_identifier',
  'injury_type','body_part','treatment',
  'sentinel_event','fl_ahca_reportable','fl_ahca_reported_date',
  'hipaa_breach','hipaa_breach_date',
  'contributing_factors','witnesses',
  'equipment_involved',
  'medication_name','medication_dose','medication_route',
  'follow_up_required','follow_up_date','follow_up_by',
  'root_cause','corrective_action',
  'risk_manager_notified','risk_manager_notified_at',
  'physician_notified','physician_notified_at',
  'family_notified','family_notified_at',
  'admin_notified','admin_notified_at',
  'law_enforcement_notified','law_enforcement_notified_at',
  'dcf_reported','dcf_reported_date',
  'reviewed_by',
];

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtDateTime(d, t) {
  if (!d) return '—';
  return t ? `${d} at ${t}` : d;
}

function yn(v) { return v ? 'Yes' : 'No'; }

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST ────────────────────────────────────────────────── */
  app.get('/api/incidents', auth, editorOrAbove, (req, res) => {
    const { status, type, osha, sentinel, ahca, search } = req.query;
    let sql = 'SELECT * FROM incident_reports WHERE 1=1';
    const p = [];
    if (status)   { sql += ' AND status=?'; p.push(status); }
    if (type)     { sql += ' AND type=?'; p.push(type); }
    if (osha === '1')     { sql += ' AND osha_recordable=1'; }
    if (sentinel === '1') { sql += ' AND sentinel_event=1'; }
    if (ahca === '1')     { sql += ' AND fl_ahca_reportable=1 AND (fl_ahca_reported_date IS NULL OR fl_ahca_reported_date="")'; }
    if (search)   { sql += ' AND (description LIKE ? OR report_number LIKE ? OR location LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql += ' ORDER BY incident_date DESC, id DESC LIMIT 500';
    const incidents = dbAll(sql, p);
    for (const inc of incidents) {
      inc.involved      = dbAll('SELECT * FROM incident_involved      WHERE incident_id=?', [inc.id]);
      inc.notifications = dbAll('SELECT * FROM incident_notifications WHERE incident_id=? ORDER BY notified_at', [inc.id]);
    }
    res.json(incidents);
  });

  /* ── GET ONE ─────────────────────────────────────────────── */
  app.get('/api/incidents/:id(\\d+)', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT * FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    inc.involved      = dbAll('SELECT * FROM incident_involved      WHERE incident_id=? ORDER BY id', [inc.id]);
    inc.notifications = dbAll('SELECT * FROM incident_notifications WHERE incident_id=? ORDER BY notified_at', [inc.id]);
    res.json(inc);
  });

  /* ── CREATE ─────────────────────────────────────────────── */
  app.post('/api/incidents', auth, editorOrAbove, (req, res) => {
    const { incident_date, type, description, involved, notifications } = req.body;
    if (!incident_date)                        return res.status(400).json({ error: 'incident_date is required' });
    if (!type || !VALID_TYPES.includes(type))  return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
    if (!description)                          return res.status(400).json({ error: 'description is required' });

    const report_number = generateIncidentNumber(dbGet);
    const report_date   = req.body.report_date || new Date().toISOString().split('T')[0];

    // Auto-set compliance flags based on type
    const auto_ahca     = req.body.fl_ahca_reportable   ?? (['workplace_injury','fall','medication_error','sentinel_event','suicide_attempt_self_harm'].includes(type) ? 1 : 0);
    const auto_dcf      = req.body.dcf_reported          ?? 0;
    const auto_sentinel = req.body.sentinel_event        ?? (type === 'sentinel_event' ? 1 : 0);
    const auto_osha     = req.body.osha_recordable       ?? (['workplace_injury','fall','exposure'].includes(type) ? 1 : 0);

    dbRun(
      `INSERT INTO incident_reports
        (report_number, report_date, incident_date, incident_time, location, type, description,
         immediate_action, osha_recordable, osha_case_number, days_away, days_restricted,
         severity, patient_involved, patient_identifier, injury_type, body_part, treatment,
         sentinel_event, fl_ahca_reportable, fl_ahca_reported_date,
         hipaa_breach, hipaa_breach_date, contributing_factors, witnesses,
         equipment_involved, medication_name, medication_dose, medication_route,
         follow_up_required, follow_up_date, follow_up_by,
         root_cause, corrective_action,
         risk_manager_notified, risk_manager_notified_at,
         physician_notified, physician_notified_at,
         family_notified, family_notified_at,
         admin_notified, admin_notified_at,
         law_enforcement_notified, law_enforcement_notified_at,
         dcf_reported, dcf_reported_date,
         reviewed_by, reported_by, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        report_number, report_date,
        incident_date, req.body.incident_time||null, req.body.location||null,
        type, description, req.body.immediate_action||null,
        auto_osha ? 1 : 0, req.body.osha_case_number||null,
        req.body.days_away ? Number(req.body.days_away) : 0,
        req.body.days_restricted ? Number(req.body.days_restricted) : 0,
        req.body.severity||null,
        req.body.patient_involved ? 1 : 0, req.body.patient_identifier||null,
        req.body.injury_type||null, req.body.body_part||null, req.body.treatment||null,
        auto_sentinel ? 1 : 0,
        auto_ahca ? 1 : 0, req.body.fl_ahca_reported_date||null,
        req.body.hipaa_breach ? 1 : 0, req.body.hipaa_breach_date||null,
        req.body.contributing_factors||null, req.body.witnesses||null,
        req.body.equipment_involved||null,
        req.body.medication_name||null, req.body.medication_dose||null, req.body.medication_route||null,
        req.body.follow_up_required ? 1 : 0, req.body.follow_up_date||null, req.body.follow_up_by||null,
        req.body.root_cause||null, req.body.corrective_action||null,
        req.body.risk_manager_notified ? 1 : 0, req.body.risk_manager_notified_at||null,
        req.body.physician_notified ? 1 : 0, req.body.physician_notified_at||null,
        req.body.family_notified ? 1 : 0, req.body.family_notified_at||null,
        req.body.admin_notified ? 1 : 0, req.body.admin_notified_at||null,
        req.body.law_enforcement_notified ? 1 : 0, req.body.law_enforcement_notified_at||null,
        auto_dcf ? 1 : 0, req.body.dcf_reported_date||null,
        req.body.reviewed_by||null, req.user.username, req.user.username,
      ]
    );
    const id = lastInsertId();

    if (Array.isArray(involved)) {
      for (const party of involved) {
        dbRun('INSERT INTO incident_involved (incident_id, employee_id, employee_name, role) VALUES (?,?,?,?)',
          [id, party.employee_id||null, party.employee_name||null, party.role||null]);
      }
    }
    if (Array.isArray(notifications)) {
      for (const n of notifications) {
        dbRun('INSERT INTO incident_notifications (incident_id, notified_party, notified_at, method, notified_by, notes) VALUES (?,?,?,?,?,?)',
          [id, n.notified_party, n.notified_at, n.method||null, n.notified_by||req.user.username, n.notes||null]);
      }
    }

    audit(req, 'CREATE_INCIDENT', 'incident_reports', id, { report_number, type, incident_date, sentinel_event: auto_sentinel, fl_ahca_reportable: auto_ahca });
    res.status(201).json({ id, report_number, success: true });
  });

  /* ── UPDATE ─────────────────────────────────────────────── */
  app.put('/api/incidents/:id(\\d+)', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT * FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });

    const newStatus   = req.body.status || inc.status;
    const reviewedAt  = req.body.reviewed_by && inc.reviewed_by !== req.body.reviewed_by ? new Date().toISOString() : inc.reviewed_at;
    const closedAt    = newStatus === 'closed' && inc.status !== 'closed' ? new Date().toISOString() : inc.closed_at;

    // Build update from INC_FIELDS
    const sets = []; const vals = [];
    for (const f of INC_FIELDS) {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=?`);
        // Coerce booleans
        const bools = ['osha_recordable','patient_involved','sentinel_event','fl_ahca_reportable','hipaa_breach','follow_up_required','risk_manager_notified','physician_notified','family_notified','admin_notified','law_enforcement_notified','dcf_reported'];
        vals.push(bools.includes(f) ? (req.body[f] ? 1 : 0) : (req.body[f] || null));
      }
    }
    sets.push('status=?', 'reviewed_at=?', 'closed_at=?', 'updated_at=?');
    vals.push(newStatus, reviewedAt, closedAt, new Date().toISOString(), req.params.id);

    dbRun(`UPDATE incident_reports SET ${sets.join(',')} WHERE id=?`, vals);

    if (Array.isArray(req.body.involved)) {
      dbRun('DELETE FROM incident_involved WHERE incident_id=?', [req.params.id]);
      for (const party of req.body.involved) {
        dbRun('INSERT INTO incident_involved (incident_id, employee_id, employee_name, role) VALUES (?,?,?,?)',
          [req.params.id, party.employee_id||null, party.employee_name||null, party.role||null]);
      }
    }

    audit(req, 'UPDATE_INCIDENT', 'incident_reports', Number(req.params.id), { status: newStatus });
    res.json({ success: true });
  });

  /* ── ADD NOTIFICATION ───────────────────────────────────── */
  app.post('/api/incidents/:id(\\d+)/notifications', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT id FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const { notified_party, notified_at, method, notes } = req.body;
    if (!notified_party) return res.status(400).json({ error: 'notified_party is required' });
    dbRun(
      'INSERT INTO incident_notifications (incident_id, notified_party, notified_at, method, notified_by, notes) VALUES (?,?,?,?,?,?)',
      [req.params.id, notified_party, notified_at || new Date().toISOString(), method||null, req.user.username, notes||null]
    );
    audit(req, 'INCIDENT_NOTIFICATION', 'incident_reports', Number(req.params.id), { notified_party });
    res.status(201).json({ success: true });
  });

  /* ── DELETE (manager+) ──────────────────────────────────── */
  app.delete('/api/incidents/:id(\\d+)', auth, managerOrAdmin, (req, res) => {
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
    const ytd       = dbGet("SELECT COUNT(*) as n FROM incident_reports WHERE incident_date >= date('now','start of year')").n;
    const sentinel  = dbGet("SELECT COUNT(*) as n FROM incident_reports WHERE sentinel_event=1").n;
    const ahca_due  = dbGet("SELECT COUNT(*) as n FROM incident_reports WHERE fl_ahca_reportable=1 AND (fl_ahca_reported_date IS NULL OR fl_ahca_reported_date='')").n;
    const byType    = dbAll("SELECT type, COUNT(*) as n FROM incident_reports GROUP BY type ORDER BY n DESC");
    res.json({ total, open, osha, ytd, sentinel, ahca_due, byType });
  });

  /* ── PRINT ───────────────────────────────────────────────── */
  app.get('/api/incidents/:id(\\d+)/print', auth, editorOrAbove, (req, res) => {
    const inc = dbGet('SELECT * FROM incident_reports WHERE id=?', [req.params.id]);
    if (!inc) return res.status(404).send('Incident not found');

    const involved      = dbAll('SELECT * FROM incident_involved      WHERE incident_id=? ORDER BY id',      [inc.id]);
    const notifications = dbAll('SELECT * FROM incident_notifications WHERE incident_id=? ORDER BY notified_at', [inc.id]);

    const orgRow  = dbGet("SELECT value FROM app_settings WHERE key='org_name'");
    const addrRow = dbGet("SELECT value FROM app_settings WHERE key='org_address'");
    const orgName = orgRow?.value  || 'Healthcare Facility';
    const orgAddr = addrRow?.value || '';

    audit(req, 'PRINT_INCIDENT', 'incident_reports', Number(req.params.id),
      { report_number: inc.report_number, printed_by: req.user.username });

    function row(label, value) {
      return `<tr><td class="lbl">${escapeHtml(label)}</td><td>${escapeHtml(String(value ?? '—'))}</td></tr>`;
    }
    function rowHtml(label, value) {
      return `<tr><td class="lbl">${escapeHtml(label)}</td><td>${value || '—'}</td></tr>`;
    }
    function section(title) {
      return `<tr><td colspan="2" class="sec">${escapeHtml(title)}</td></tr>`;
    }
    function flag(val, label) {
      return val ? `<span class="flag-yes">${escapeHtml(label)}</span>` : '';
    }

    const flags = [
      flag(inc.osha_recordable,          'OSHA Recordable'),
      flag(inc.sentinel_event,            'Sentinel Event'),
      flag(inc.fl_ahca_reportable,        'FL AHCA Reportable'),
      flag(inc.hipaa_breach,              'HIPAA Breach'),
      flag(inc.patient_involved,          'Patient Involved'),
      flag(inc.dcf_reported,              'DCF Reported'),
    ].filter(Boolean).join(' ');

    const invHtml = involved.length
      ? involved.map(i => `${escapeHtml(i.employee_name || `Employee #${i.employee_id}`)}&nbsp;(${escapeHtml(i.role||'involved')})`).join('<br>')
      : '—';

    const notifHtml = notifications.length
      ? `<table class="notif-table"><thead><tr><th>Party</th><th>Date/Time</th><th>Method</th><th>By</th><th>Notes</th></tr></thead><tbody>
          ${notifications.map(n => `<tr>
            <td>${escapeHtml(n.notified_party)}</td>
            <td>${escapeHtml(n.notified_at?.slice(0,16)||'')}</td>
            <td>${escapeHtml(n.method||'')}</td>
            <td>${escapeHtml(n.notified_by||'')}</td>
            <td>${escapeHtml(n.notes||'')}</td>
          </tr>`).join('')}
        </tbody></table>`
      : '<p style="font-style:italic;color:#666">No notifications logged</p>';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Incident Report — ${escapeHtml(inc.report_number)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#111;background:#fff;padding:24px 32px}
  .privilege-banner{background:#1a1a1a;color:#fff;text-align:center;padding:7px;font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;margin-bottom:14px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1a3c2a;padding-bottom:10px;margin-bottom:12px}
  .org-name{font-size:16px;font-weight:700;color:#1a3c2a}
  .org-addr{font-size:10px;color:#555;margin-top:3px}
  .report-id{text-align:right}
  .report-num{font-size:20px;font-weight:700;color:#1a3c2a;line-height:1}
  .report-label{font-size:9px;text-transform:uppercase;letter-spacing:.8px;color:#888;margin-top:2px}
  .flags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
  .flag-yes{background:#b83232;color:#fff;padding:3px 9px;border-radius:12px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
  .flag-yes.green{background:#1a5c30}
  table.main{width:100%;border-collapse:collapse;margin-bottom:16px}
  table.main td{padding:5px 8px;border:1px solid #d0d0d0;vertical-align:top;line-height:1.4}
  table.main td.lbl{background:#f4f4f4;font-weight:700;width:28%;white-space:nowrap;color:#333;font-size:10px;text-transform:uppercase;letter-spacing:.3px}
  table.main td.sec{background:#1a3c2a;color:#fff;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.6px;padding:6px 8px}
  .notif-table{width:100%;border-collapse:collapse;font-size:10px;margin-top:6px}
  .notif-table th{background:#eee;padding:4px 6px;border:1px solid #ccc;text-align:left;font-size:9px;text-transform:uppercase;letter-spacing:.4px}
  .notif-table td{padding:4px 6px;border:1px solid #ddd}
  .signatures{margin-top:28px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px}
  .sig-block{border-top:1px solid #222;padding-top:6px}
  .sig-label{font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:#555;margin-top:4px}
  .sig-line{height:36px}
  .footer{margin-top:20px;border-top:1px solid #ccc;padding-top:8px;font-size:9px;color:#777;text-align:center;line-height:1.6}
  .page-break{page-break-before:always}
  @media print{
    body{padding:12px 20px}
    .no-print{display:none}
    @page{size:letter portrait;margin:0.75in 0.5in}
  }
  .print-btn{position:fixed;top:16px;right:16px;padding:9px 18px;background:#1a3c2a;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit}
  .print-btn:hover{opacity:.85}
</style>
</head>
<body>

<button class="print-btn no-print" onclick="window.print()">🖨 Print</button>

<div class="privilege-banner">
  CONFIDENTIAL — PRIVILEGED &amp; PROTECTED — Quality Assurance / Risk Management Document<br>
  Protected under FL §395.0197(4) &amp; §766.101 — Not Discoverable or Admissible in Civil Litigation
</div>

<div class="header">
  <div>
    <div class="org-name">${escapeHtml(orgName)}</div>
    ${orgAddr ? `<div class="org-addr">${escapeHtml(orgAddr)}</div>` : ''}
    <div style="font-size:12px;font-weight:700;margin-top:8px">INCIDENT / OCCURRENCE REPORT</div>
  </div>
  <div class="report-id">
    <div class="report-num">${escapeHtml(inc.report_number)}</div>
    <div class="report-label">Report Number</div>
    <div style="margin-top:8px;font-size:10px;color:#555">
      Report Date: <strong>${escapeHtml(inc.report_date||'')}</strong><br>
      Status: <strong>${escapeHtml((inc.status||'').replace(/_/g,' ').toUpperCase())}</strong><br>
      Reported By: <strong>${escapeHtml(inc.reported_by||'')}</strong>
    </div>
  </div>
</div>

${flags ? `<div class="flags">${flags}</div>` : ''}

<table class="main">
  ${section('Incident Details')}
  ${row('Incident Date', fmtDateTime(inc.incident_date, inc.incident_time))}
  ${row('Location', inc.location)}
  ${row('Type', (inc.type||'').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()))}
  ${row('Severity', inc.severity ? inc.severity.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : null)}
  ${row('Description', inc.description)}
  ${row('Immediate Action Taken', inc.immediate_action)}

  ${section('Patient / Client Involvement')}
  ${row('Patient Involved', yn(inc.patient_involved))}
  ${row('Patient Identifier (Unit/Room/ID — de-identified)', inc.patient_identifier)}
  ${row('Injury Type', inc.injury_type)}
  ${row('Body Part Affected', inc.body_part)}
  ${row('Treatment Required', inc.treatment ? inc.treatment.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()) : null)}

  ${section('Involved Parties & Witnesses')}
  ${rowHtml('Involved Staff/Individuals', invHtml)}
  ${row('Witnesses', inc.witnesses)}

  ${section('OSHA Recordkeeping (29 CFR §1904)')}
  ${row('OSHA Recordable', yn(inc.osha_recordable))}
  ${row('OSHA Case Number', inc.osha_case_number)}
  ${row('Days Away from Work', inc.days_away ?? 0)}
  ${row('Days Job Transfer / Restriction', inc.days_restricted ?? 0)}

  ${inc.type === 'medication_error' || inc.medication_name ? `
  ${section('Medication Error Details (NCC MERP)')}
  ${row('Medication Name', inc.medication_name)}
  ${row('Dose', inc.medication_dose)}
  ${row('Route', inc.medication_route)}
  ` : ''}

  ${inc.equipment_involved ? `
  ${section('Equipment / Device Involved (Potential FDA MDR)')}
  ${row('Equipment / Device', inc.equipment_involved)}
  ` : ''}

  ${section('Regulatory Reporting')}
  ${row('FL AHCA Reportable (§395.0197 — 15-day window)', yn(inc.fl_ahca_reportable))}
  ${row('FL AHCA Reported Date', inc.fl_ahca_reported_date)}
  ${row('Sentinel Event (Joint Commission)', yn(inc.sentinel_event))}
  ${row('HIPAA Breach', yn(inc.hipaa_breach))}
  ${row('HIPAA Breach Notification Date', inc.hipaa_breach_date)}
  ${row('DCF Report Filed (§39.201 — 24h window)', yn(inc.dcf_reported))}
  ${row('DCF Report Date', inc.dcf_reported_date)}

  ${section('Root Cause Analysis & Corrective Action')}
  ${row('Contributing Factors', inc.contributing_factors)}
  ${row('Root Cause Analysis', inc.root_cause)}
  ${row('Corrective Action Plan', inc.corrective_action)}
  ${row('Follow-Up Required', yn(inc.follow_up_required))}
  ${row('Follow-Up Due Date', inc.follow_up_date)}
  ${row('Follow-Up Assigned To', inc.follow_up_by)}

  ${section('Review')}
  ${row('Reviewed By', inc.reviewed_by)}
  ${row('Reviewed At', inc.reviewed_at?.slice(0,16))}
  ${row('Closed At', inc.closed_at?.slice(0,16))}
</table>

<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#1a3c2a;margin-bottom:6px">Notification Log</div>
${notifHtml}

<div class="signatures">
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Reporter Signature</div>
    <div style="margin-top:8px;font-size:9px">Date: _______________</div>
  </div>
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Supervisor / Manager Signature</div>
    <div style="margin-top:8px;font-size:9px">Date: _______________</div>
  </div>
  <div class="sig-block">
    <div class="sig-line"></div>
    <div class="sig-label">Risk Manager / QA Signature</div>
    <div style="margin-top:8px;font-size:9px">Date: _______________</div>
  </div>
</div>

<div class="footer">
  <strong>CONFIDENTIAL — PEER REVIEW / QUALITY ASSURANCE DOCUMENT</strong><br>
  This document is prepared for and directed to the Quality Assurance / Risk Management Committee of ${escapeHtml(orgName)}.<br>
  Protected from discovery and use as evidence under Florida Statute §395.0197(4) and §766.101.<br>
  Unauthorized disclosure is prohibited. Report Number: ${escapeHtml(inc.report_number)} | Printed: ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET
</div>

</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
};
