'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { auth, adminOnly, audit } = require('../middleware/auth');

const VALID_ROLES = ['admin', 'office_manager', 'editor', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  if (email === null || email === undefined || email === '') return null;
  const trimmed = String(email).trim();
  if (!EMAIL_RE.test(trimmed)) return 'Invalid email format';
  return null;
}

function validateEmployeeLink(dbGet, userId, employee_id) {
  if (employee_id === null || employee_id === undefined || employee_id === '') return { ok: true, value: null };
  const n = Number(employee_id);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'Invalid employee_id' };
  const emp = dbGet('SELECT id FROM employees WHERE id=?', [n]);
  if (!emp) return { ok: false, error: 'Employee not found' };
  const claimed = dbGet('SELECT id, username FROM users WHERE employee_id=? AND id != ?', [n, userId || 0]);
  if (claimed) return { ok: false, error: `Employee already linked to user "${claimed.username}"` };
  return { ok: true, value: n };
}

module.exports = function (app) {
  const { dbAll, dbGet, dbRun } = app.locals;

  app.get('/api/users', auth, adminOnly, (_req, res) => {
    res.json(dbAll(
      'SELECT u.id, u.username, u.role, u.display_name, u.active, u.must_change_password, ' +
      '       u.email, u.phone, u.employee_id, u.created_at, ' +
      '       e.badge_number AS employee_badge, ' +
      '       e.first_name   AS employee_first_name, ' +
      '       e.last_name    AS employee_last_name ' +
      'FROM users u LEFT JOIN employees e ON u.employee_id = e.id ' +
      'ORDER BY u.username'
    ));
  });

  app.post('/api/users', auth, adminOnly, (req, res) => {
    const { username, password, role, display_name, email, phone, employee_id } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (role && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    if (dbGet('SELECT id FROM users WHERE username=?', [username]))
      return res.status(409).json({ error: 'Username already exists' });

    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    const linkCheck = validateEmployeeLink(dbGet, null, employee_id);
    if (!linkCheck.ok) return res.status(400).json({ error: linkCheck.error });

    dbRun(
      'INSERT INTO users (username,password,role,display_name,must_change_password,email,phone,employee_id) ' +
      'VALUES (?,?,?,?,1,?,?,?)',
      [
        username,
        bcrypt.hashSync(password, 10),
        role || 'viewer',
        display_name || null,
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        linkCheck.value,
      ]
    );
    audit(req, 'CREATE_USER', 'users', null,
      { username, role: role || 'viewer', employee_id: linkCheck.value });
    res.json({ success: true });
  });

  app.put('/api/users/:id', auth, adminOnly, (req, res) => {
    const { role, display_name, active, email, phone, employee_id } = req.body || {};
    const target = dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (role !== undefined && !VALID_ROLES.includes(role))
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` });
    if (active === 0 && target.id === req.user.id)
      return res.status(400).json({ error: 'You cannot deactivate your own account' });

    if (email !== undefined) {
      const emailErr = validateEmail(email);
      if (emailErr) return res.status(400).json({ error: emailErr });
    }
    let employeeLinkValue;
    if (employee_id !== undefined) {
      const linkCheck = validateEmployeeLink(dbGet, Number(req.params.id), employee_id);
      if (!linkCheck.ok) return res.status(400).json({ error: linkCheck.error });
      employeeLinkValue = linkCheck.value;
    }

    const sets = [], params = [];
    if (role !== undefined)         { sets.push('role=?');         params.push(role); }
    if (display_name !== undefined) { sets.push('display_name=?'); params.push(display_name); }
    if (active !== undefined)       { sets.push('active=?');       params.push(active ? 1 : 0); }
    if (email !== undefined)        { sets.push('email=?');        params.push(email ? String(email).trim() : null); }
    if (phone !== undefined)        { sets.push('phone=?');        params.push(phone ? String(phone).trim() : null); }
    if (employee_id !== undefined)  { sets.push('employee_id=?');  params.push(employeeLinkValue); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=?'); params.push(new Date().toISOString());
    params.push(req.params.id);
    dbRun(`UPDATE users SET ${sets.join(',')} WHERE id=?`, params);
    audit(req, 'UPDATE_USER', 'users', Number(req.params.id),
      { username: target.username, role, active, email_changed: email !== undefined, employee_id: employeeLinkValue });
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
