'use strict';
// ─── EMS ↔ Emeros+ read-only integration endpoints ───────────────────────────
// Bearer-token auth. Mounted under /api/emeros-plus/*.
//
// Endpoints:
//   GET /api/emeros-plus/ping
//   GET /api/emeros-plus/payroll/runs?since=<iso>
//   GET /api/emeros-plus/employees/cost-centers

const { requireEmerosPlusToken } = require('../middleware/emerosPlusAuth');

// Naive heuristic for cost-center assignment. Override per-employee by setting
// the `notes` field to start with "cost_center:<name>" (e.g. "cost_center:Clinical").
// If nothing matches, defaults to "Administrative".
function deriveCostCenter(emp) {
  const notes = (emp.notes || '').trim();
  const m = notes.match(/^cost_center:([^\n\r]+)/i);
  if (m) return m[1].trim();
  const lic = (emp.license_type || emp.taxonomy || '').toLowerCase();
  const pos = (emp.position_ahca || emp.position_om || '').toLowerCase();
  const hay = `${lic} ${pos}`;
  if (/(md|do|np|pa|psychiatrist|therap|counsel|clinical|nurse|rn|lpn|social work|lcsw|lmhc|lmft|psycholog)/.test(hay)) {
    return 'Clinical';
  }
  if (/(admin|reception|billing|office|finance|hr|it)/.test(hay)) {
    return 'Administrative';
  }
  return 'Administrative';
}

module.exports = function (app) {
  const { dbAll, dbGet } = app.locals;

  app.get('/api/emeros-plus/ping', requireEmerosPlusToken, (_req, res) => {
    res.json({ ok: true, service: 'ems-integration' });
  });

  // ── GET /api/emeros-plus/payroll/runs?since=<iso> ──────────────────────────
  // EMS stores per-employee `payment_records`; we aggregate them by payment_date
  // into synthetic "runs" suitable for a single journal entry per pay period.
  app.get('/api/emeros-plus/payroll/runs', requireEmerosPlusToken, (req, res) => {
    try {
      const since = req.query.since;
      const params = [];
      let where = "category = 'regular' OR category = 'retro' OR category IS NULL";
      if (since) {
        params.push(since);
        where += ` AND payment_date >= ?`;
      }
      const rows = dbAll(
        `SELECT payment_date, COUNT(*) AS employees, SUM(gross_amount) AS gross
         FROM payment_records
         WHERE ${where}
         GROUP BY payment_date
         ORDER BY payment_date ASC`,
        params
      );
      const runs = rows.map((r) => {
        const gross = Number(r.gross || 0);
        const employer_taxes = Math.round(gross * 0.0765 * 100) / 100; // FICA employer portion estimate
        const net = gross;
        return {
          id: `EMS-PR-${r.payment_date}`,
          run_date: r.payment_date,
          employee_count: r.employees,
          gross,
          employer_taxes,
          net,
          cost_centers: [], // Optional: per-CC breakdown requires cost_center tagging on payment_records
        };
      });
      res.json({ count: runs.length, runs });
    } catch (err) {
      res.status(500).json({ error: 'payroll runs query failed', detail: err.message });
    }
  });

  // ── GET /api/emeros-plus/employees/cost-centers ────────────────────────────
  app.get('/api/emeros-plus/employees/cost-centers', requireEmerosPlusToken, (_req, res) => {
    try {
      const employees = dbAll(
        `SELECT id, first_name, last_name, position_ahca, position_om,
                license_type, taxonomy, employment_type, status, notes
         FROM employees
         WHERE status IS NULL OR status = 'active'
         ORDER BY last_name, first_name`
      );
      const out = employees.map((e) => ({
        employee_id: e.id,
        name: `${e.first_name || ''} ${e.last_name || ''}`.trim(),
        employment_type: e.employment_type || null,
        position: e.position_ahca || e.position_om || null,
        cost_center: deriveCostCenter(e),
      }));
      res.json({ count: out.length, employees: out });
    } catch (err) {
      res.status(500).json({ error: 'cost-center query failed', detail: err.message });
    }
  });
};
