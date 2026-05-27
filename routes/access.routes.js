'use strict';
/**
 * Door Controller / Access Validation Route
 *
 * Called by physical door controllers or access control systems to verify
 * whether a scanned badge token belongs to an active employee.
 *
 * Security model:
 *  - Requires a pre-shared API key in the X-Access-Api-Key header.
 *    Set ACCESS_API_KEY in data/config.env (or process.env).
 *    If ACCESS_API_KEY is not configured the endpoint returns 503.
 *  - The access_token itself has 128 bits of random entropy — not guessable.
 *  - Discharged employees' tokens are cleared on discharge, so they always
 *    get a 404 here even if someone kept an old badge.
 *  - Every scan (success or failure) is written to the audit log.
 *
 * Endpoint:
 *   GET /api/access/validate/:token
 *
 * Success (active employee):
 *   200  { valid: true,  employee_id, badge_number, name, position, status }
 *
 * Inactive / not found:
 *   200  { valid: false, reason: "discharged" | "not_found" }
 *
 * Bad API key:
 *   401  { error: "Unauthorized" }
 *
 * Not configured:
 *   503  { error: "Access validation not configured" }
 */

const { audit } = require('../middleware/auth');

module.exports = function (app) {
  const { dbGet, dbRun } = app.locals;

  app.get('/api/access/validate/:token', (req, res) => {
    const configuredKey = process.env.ACCESS_API_KEY || '';
    if (!configuredKey) {
      return res.status(503).json({ error: 'Access validation not configured' });
    }

    const providedKey = req.headers['x-access-api-key'] || '';
    if (!providedKey || providedKey !== configuredKey) {
      // Log the failed attempt but do not leak details
      dbRun(
        "INSERT INTO audit_log (username,action,entity,detail,ip) VALUES (?,?,?,?,?)",
        ['system', 'ACCESS_VALIDATE_UNAUTHORIZED', 'access',
         JSON.stringify({ token_prefix: req.params.token.slice(0, 8) + '…' }),
         req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || '']
      );
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token } = req.params;
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || '';

    const emp = dbGet(
      'SELECT id, badge_number, first_name, last_name, status, position_om, position_ahca FROM employees WHERE access_token = ?',
      [token]
    );

    if (!emp) {
      dbRun(
        "INSERT INTO audit_log (username,action,entity,detail,ip) VALUES (?,?,?,?,?)",
        ['system', 'ACCESS_VALIDATE_NOT_FOUND', 'access',
         JSON.stringify({ token_prefix: token.slice(0, 8) + '…' }), ip]
      );
      return res.json({ valid: false, reason: 'not_found' });
    }

    const name = `${emp.first_name} ${emp.last_name}`;
    const position = emp.position_om || emp.position_ahca || '';

    if (emp.status !== 'active') {
      dbRun(
        "INSERT INTO audit_log (user_id,username,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?,?)",
        [emp.id, 'system', 'ACCESS_VALIDATE_DENIED', 'employees', emp.id,
         JSON.stringify({ name, badge_number: emp.badge_number, reason: emp.status }), ip]
      );
      return res.json({ valid: false, reason: emp.status });
    }

    dbRun(
      "INSERT INTO audit_log (user_id,username,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?,?)",
      [emp.id, 'system', 'ACCESS_VALIDATE_OK', 'employees', emp.id,
       JSON.stringify({ name, badge_number: emp.badge_number }), ip]
    );

    return res.json({
      valid:       true,
      employee_id: emp.id,
      badge_number: emp.badge_number,
      name,
      position,
      status:      emp.status,
    });
  });
};
