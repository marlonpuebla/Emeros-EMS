'use strict';
const jwt    = require('jsonwebtoken');
const config = require('../config');

/* ─────────────────────────────────────────────────────────────
   AUTH — verify JWT, check blacklist, attach req.user
───────────────────────────────────────────────────────────── */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });

  let decoded;
  try { decoded = jwt.verify(token, config.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  // Check blacklist
  if (decoded.jti) {
    const bl = req.app.locals.dbGet('SELECT id FROM token_blacklist WHERE jti=?', [decoded.jti]);
    if (bl) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  req.user = {
    id:          decoded.id,
    username:    decoded.username,
    role:        decoded.role,
    displayName: decoded.displayName || decoded.username,
    jti:         decoded.jti,
  };
  next();
}

/* ─── Role gates ─────────────────────────────────────────── */
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Admin access required' });
  next();
}

function managerOrAdmin(req, res, next) {
  if (!['admin', 'office_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager or admin access required' });
  next();
}

function editorOrAbove(req, res, next) {
  if (!['admin', 'office_manager', 'editor'].includes(req.user.role))
    return res.status(403).json({ error: 'Editor or above access required' });
  next();
}

/* ─── Rate limiting ──────────────────────────────────────── */
const MAX_ATTEMPTS = 10;
const WINDOW_MIN   = 15;

function checkRateLimit(dbGet, identifier) {
  const windowStart = new Date(Date.now() - WINDOW_MIN * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const row = dbGet(
    "SELECT COUNT(*) as n FROM login_attempts WHERE identifier=? AND success=0 AND ts > ?",
    [identifier, windowStart]
  );
  return (row?.n || 0) >= MAX_ATTEMPTS;
}

function recordAttempt(dbRun, identifier, success) {
  dbRun('INSERT INTO login_attempts (identifier, success) VALUES (?,?)',
    [identifier, success ? 1 : 0]);
}

/* ─── Audit logger ───────────────────────────────────────── */
function audit(req, action, entity, entityId, detail) {
  const ip    = req.headers?.['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || '';
  const uid   = req.user ? req.user.id : null;
  const uname = req.user ? req.user.username : 'system';
  req.app.locals.dbRun(
    'INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?,?)',
    [uid, uname, action, entity || null, entityId || null,
     detail ? JSON.stringify(detail) : null, ip]
  );
}

module.exports = {
  auth, adminOnly, managerOrAdmin, editorOrAbove,
  checkRateLimit, recordAttempt, audit,
  MAX_ATTEMPTS, WINDOW_MIN,
};
