'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { auth, adminOnly, audit } = require('../middleware/auth');

const VALID_ROLES = ['admin', 'office_manager', 'editor', 'viewer'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun } = app.locals;

  app.get('/api/users', auth, adminOnly, (_req, res) => {
    res.json(dbAll('SELECT id,username,role,display_name,active,must_change_password,created_at FROM users ORDER BY username'));
  });

  app.post('/api/users', auth, adminOnly, (req, res) => {
    const { username, password, role, display_name } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (role && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    if (dbGet('SELECT id FROM users WHERE username=?', [username]))
      return res.status(409).json({ error: 'Username already exists' });

    dbRun('INSERT INTO users (username,password,role,display_name,must_change_password) VALUES (?,?,?,?,1)',
      [username, bcrypt.hashSync(password, 10), role || 'viewer', display_name || null]);
    audit(req, 'CREATE_USER', 'users', null, { username, role: role || 'viewer' });
    res.json({ success: true });
  });

  app.put('/api/users/:id', auth, adminOnly, (req, res) => {
    const { role, display_name, active } = req.body || {};
    const target = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (role !== undefined && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    if (active === 0 && target.id === req.user.id)
      return res.status(400).json({ error: 'You cannot deactivate your own account' });

    const sets = [], params = [];
    if (role !== undefined)         { sets.push('role=?');         params.push(role); }
    if (display_name !== undefined) { sets.push('display_name=?'); params.push(display_name); }
    if (active !== undefined)       { sets.push('active=?');       params.push(active ? 1 : 0); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=?'); params.push(new Date().toISOString());
    params.push(req.params.id);
    dbRun(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params);
    audit(req, 'UPDATE_USER', 'users', Number(req.params.id), { username: target.username, role, active });
    res.json({ success: true });
  });

  app.put('/api/users/:id/reset-password', auth, adminOnly, (req, res) => {
    const target = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const newPw = req.body?.password || crypto.randomBytes(6).toString('base64url');
    if (newPw.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    dbRun('UPDATE users SET password=?, must_change_password=1, updated_at=? WHERE id=?',
      [bcrypt.hashSync(newPw, 10), new Date().toISOString(), req.params.id]);
    audit(req, 'RESET_PASSWORD', 'users', Number(req.params.id), { username: target.username });
    res.json({ success: true, temp_password: newPw });
  });

  app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
    const target = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === req.user.id)
      return res.status(400).json({ error: 'You cannot delete your own account' });
    dbRun('DELETE FROM users WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_USER', 'users', Number(req.params.id), { username: target.username });
    res.json({ success: true });
  });
};
