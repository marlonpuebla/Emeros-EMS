'use strict';
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const config = require('../config');
const { auth, adminOnly, audit } = require('../middleware/auth');

module.exports = function (app) {
  /* ═══════════════════════════════════════════════════════════
     FACILITY SETTINGS
  ═══════════════════════════════════════════════════════════ */

  // GET /api/settings — all settings as key-value object (any authenticated user)
  app.get('/api/settings', auth, (req, res) => {
    try {
      const { dbAll } = req.app.locals;
      const rows = dbAll('SELECT key, value FROM app_settings');
      const settings = {};
      for (const row of rows) settings[row.key] = row.value;
      res.json(settings);
    } catch (err) {
      console.error('[settings] GET error:', err);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  // GET /api/settings/public — org_name only, no auth (for login page branding)
  app.get('/api/settings/public', (req, res) => {
    try {
      const { dbGet } = req.app.locals;
      const row = dbGet("SELECT value FROM app_settings WHERE key = 'org_name'");
      res.json({ org_name: row ? row.value : 'Emeros EMS' });
    } catch (err) {
      console.error('[settings] GET public error:', err);
      res.status(500).json({ error: 'Failed to load public settings' });
    }
  });

  // PUT /api/settings — admin only, update key-value pairs
  app.put('/api/settings', auth, adminOnly, (req, res) => {
    try {
      const { dbRun } = req.app.locals;
      const updates = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Body must be a key-value object' });
      }
      const keys = Object.keys(updates);
      for (const key of keys) {
        dbRun(
          "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          [key, updates[key]]
        );
      }
      audit(req, 'SETTINGS_UPDATE', 'app_settings', null, { keys });
      res.json({ ok: true, updated: keys });
    } catch (err) {
      console.error('[settings] PUT error:', err);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  /* ═══════════════════════════════════════════════════════════
     USER SELF-SERVICE
  ═══════════════════════════════════════════════════════════ */

  // GET /api/me/profile — own user info
  app.get('/api/me/profile', auth, (req, res) => {
    try {
      const { dbGet } = req.app.locals;
      const user = dbGet(
        'SELECT id, username, role, display_name, active, created_at FROM users WHERE id = ?',
        [req.user.id]
      );
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) {
      console.error('[profile] GET error:', err);
      res.status(500).json({ error: 'Failed to load profile' });
    }
  });

  // PUT /api/me/profile — update own display_name only
  app.put('/api/me/profile', auth, (req, res) => {
    try {
      const { dbRun } = req.app.locals;
      const { display_name } = req.body;
      if (display_name === undefined) {
        return res.status(400).json({ error: 'display_name is required' });
      }
      dbRun(
        "UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?",
        [display_name, req.user.id]
      );
      audit(req, 'UPDATE_PROFILE', 'users', req.user.id, { display_name });
      res.json({ ok: true });
    } catch (err) {
      console.error('[profile] PUT error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  /* ═══════════════════════════════════════════════════════════
     MICROSOFT OAUTH
  ═══════════════════════════════════════════════════════════ */

  // GET /api/auth/microsoft — redirect to Microsoft login
  app.get('/api/auth/microsoft', (req, res) => {
    try {
      const { dbGet } = req.app.locals;
      const clientIdRow = dbGet("SELECT value FROM app_settings WHERE key = 'ms_client_id'");
      const tenantRow   = dbGet("SELECT value FROM app_settings WHERE key = 'ms_tenant_id'");

      const clientId = clientIdRow?.value;
      const tenant   = tenantRow?.value || 'common';

      if (!clientId) {
        return res.status(400).json({ error: 'Microsoft OAuth is not configured. Set ms_client_id in settings.' });
      }

      const state       = crypto.randomBytes(16).toString('hex');
      const redirectUri = `https://${req.get('host')}/api/auth/microsoft/callback`;

      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         'openid profile email',
        state:         state,
      });

      const authUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params.toString()}`;
      res.redirect(authUrl);
    } catch (err) {
      console.error('[ms-oauth] Redirect error:', err);
      res.status(500).json({ error: 'Microsoft OAuth error' });
    }
  });

  // GET /api/auth/microsoft/callback — handle OAuth callback
  app.get('/api/auth/microsoft/callback', async (req, res) => {
    try {
      const { dbGet } = req.app.locals;
      const { code, error: oauthError } = req.query;

      if (oauthError) {
        return res.status(400).send(`<h2>Microsoft login failed</h2><p>${oauthError}</p><p><a href="/">Back to login</a></p>`);
      }
      if (!code) {
        return res.status(400).send('<h2>Missing authorization code</h2><p><a href="/">Back to login</a></p>');
      }

      const clientIdRow = dbGet("SELECT value FROM app_settings WHERE key = 'ms_client_id'");
      const tenantRow   = dbGet("SELECT value FROM app_settings WHERE key = 'ms_tenant_id'");
      const clientId    = clientIdRow?.value;
      const tenant      = tenantRow?.value || 'common';
      const clientSecret = process.env.MS_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(500).send('<h2>Microsoft OAuth not fully configured</h2><p><a href="/">Back to login</a></p>');
      }

      const redirectUri = `https://${req.get('host')}/api/auth/microsoft/callback`;
      const tokenUrl    = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

      // Exchange code for token
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id:     clientId,
          client_secret: clientSecret,
          code:          code,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
        }).toString(),
      });

      const tokenData = await tokenRes.json();

      if (!tokenData.id_token) {
        console.error('[ms-oauth] No id_token in response:', tokenData);
        return res.status(400).send('<h2>Microsoft login failed</h2><p>No identity token received.</p><p><a href="/">Back to login</a></p>');
      }

      // Decode id_token payload (base64, no signature verification)
      const parts   = tokenData.id_token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      const email   = payload.preferred_username || payload.email || '';
      const name    = payload.name || '';

      if (!email) {
        return res.status(400).send('<h2>No email found in Microsoft account</h2><p><a href="/">Back to login</a></p>');
      }

      // Match user by email prefix
      const emailPrefix = email.split('@')[0].toLowerCase();
      const user = dbGet('SELECT * FROM users WHERE LOWER(username) = ?', [emailPrefix]);

      if (!user || !user.active) {
        audit(req, 'LOGIN_MICROSOFT', 'users', null, { email, status: 'no_account' });
        return res.status(403).send(
          '<h2>No EMS account found for this email. Contact your administrator.</h2>' +
          `<p>Microsoft account: ${email}</p>` +
          '<p><a href="/">Back to login</a></p>'
        );
      }

      // Issue JWT same as normal login
      const jti   = crypto.randomUUID();
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role,
          displayName: user.display_name || user.username, jti },
        config.JWT_SECRET, { expiresIn: '8h' }
      );

      req.user = { id: user.id, username: user.username };
      audit(req, 'LOGIN_MICROSOFT', 'users', user.id, { email, name });

      // Redirect to SPA with token in hash (client picks it up)
      res.redirect(`/#/auth/callback?token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error('[ms-oauth] Callback error:', err);
      res.status(500).send('<h2>Microsoft login error</h2><p>An unexpected error occurred.</p><p><a href="/">Back to login</a></p>');
    }
  });
};
