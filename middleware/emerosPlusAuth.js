'use strict';
const crypto = require('crypto');

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireEmerosPlusToken(req, res, next) {
  const expected = process.env.EMEROS_PLUS_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'Emeros+ integration is not configured on this server' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const provided = header.slice(7).trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return res.status(401).json({ error: 'Invalid bearer token' });
  }
  req.integration = 'emeros-plus';
  next();
}

module.exports = { requireEmerosPlusToken };
