'use strict';
/**
 * Emeros — HR Email & Credentialing Module
 *
 * Email:   Nodemailer — Microsoft 365 SMTP
 * Verify:  NPPES CMS API (NPI) + Florida DOH API (FL licenses)
 *
 * ─── MICROSOFT 365 SETUP ────────────────────────────────────────
 *
 * OPTION A — Shared Mailbox (recommended for noreply@):
 *   1. In M365 Admin: create shared mailbox noreply@your-domain.com
 *   2. Grant your admin account "Send As" permission on that mailbox
 *   3. Enable Authenticated SMTP on the shared mailbox
 *   systemd vars:
 *     SMTP_HOST=smtp.office365.com
 *     SMTP_PORT=587
 *     SMTP_USER=noreply@your-domain.com     ← the shared mailbox
 *     SMTP_PASS=its-password-or-app-password
 *     HR_FROM_EMAIL=noreply@your-domain.com
 *     HR_FROM_NAME=Emeros — HR
 *     HR_ADMIN_EMAIL=admin@your-domain.com
 *
 * OPTION B — Send from your account, display as noreply:
 *   systemd vars:
 *     SMTP_HOST=smtp.office365.com
 *     SMTP_PORT=587
 *     SMTP_USER=admin@your-domain.com      ← your M365 account
 *     SMTP_PASS=your-password-or-app-password
 *     HR_FROM_EMAIL=noreply@your-domain.com ← display address
 *     HR_FROM_NAME=Emeros — HR
 *     HR_ADMIN_EMAIL=admin@your-domain.com
 *   NOTE: M365 forces From == SMTP_USER. The display name will show
 *         "Emeros — HR" but the actual sender
 *         address will be your account. This is normal M365 behavior.
 *
 * ─── ALL 11 CREDENTIAL EXPIRATION REMINDERS ─────────────────────
 *   Sent automatically at 90 / 60 / 30 / 7 days before expiration:
 *   1.  Professional License
 *   2.  DEA Certificate
 *   3.  FL Driver License
 *   4.  AHCA Background Screening
 *   5.  Professional Liability Insurance
 *   6.  CEU (Continuing Education)
 *   7.  CPR/BLS Certification
 *   8.  Passport
 *   9.  I-9 Employment Eligibility
 *   10. Worker's Comp Exemption
 *   11. Yearly Performance Evaluation
 */

const nodemailer = require('nodemailer');
const axios      = require('axios');

/* ─────────────────────────────────────────────────────────────
   ALL 11 CREDENTIAL FIELDS — single source of truth
───────────────────────────────────────────────────────────── */
const CRED_LABELS = {
  license_expiration:                'Professional License',
  dea_expiration:                    'DEA Certificate',
  driver_license_expiration:         'FL Driver License',
  ahca_background_expiration:        'AHCA Background Screening',
  professional_liability_expiration: 'Professional Liability Insurance',
  ceu_expiration:                    'CEU (Continuing Education)',
  cpr_bls_expiration:                'CPR/BLS Certification',
  passport_expiration:               'Passport',
  i9_expiration:                     'I-9 Employment Eligibility',
  exemption_worker_comp_expiration:  "Worker's Comp Exemption",
  yearly_evaluation_due:             'Yearly Performance Evaluation',
};

/* ─────────────────────────────────────────────────────────────
   TRANSPORT
───────────────────────────────────────────────────────────── */
function getProvider() {
  if (process.env.SENDGRID_KEY) return 'sendgrid';
  const h = (process.env.SMTP_HOST || '').toLowerCase();
  if (h.includes('office365') || h.includes('outlook.com') || h.includes('microsoft'))
    return 'microsoft365';
  if (h.includes('gmail'))  return 'gmail';
  if (process.env.SMTP_USER) return 'smtp';
  return 'none';
}

function createTransport() {
  const p = getProvider();

  if (p === 'sendgrid') {
    return nodemailer.createTransport({
      host: 'smtp.sendgrid.net', port: 587, secure: false,
      auth: { user: 'apikey', pass: process.env.SENDGRID_KEY },
    });
  }

  if (p === 'microsoft365') {
    return nodemailer.createTransport({
      host:       'smtp.office365.com',
      port:       587,
      secure:     false,
      requireTLS: true,
      tls:        { ciphers: 'SSLv3', rejectUnauthorized: true },
      auth:       { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  // Generic SMTP
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '' },
  });
}

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
// M365 enforces From == authenticated SMTP_USER unless using Send-As on shared mailbox
// We always show the friendly name; actual From address follows M365 rules
const FROM_NAME   = process.env.HR_FROM_NAME   || 'Emeros — HR';
const ADMIN_EMAIL = process.env.HR_ADMIN_EMAIL || process.env.SMTP_USER || '';
const ORG_NAME    = 'Emeros';
const EMAIL_ENABLED = !!(process.env.SENDGRID_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS));

function FROM_EMAIL() {
  // M365: From must match SMTP_USER unless shared mailbox with Send-As
  const provider = getProvider();
  const configured = process.env.HR_FROM_EMAIL || 'noreply@your-domain.com';
  if (provider === 'microsoft365' && process.env.SMTP_USER) {
    // If SMTP_USER IS the noreply mailbox, use it directly
    // If SMTP_USER is a different account, M365 will override From anyway
    // Either way, use SMTP_USER as the technical From
    return process.env.SMTP_USER;
  }
  return configured;
}

/* ─────────────────────────────────────────────────────────────
   HTML EMAIL TEMPLATE
───────────────────────────────────────────────────────────── */
function htmlWrap(title, body, footer = '') {
  const fromAddr = process.env.HR_FROM_EMAIL || 'noreply@your-domain.com';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{margin:0;padding:0;background:#f0ede8;font-family:'Helvetica Neue',Arial,sans-serif;font-size:14px;color:#1a1714}
  .wrap{max-width:620px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  .hdr{background:linear-gradient(135deg,#1a2f26,#1e4d3b);padding:28px 32px;color:#fff}
  .hdr-org{font-size:10px;text-transform:uppercase;letter-spacing:2px;opacity:.6;margin-bottom:6px}
  .hdr-title{font-size:22px;font-weight:600;line-height:1.3}
  .body{padding:32px}
  .body p{margin:0 0 16px;line-height:1.7;color:#1a1714}
  .highlight{background:#e8f0ec;border-left:4px solid #1e4d3b;padding:14px 18px;border-radius:0 6px 6px 0;margin:20px 0;font-size:13.5px;line-height:1.8}
  .highlight strong{display:block;margin-bottom:6px;color:#1e4d3b;font-size:11px;text-transform:uppercase;letter-spacing:.8px}
  .table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
  .table th{background:#f7f5f2;padding:9px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#6b6560;border-bottom:1px solid #e2ddd8}
  .table td{padding:10px 12px;border-bottom:1px solid #f0ede8;vertical-align:middle;color:#1a1714}
  .table tr:last-child td{border-bottom:none}
  .badge-warn{background:#fdf6ec;color:#c27820;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700}
  .badge-danger{background:#fdf0f0;color:#b83232;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700}
  .badge-ok{background:#edf7f1;color:#2d7a47;padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700}
  .sig{margin-top:28px;padding-top:20px;border-top:1px solid #e2ddd8;font-size:13px;color:#6b6560;line-height:1.8}
  .ftr{background:#f7f5f2;padding:18px 32px;font-size:11px;color:#9e9892;line-height:1.6;border-top:1px solid #e2ddd8}
  a{color:#1e4d3b}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="hdr-org">${ORG_NAME}</div>
    <div class="hdr-title">${title}</div>
  </div>
  <div class="body">
    ${body}
    <div class="sig">
      <strong>Human Resources Department</strong><br>
      ${ORG_NAME}<br>
      <a href="mailto:${fromAddr}">${fromAddr}</a>
    </div>
  </div>
  ${footer ? `<div class="ftr">${footer}</div>` : ''}
</div>
</body>
</html>`;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  catch { return d; }
}

/* ─────────────────────────────────────────────────────────────
   SEND HELPER
───────────────────────────────────────────────────────────── */
async function sendEmail(to, subject, html, cc) {
  if (!EMAIL_ENABLED) {
    console.log(`[Email SKIPPED — no SMTP config] To: ${to} | Subject: ${subject}`);
    return { skipped: true };
  }
  const transport = createTransport();
  const result = await transport.sendMail({
    from:    `"${FROM_NAME}" <${FROM_EMAIL()}>`,
    to,
    cc:      cc || undefined,
    subject,
    html,
  });
  console.log(`[Email SENT] To: ${to} | Subject: ${subject} | ID: ${result.messageId}`);
  return result;
}

/* ─────────────────────────────────────────────────────────────
   1. WELCOME EMAIL
───────────────────────────────────────────────────────────── */
async function sendWelcomeEmail(employee) {
  const name = `${employee.first_name} ${employee.last_name}`;
  const typeLabel = employee.employment_type === 'contracted' ? 'Independent Contractor'
                  : employee.employment_type === 'subcontractor' ? 'Subcontractor' : 'Employee';

  const html = htmlWrap('Welcome to the Team!', `
    <p>Dear <strong>${name}</strong>,</p>
    <p>On behalf of everyone at <strong>${ORG_NAME}</strong>, welcome to our team! We're excited to have you join us as <strong>${employee.position_om || employee.position_ahca || 'a valued team member'}</strong>.</p>
    <div class="highlight">
      <strong>Your Employment Details</strong>
      Position: ${employee.position_om || employee.position_ahca || '—'}<br>
      Start Date: ${fmtDate(employee.employment_date)}<br>
      Type: ${typeLabel}<br>
      Schedule: ${(employee.schedule_type || 'full-time').charAt(0).toUpperCase() + (employee.schedule_type || 'full-time').slice(1)}
      ${employee.supervisor ? `<br>Supervisor: ${employee.supervisor}` : ''}
    </div>
    <p>Please ensure all your credentialing documents are submitted to HR promptly. Our team will be in touch with further details about your onboarding.</p>
    <p>If you have any questions, don't hesitate to reach out.</p>
    <p>We look forward to working with you!</p>
  `, `This is an automated message from the ${ORG_NAME} HR system. Please do not reply to this email.`);

  return sendEmail(employee.email, `Welcome to ${ORG_NAME}!`, html, ADMIN_EMAIL || undefined);
}

/* ─────────────────────────────────────────────────────────────
   2. CREDENTIAL EXPIRATION REMINDER (all 11 fields)
───────────────────────────────────────────────────────────── */
async function sendCredentialReminder(employee, expiringFields, daysUntil) {
  const name    = `${employee.first_name} ${employee.last_name}`;
  const expired = daysUntil < 0;
  const urgent  = daysUntil <= 7;
  const prefix  = expired ? 'EXPIRED: ' : urgent ? 'URGENT — ' : daysUntil <= 30 ? 'Action Required: ' : '';

  const rows = expiringFields.map(([field, date]) => {
    const days = Math.ceil((new Date(date) - new Date(new Date().toISOString().split('T')[0])) / 86400000);
    const badge = days < 0 ? 'badge-danger'
                : days <= 7 ? 'badge-danger'
                : days <= 30 ? 'badge-warn' : 'badge-warn';
    const label = days < 0 ? `Expired ${Math.abs(days)}d ago`
                : days === 0 ? 'Expires today!'
                : `${days} day${days !== 1 ? 's' : ''} remaining`;
    return `<tr>
      <td><strong>${CRED_LABELS[field] || field}</strong></td>
      <td>${fmtDate(date)}</td>
      <td><span class="${badge}">${label}</span></td>
    </tr>`;
  }).join('');

  const html = htmlWrap(`${prefix}Credential Renewal Required`, `
    <p>Dear <strong>${name}</strong>,</p>
    <p>${expired
      ? 'The following credential(s) on file have <strong style="color:#b83232">expired</strong> and require immediate action to remain compliant.'
      : `This is a reminder that the following credential(s) on your file will expire within <strong>${daysUntil} day${daysUntil !== 1 ? 's' : ''}</strong>.`
    }</p>
    <table class="table">
      <thead><tr><th>Credential</th><th>Expiration Date</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="highlight">
      <strong>What to do next</strong>
      Please renew the above credential(s) immediately and submit updated documentation to HR.<br>
      You can email your updated documents to: <a href="mailto:${ADMIN_EMAIL || 'noreply@your-domain.com'}">${ADMIN_EMAIL || 'noreply@your-domain.com'}</a>
    </div>
    <p>Failure to maintain valid credentials may affect your ability to continue working. Please contact HR if you have any questions or need assistance.</p>
  `, `This is an automated credential reminder from the ${ORG_NAME} HR system. Please do not reply to this email.`);

  const results = [];
  const subj = `${prefix}Credential Renewal — ${name}`;
  if (employee.email) results.push(await sendEmail(employee.email, subj, html));
  if (ADMIN_EMAIL)    results.push(await sendEmail(ADMIN_EMAIL, `[HR ALERT] ${subj} (${daysUntil < 0 ? 'EXPIRED' : daysUntil + 'd'})`, html));
  return results;
}

/* ─────────────────────────────────────────────────────────────
   3. TERMINATION LETTER
───────────────────────────────────────────────────────────── */
async function sendTerminationLetter(employee, options = {}) {
  const name     = `${employee.first_name} ${employee.last_name}`;
  const termDate = options.termination_date || employee.termination_date;
  const reason   = options.reason || '';

  const html = htmlWrap('Notice of Employment Separation', `
    <p>Dear <strong>${name}</strong>,</p>
    <p>This letter serves as formal notification that your employment with <strong>${ORG_NAME}</strong> as <strong>${employee.position_om || employee.position_ahca || 'Staff Member'}</strong> has been separated, effective <strong>${fmtDate(termDate)}</strong>.</p>
    ${reason ? `<div class="highlight"><strong>Reason for Separation</strong>${reason}</div>` : ''}
    <p>Please be advised of the following:</p>
    <table class="table">
      <tr><td>Final paycheck</td><td>Will be processed in accordance with Florida state law</td></tr>
      <tr><td>Company property</td><td>Must be returned immediately upon separation</td></tr>
      <tr><td>System access</td><td>Has been or will be revoked effective the separation date</td></tr>
      <tr><td>COBRA coverage</td><td>Information will be mailed separately if applicable</td></tr>
      <tr><td>Unemployment benefits</td><td>You may be eligible — contact the Florida DEO</td></tr>
    </table>
    <p>For any questions regarding this separation, please contact HR at <a href="mailto:${ADMIN_EMAIL || 'noreply@your-domain.com'}">${ADMIN_EMAIL || 'noreply@your-domain.com'}</a>.</p>
    <p>We wish you the best in your future endeavors.</p>
  `, `This is an official HR communication from ${ORG_NAME}. Please retain a copy for your records.`);

  return sendEmail(employee.email, `Notice of Employment Separation — ${ORG_NAME}`, html, ADMIN_EMAIL || undefined);
}

/* ─────────────────────────────────────────────────────────────
   4. OFFER LETTER
───────────────────────────────────────────────────────────── */
async function sendOfferLetter(employee, options = {}) {
  const name       = `${employee.first_name} ${employee.last_name}`;
  const startDate  = options.start_date  || employee.employment_date;
  const salary     = options.salary      || '';
  const deadline   = options.deadline    || '';
  const typeLabel  = employee.employment_type === 'contracted' ? 'Independent Contractor'
                   : employee.employment_type === 'subcontractor' ? 'Subcontractor' : 'Employee';

  const html = htmlWrap('Offer of Employment', `
    <p>Dear <strong>${name}</strong>,</p>
    <p>We are pleased to extend this offer of employment with <strong>${ORG_NAME}</strong>. After careful consideration, we believe you will be a valuable addition to our team.</p>
    <div class="highlight">
      <strong>Offer Details</strong>
      Position: ${employee.position_om || employee.position_ahca || '—'}<br>
      AHCA Classification: ${employee.position_ahca || '—'}<br>
      Start Date: ${fmtDate(startDate)}<br>
      Employment Type: ${typeLabel}<br>
      Schedule: ${(employee.schedule_type || 'full-time').charAt(0).toUpperCase() + (employee.schedule_type || 'full-time').slice(1)}
      ${salary ? `<br>Compensation: ${salary}` : ''}
      ${employee.supervisor ? `<br>Reports To: ${employee.supervisor}` : ''}
    </div>
    <p><strong>To accept this offer</strong>, please reply to this email confirming your acceptance${deadline ? ` by <strong>${fmtDate(deadline)}</strong>` : ''}.</p>
    <p>Prior to your start date, please have the following ready:</p>
    <table class="table">
      <tr><td>✓</td><td>Valid government-issued photo ID</td></tr>
      <tr><td>✓</td><td>Social Security card or other I-9 acceptable documents</td></tr>
      <tr><td>✓</td><td>All applicable professional licenses and certifications</td></tr>
      <tr><td>✓</td><td>Completed new hire paperwork (to be sent separately)</td></tr>
    </table>
    <p>This offer is contingent upon successful completion of AHCA background screening and verification of all required credentials.</p>
    <p>We look forward to welcoming you to the ${ORG_NAME} family!</p>
  `, `This offer of employment is not a contract of employment. Employment is at-will unless otherwise stated in a written agreement.`);

  return sendEmail(employee.email, `Offer of Employment — ${ORG_NAME}`, html, ADMIN_EMAIL || undefined);
}

/* ─────────────────────────────────────────────────────────────
   5. WEEKLY ADMIN DIGEST
───────────────────────────────────────────────────────────── */
async function sendWeeklyDigest(stats, expiringList) {
  if (!ADMIN_EMAIL) {
    console.log('[Email] Weekly digest skipped — no HR_ADMIN_EMAIL set');
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const in7   = new Date(Date.now() +  7 * 86400000).toISOString().split('T')[0];
  const in30  = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  function makeRows(items) {
    return items.map(a => {
      const badge = a.days < 0 ? 'badge-danger' : a.days <= 7 ? 'badge-danger' : 'badge-warn';
      const label = a.days < 0 ? `EXPIRED ${Math.abs(a.days)}d ago` : `${a.days}d remaining`;
      return `<tr>
        <td><strong>${a.name}</strong></td>
        <td>${CRED_LABELS[a.field] || a.field}</td>
        <td>${fmtDate(a.date)}</td>
        <td><span class="${badge}">${label}</span></td>
      </tr>`;
    }).join('');
  }

  const critical  = expiringList.filter(a => a.date <= in7);
  const upcoming  = expiringList.filter(a => a.date > in7 && a.date <= in30);
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

  const html = htmlWrap(`Weekly HR Digest — ${dateLabel}`, `
    <p>Good morning. Here is your weekly HR summary for <strong>${dateLabel}</strong>.</p>
    <div class="highlight">
      <strong>Workforce at a Glance</strong>
      Total Employees: <strong>${stats.total}</strong> &nbsp;·&nbsp;
      Active: <strong>${stats.active}</strong> &nbsp;·&nbsp;
      Discharged: <strong>${stats.discharged}</strong>
    </div>

    ${critical.length ? `
    <p style="font-weight:700;color:#b83232;margin-bottom:8px">🔴 Expired or Expiring This Week (${critical.length})</p>
    <table class="table">
      <thead><tr><th>Employee</th><th>Credential</th><th>Date</th><th>Status</th></tr></thead>
      <tbody>${makeRows(critical)}</tbody>
    </table>` : `<p style="color:#2d7a47">✅ No credentials expiring this week.</p>`}

    ${upcoming.length ? `
    <p style="font-weight:700;color:#c27820;margin-top:20px;margin-bottom:8px">🟠 Expiring in the Next 30 Days (${upcoming.length})</p>
    <table class="table">
      <thead><tr><th>Employee</th><th>Credential</th><th>Date</th><th>Status</th></tr></thead>
      <tbody>${makeRows(upcoming)}</tbody>
    </table>` : ''}

    ${!critical.length && !upcoming.length ? '<p style="color:#2d7a47">✅ All credentials are current for the next 30 days.</p>' : ''}
  `, `This automated digest is sent every Monday at 7:00 AM ET by the ${ORG_NAME} HR system.`);

  return sendEmail(ADMIN_EMAIL, `[HR Weekly Digest] ${new Date().toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}`, html);
}

/* ─────────────────────────────────────────────────────────────
   CREDENTIAL VERIFICATION — NPI (NPPES CMS)
───────────────────────────────────────────────────────────── */
async function verifyNPI(npi, firstName, lastName) {
  if (!npi) return { verified: false, error: 'No NPI on file' };
  try {
    const { data } = await axios.get(
      `https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`,
      { timeout: 8000 }
    );
    if (!data.results?.length)
      return { verified: false, error: 'NPI not found in NPPES registry' };

    const result  = data.results[0];
    const basic   = result.basic || {};
    const regFirst = (basic.first_name || basic.authorized_official_first_name || '').toUpperCase();
    const regLast  = (basic.last_name  || basic.authorized_official_last_name  || '').toUpperCase();
    const expLast  = (lastName  || '').toUpperCase().split(' ')[0];
    const nameMatch = regLast.includes(expLast) || expLast.includes(regLast);
    const active    = (basic.status || '') === 'A';
    const taxonomies = (result.taxonomies || [])
      .filter(t => t.primary).map(t => `${t.desc || ''} (${t.code || ''})`).join(', ');

    return {
      verified:         nameMatch && active,
      npi,
      status:           active ? 'Active' : (basic.status || 'Unknown'),
      active,
      name_on_file:     `${regFirst} ${regLast}`.trim(),
      name_match:       nameMatch,
      taxonomy:         taxonomies || 'Not specified',
      enumeration_type: result.enumeration_type || '',
      last_updated:     basic.last_updated || '',
      source:           'NPPES CMS Registry',
      url:              `https://npiregistry.cms.hhs.gov/provider-view/${npi}`,
    };
  } catch (e) {
    return { verified: false, error: `NPPES lookup failed: ${e.message}` };
  }
}

/* ─────────────────────────────────────────────────────────────
   CREDENTIAL VERIFICATION — FL DOH License
───────────────────────────────────────────────────────────── */
async function verifyFLLicense(licenseNumber, firstName, lastName) {
  if (!licenseNumber) return { verified: false, error: 'No license number on file' };
  const manualUrl = `https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders?LicenseNumber=${encodeURIComponent(licenseNumber)}`;

  try {
    // Step 1: GET search page for CSRF token + session cookie
    const getResp  = await axios.get(
      'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders',
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }
    );
    const pageHtml = String(getResp.data || '');
    const csrfMatch = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!csrfMatch) throw new Error('Could not retrieve CSRF token from MQA portal');
    const csrfToken = csrfMatch[1];
    const cookieStr = (getResp.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

    // Step 2: POST the search form
    const params = new URLSearchParams();
    params.append('__RequestVerificationToken', csrfToken);
    params.append('SearchDto.LicenseNumber', licenseNumber.trim());
    params.append('SearchDto.LastName',      lastName  || '');
    params.append('SearchDto.FirstName',     firstName || '');
    params.append('SearchDto.Board',         '');
    params.append('SearchDto.Profession',    '');
    params.append('SearchDto.LicenseStatus', 'ALL');

    const postResp = await axios.post(
      'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders',
      params.toString(),
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':      'https://mqa-internet.doh.state.fl.us/MQASearchServices/HealthCareProviders',
          'Cookie':        cookieStr,
        },
        maxRedirects: 5,
      }
    );

    const html = String(postResp.data || '');

    // Step 3: Check if license number appears in the results
    // MQA shows "License Number: XXXX" as an <h3> on the detail page
    const licFound = html.toUpperCase().includes(licenseNumber.toUpperCase());
    if (!licFound) {
      return {
        verified:       false,
        license_number: licenseNumber,
        error:          'License not found in FL DOH MQA registry',
        manual_url:     manualUrl,
      };
    }

    // Step 4: Parse dt/dd pairs — MQA puts links and whitespace inside <dt> tags
    // so we strip tags first then match by text content
    function extractDd(html, label) {
      // Match <dt>..label..</dt> followed by <dd>..value..</dd> with generous whitespace/tag tolerance
      const re = new RegExp('<dt[^>]*>[\\s\\S]{0,500}?' + label + '[\\s\\S]{0,200}?<\\/dt>\\s*<dd[^>]*>([\\s\\S]{0,500}?)<\\/dd>', 'i');
      const m  = html.match(re);
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim() : '';
    }

    // Extract name from <h3>NAME</h3>
    const nameMatch = html.match(/<h3>([^<]+)<\/h3>/i);
    const nameRaw   = nameMatch ? nameMatch[1].trim() : '';
    // MQA shows "LAST FIRST" or "FIRST LAST" — try to detect from license number context
    // The h3 just before "License Number:" is the name
    const nameCtx   = html.match(/<h3>([^<]+)<\/h3>\s*<h3>License Number:/i);
    const fullName  = nameCtx ? nameCtx[1].trim() : nameRaw;

    // Extract profession/license type
    const profMatch = html.match(/Profession[^<]*<\/dt>\s*<dd>\s*([^<]+)/i);
    const licType   = profMatch ? profMatch[1].trim() : '';

    // Extract status, expiration, issue date using dt/dd pattern
    const status    = extractDd(html, 'License Status');
    const expDate   = extractDd(html, 'License Expiration Date');
    const issDate   = extractDd(html, 'License Original Issue Date');

    console.log(`[MQA] ${licenseNumber}: name="${fullName}" status="${status}" type="${licType}" exp="${expDate}" iss="${issDate}"`);

    // The license number was present in the page but the detail block didn't
    // parse — this happens when the MQA portal intermittently returns a stub /
    // results page instead of the full provider detail. Don't record a false
    // "unverified" for a valid license; fall back to manual verification.
    if (!status && !fullName) {
      return {
        verified:     null,
        license_number: licenseNumber,
        error:        'FL DOH returned an incomplete record (portal may be busy)',
        manual_url:   manualUrl,
        instructions: 'Please verify manually at the FL DOH MQA portal.',
      };
    }

    const active = status.toUpperCase().includes('CLEAR') ||
                   status.toUpperCase().includes('ACTIVE');

    return {
      verified:       active,
      license_number: licenseNumber,
      status,
      active,
      name_on_file:   fullName,
      license_type:   licType,
      license_state:  'FL',
      expiration:     expDate,
      issue_date:     issDate,
      source:         'Florida DOH MQA Registry',
      url:            manualUrl,
    };

  } catch (e) {
    console.warn(`[MQA] Lookup failed for ${licenseNumber}: ${e.message}`);
    return {
      verified:     null,
      error:        `FL DOH lookup unavailable: ${e.message}`,
      manual_url:   manualUrl,
      instructions: 'Please verify manually at the FL DOH MQA portal.',
    };
  }
}

/* ─────────────────────────────────────────────────────────────
   COMBINED VERIFY
───────────────────────────────────────────────────────────── */
async function verifyEmployee(employee) {
  const results = {};
  if (employee.npi)            results.npi     = await verifyNPI(employee.npi, employee.first_name, employee.last_name);
  if (employee.license_number) results.license = await verifyFLLicense(employee.license_number, employee.first_name, employee.last_name);
  return results;
}

/* ─────────────────────────────────────────────────────────────
   EXPORTS
───────────────────────────────────────────────────────────── */
module.exports = {
  sendWelcomeEmail,
  sendCredentialReminder,
  sendTerminationLetter,
  sendOfferLetter,
  sendWeeklyDigest,
  verifyNPI,
  verifyFLLicense,
  verifyEmployee,
  CRED_LABELS,
  EMAIL_ENABLED,
  getProvider,
};
