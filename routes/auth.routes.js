'use strict';
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const { auth, checkRateLimit, recordAttempt, audit, WINDOW_MIN } = require('../middleware/auth');

module.exports = function (app) {
  const { dbGet, dbRun } = app.locals;

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });

    const ip         = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || 'unknown';
    const identifier = `${username}:${ip}`;

    if (checkRateLimit(dbGet, identifier))
      return res.status(429).json({ error: `Too many failed attempts. Wait ${WINDOW_MIN} minutes.` });

    const user = dbGet('SELECT * FROM users WHERE username=?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      recordAttempt(dbRun, identifier, false);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.active)
      return res.status(403).json({ error: 'Account is deactivated. Contact an administrator.' });

    // Once a non-admin user has signed in via Microsoft, password login is
    // disabled for that account. Admins always retain password access so they
    // can't lock themselves out, and so they can recover other users.
    if (user.ms_locked && user.role !== 'admin') {
      recordAttempt(dbRun, identifier, true);
      audit(req, 'LOGIN_BLOCKED_MS_REQUIRED', 'users', user.id, { username });
      return res.status(403).json({
        error: 'This account must sign in with Microsoft.',
        ms_required: true,
      });
    }

    recordAttempt(dbRun, identifier, true);
    const jti   = crypto.randomUUID();
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role,
        displayName: user.display_name || user.username, jti },
      config.JWT_SECRET, { expiresIn: '8h' }
    );
    req.user = { id: user.id, username: user.username };
    audit(req, 'LOGIN', 'users', user.id);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role,
              display_name: user.display_name || user.username },
      must_change_password: !!user.must_change_password,
    });
  });

  app.post('/api/logout', auth, (req, res) => {
    if (req.user.jti) {
      const decoded = jwt.decode(req.headers.authorization.split(' ')[1]);
      dbRun('INSERT OR IGNORE INTO token_blacklist (jti,expires_at) VALUES (?,?)',
        [req.user.jti, decoded.exp]);
    }
    audit(req, 'LOGOUT', 'users', req.user.id);
    res.json({ success: true });
  });

  app.get('/api/me', auth, (req, res) => {
    res.json(dbGet('SELECT id,username,role,display_name,active,created_at FROM users WHERE id=?', [req.user.id]));
  });

  app.put('/api/me/password', auth, (req, res) => {
    const current     = req.body?.current     || req.body?.current_password || '';
    const newPassword = req.body?.newPassword || req.body?.new_password    || '';
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!bcrypt.compareSync(current, user.password))
      return res.status(400).json({ error: 'Current password is incorrect' });
    dbRun('UPDATE users SET password=?, must_change_password=0, updated_at=? WHERE id=?',
      [bcrypt.hashSync(newPassword, 10), new Date().toISOString(), req.user.id]);
    if (req.user.jti) {
      const decoded = jwt.decode(req.headers.authorization.split(' ')[1]);
      dbRun('INSERT OR IGNORE INTO token_blacklist (jti,expires_at) VALUES (?,?)',
        [req.user.jti, decoded.exp]);
    }
    audit(req, 'PASSWORD_CHANGE', 'users', req.user.id);
    res.json({ success: true, message: 'Password changed. Please log in again.' });
  });
};
