'use strict';
const { auth, adminOnly } = require('../middleware/auth');

module.exports = function (app) {
  const { dbAll, dbGet } = app.locals;

  // GET /api/audit?limit=50&offset=0&action=&user=&entity=&from=&to=
  app.get('/api/audit', auth, adminOnly, (req, res) => {
    const { limit = 50, offset = 0, action, user, entity, from, to } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const p = [];
    if (action) { sql += ' AND action LIKE ?'; p.push(`%${action}%`); }
    if (user)   { sql += ' AND username LIKE ?'; p.push(`%${user}%`); }
    if (entity) { sql += ' AND entity = ?'; p.push(entity); }
    if (from)   { sql += ' AND ts >= ?'; p.push(from); }
    if (to)     { sql += ' AND ts <= ?'; p.push(to + 'T23:59:59'); }
    const total = dbGet(`SELECT COUNT(*) as n FROM audit_log WHERE 1=1${p.length ? sql.slice(sql.indexOf(' AND')) : ''}`, p)?.n || 0;
    sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
    const rows = dbAll(sql, [...p, Number(limit), Number(offset)]);
    res.json({ total, rows });
  });

  // GET /api/audit/actions — distinct action types for filter dropdown
  app.get('/api/audit/actions', auth, adminOnly, (req, res) => {
    const rows = dbAll('SELECT DISTINCT action FROM audit_log ORDER BY action');
    res.json(rows.map(r => r.action));
  });
};
