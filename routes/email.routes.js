'use strict';
const { auth, editorOrAbove, adminOnly, audit } = require('../middleware/auth');
const EC = require('../services/email.service');

module.exports = function (app) {
  const { dbGet } = app.locals;

  app.post('/api/email/welcome/:id', auth, editorOrAbove, async (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    if (!e.email) return res.status(400).json({ error: 'Employee has no email address on file' });
    try {
      await EC.sendWelcomeEmail(e);
      audit(req, 'EMAIL_WELCOME', 'employees', e.id, { to: e.email });
      res.json({ success: true, to: e.email, skipped: !EC.EMAIL_ENABLED });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/email/termination/:id', auth, editorOrAbove, async (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    if (!e.email) return res.status(400).json({ error: 'Employee has no email address on file' });
    try {
      await EC.sendTerminationLetter(e, req.body || {});
      audit(req, 'EMAIL_TERMINATION', 'employees', e.id, { to: e.email });
      res.json({ success: true, to: e.email, skipped: !EC.EMAIL_ENABLED });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/email/offer/:id', auth, editorOrAbove, async (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    if (!e.email) return res.status(400).json({ error: 'Employee has no email address on file' });
    try {
      await EC.sendOfferLetter(e, req.body || {});
      audit(req, 'EMAIL_OFFER_LETTER', 'employees', e.id, { to: e.email });
      res.json({ success: true, to: e.email, skipped: !EC.EMAIL_ENABLED });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/email/credential-reminder/:id', auth, editorOrAbove, async (req, res) => {
    const e = dbGet('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Employee not found' });
    if (!e.email) return res.status(400).json({ error: 'Employee has no email address on file' });

    const today = new Date().toISOString().split('T')[0];
    const in60  = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    const expiring = [];
    for (const field of Object.keys(EC.CRED_LABELS)) {
      const d = e[field];
      if (d && d <= in60) expiring.push([field, d]);
    }
    if (!expiring.length) return res.json({ success: true, message: 'No credentials expiring within 60 days', skipped: true });

    const minDays = Math.min(...expiring.map(([,d]) =>
      Math.ceil((new Date(d) - new Date(today)) / 86400000)));
    try {
      await EC.sendCredentialReminder(e, expiring, minDays);
      audit(req, 'EMAIL_CREDENTIAL_REMINDER', 'employees', e.id, { to: e.email, fields: expiring.map(f=>f[0]) });
      res.json({ success: true, to: e.email, credentials: expiring.length, skipped: !EC.EMAIL_ENABLED });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/email/test', auth, adminOnly, async (req, res) => {
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ error: 'Provide a "to" email address' });
    try {
      await EC.sendWelcomeEmail({
        first_name: 'HR Admin', last_name: '(Test)', email: to,
        position_om: 'Test Position', employment_date: new Date().toISOString().split('T')[0],
        employment_type: 'employee',
      });
      res.json({ success: true, message: `Test email sent to ${to}`, enabled: EC.EMAIL_ENABLED });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/email/status', auth, adminOnly, (_req, res) => {
    res.json({
      enabled:     EC.EMAIL_ENABLED,
      provider:    EC.getProvider(),
      from:        process.env.HR_FROM_EMAIL || process.env.SMTP_USER || 'noreply@your-domain.com',
      admin_email: process.env.HR_ADMIN_EMAIL || '(not set)',
      smtp_user:   process.env.SMTP_USER || '(not set)',
    });
  });
};
