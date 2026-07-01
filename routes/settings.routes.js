'use strict';
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const jwt    = require('jsonwebtoken');
const config = require('../config');
const { auth, adminOnly, managerOrAdmin, audit } = require('../middleware/auth');

const logoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `logo_${Date.now()}${ext}`);
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits:  { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'].includes(file.mimetype))
      return cb(null, true);
    cb(new Error('Only PNG, JPEG, WebP, and SVG images are allowed'), false);
  },
});

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
     LOGO upload / serve
  ═══════════════════════════════════════════════════════════ */

  // POST /api/settings/logo — admin uploads org logo
  app.get('/api/employee-options', auth, (req, res) => {
    try {
      const { dbAll } = req.app.locals;
      const rows = dbAll("SELECT key, value FROM app_settings WHERE key IN ('position_ahca_options','position_om_options')");
      const settings = {};
      for (const row of rows) settings[row.key] = row.value;
      const parseList = (value) => {
        try {
          const parsed = JSON.parse(value || '[]');
          return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
        } catch {
          return [];
        }
      };
      res.json({
        position_ahca: parseList(settings.position_ahca_options),
        position_om: parseList(settings.position_om_options),
      });
    } catch (err) {
      console.error('[employee-options] GET error:', err);
      res.status(500).json({ error: 'Failed to load employee options' });
    }
  });

  app.put('/api/employee-options', auth, managerOrAdmin, (req, res) => {
    try {
      const { dbRun } = req.app.locals;
      const normalize = (list) => {
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        return list.map(v => String(v || '').trim())
          .filter(Boolean)
          .filter(v => {
            const key = v.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      };
      const positionAhca = normalize(req.body?.position_ahca);
      const positionOm = normalize(req.body?.position_om);
      const updates = {
        position_ahca_options: JSON.stringify(positionAhca),
        position_om_options: JSON.stringify(positionOm),
      };
      for (const [key, value] of Object.entries(updates)) {
        dbRun(
          "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          [key, value]
        );
      }
      audit(req, 'EMPLOYEE_OPTIONS_UPDATE', 'app_settings', null, {
        position_ahca_count: positionAhca.length,
        position_om_count: positionOm.length,
      });
      res.json({ ok: true, position_ahca: positionAhca, position_om: positionOm });
    } catch (err) {
      console.error('[employee-options] PUT error:', err);
      res.status(500).json({ error: 'Failed to update employee options' });
    }
  });

  app.post('/api/settings/logo', auth, adminOnly,
    (req, res, next) => logoUpload.single('logo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    }),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No logo uploaded' });
      const { dbGet, dbRun } = req.app.locals;
      const prev = dbGet("SELECT value FROM app_settings WHERE key='org_logo_url'");
      if (prev?.value) {
        const oldName = prev.value.split('/').pop();
        const oldPath = path.join(config.UPLOAD_DIR, oldName);
        if (oldName && oldName.startsWith('logo_') && fs.existsSync(oldPath)) {
          fs.unlink(oldPath, () => {});
        }
      }
      dbRun(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('org_logo_url', ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        [req.file.filename]
      );
      audit(req, 'UPLOAD_LOGO', 'app_settings', null, { file: req.file.originalname });
      res.json({ ok: true, filename: req.file.filename });
    });

  // GET /api/settings/logo — public, serves the logo file (for login page + ID cards)
  app.get('/api/settings/logo', (req, res) => {
    const { dbGet } = req.app.locals;
    const row = dbGet("SELECT value FROM app_settings WHERE key='org_logo_url'");
    if (!row?.value) return res.status(404).end();
    const filePath = path.join(config.UPLOAD_DIR, row.value);
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(filePath);
  });

  // DELETE /api/settings/logo — admin removes the logo
  app.delete('/api/settings/logo', auth, adminOnly, (req, res) => {
    const { dbGet, dbRun } = req.app.locals;
    const prev = dbGet("SELECT value FROM app_settings WHERE key='org_logo_url'");
    if (prev?.value) {
      const oldName = prev.value.split('/').pop();
      const oldPath = path.join(config.UPLOAD_DIR, oldName);
      if (oldName && oldName.startsWith('logo_') && fs.existsSync(oldPath)) {
        fs.unlink(oldPath, () => {});
      }
    }
    dbRun(
      "INSERT INTO app_settings (key, value, updated_at) VALUES ('org_logo_url', '', datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value='', updated_at=excluded.updated_at"
    );
    audit(req, 'DELETE_LOGO', 'app_settings', null);
    res.json({ ok: true });
  });

  /* ═══════════════════════════════════════════════════════════
     USER SELF-SERVICE
  ═══════════════════════════════════════════════════════════ */

  // GET /api/me/profile — own user info (includes linked employee if any)
  app.get('/api/me/profile', auth, (req, res) => {
    try {
      const { dbGet } = req.app.locals;
      const user = dbGet(
        'SELECT u.id, u.username, u.role, u.display_name, u.active, u.created_at, ' +
        '       u.email, u.phone, u.employee_id, ' +
        '       e.badge_number AS employee_badge, ' +
        '       e.first_name   AS employee_first_name, ' +
        '       e.last_name    AS employee_last_name ' +
        'FROM users u LEFT JOIN employees e ON u.employee_id = e.id ' +
        'WHERE u.id = ?',
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

      // First successful Microsoft login locks the account to MS SSO from
      // then on. Admin can unlock via the Users settings panel.
      const { dbRun } = req.app.locals;
      let justLocked = false;
      if (!user.ms_locked) {
        dbRun("UPDATE users SET ms_locked=1, updated_at=datetime('now') WHERE id=?", [user.id]);
        justLocked = true;
      }

      // Issue JWT same as normal login
      const jti   = crypto.randomUUID();
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role,
          displayName: user.display_name || user.username, jti },
        config.JWT_SECRET, { expiresIn: '8h' }
      );

      req.user = { id: user.id, username: user.username };
      audit(req, 'LOGIN_MICROSOFT', 'users', user.id, { email, name, locked_now: justLocked });

      // Redirect to SPA with token in hash (client picks it up)
      res.redirect(`/#/auth/callback?token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error('[ms-oauth] Callback error:', err);
      res.status(500).send('<h2>Microsoft login error</h2><p>An unexpected error occurred.</p><p><a href="/">Back to login</a></p>');
    }
  });
};
