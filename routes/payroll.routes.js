'use strict';
const XLSX   = require('xlsx');
const { auth, managerOrAdmin, adminOnly, audit } = require('../middleware/auth');

const VALID_PAY_TYPES   = ['salary', 'hourly', 'per_session', 'per_diem', 'flat_fee', 'stipend'];
const VALID_FREQUENCIES  = ['yearly', 'biweekly', 'weekly', 'monthly', 'per_session', 'per_diem'];
const VALID_METHODS      = ['direct_deposit', 'check', 'cash', 'wire', 'zelle', 'other'];
const VALID_CATEGORIES   = ['regular', 'bonus', 'reimbursement', 'retro', 'advance', 'other'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ═══════════════════════════════════════════════════════════
     COMPENSATION RATES
  ═══════════════════════════════════════════════════════════ */

  // List rate history for an employee
  app.get('/api/employees/:id/compensation', auth, managerOrAdmin, (req, res) => {
    const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const rates = dbAll(
      'SELECT * FROM compensation_rates WHERE employee_id=? ORDER BY effective_date DESC, id DESC',
      [req.params.id]
    );
    res.json(rates);
  });

  // Set new rate (closes previous active rate)
  app.post('/api/employees/:id/compensation', auth, managerOrAdmin, (req, res) => {
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const { pay_type, rate, frequency, effective_date, notes } = req.body;
    if (!pay_type || !VALID_PAY_TYPES.includes(pay_type))
      return res.status(400).json({ error: `pay_type must be one of: ${VALID_PAY_TYPES.join(', ')}` });
    if (rate == null || isNaN(rate) || Number(rate) < 0)
      return res.status(400).json({ error: 'rate is required and must be a positive number' });
    if (!effective_date)
      return res.status(400).json({ error: 'effective_date is required' });

    // Close previous active rate
    const prev = dbGet(
      'SELECT id FROM compensation_rates WHERE employee_id=? AND end_date IS NULL ORDER BY effective_date DESC LIMIT 1',
      [req.params.id]
    );
    if (prev) {
      dbRun('UPDATE compensation_rates SET end_date=? WHERE id=?', [effective_date, prev.id]);
    }

    // Insert new rate
    dbRun(
      'INSERT INTO compensation_rates (employee_id, pay_type, rate, frequency, effective_date, notes, created_by) VALUES (?,?,?,?,?,?,?)',
      [req.params.id, pay_type, Number(rate), frequency || null, effective_date, notes || null, req.user.username]
    );
    const rateId = lastInsertId();

    // Update employee's current pay fields
    dbRun('UPDATE employees SET pay_type=?, pay_rate=?, pay_frequency=?, updated_at=? WHERE id=?',
      [pay_type, Number(rate), frequency || null, new Date().toISOString(), req.params.id]);

    audit(req, 'SET_COMPENSATION_RATE', 'employees', Number(req.params.id),
      { name: `${emp.first_name} ${emp.last_name}`, pay_type, rate: Number(rate), frequency, effective_date });
    res.status(201).json({ id: rateId, message: 'Compensation rate set' });
  });

  // Delete a rate record
  app.delete('/api/compensation/:id', auth, adminOnly, (req, res) => {
    const rate = dbGet('SELECT * FROM compensation_rates WHERE id=?', [req.params.id]);
    if (!rate) return res.status(404).json({ error: 'Rate record not found' });
    dbRun('DELETE FROM compensation_rates WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_COMPENSATION_RATE', 'compensation_rates', Number(req.params.id),
      { employee_id: rate.employee_id });
    res.json({ success: true });
  });

  /* ═══════════════════════════════════════════════════════════
     PAYMENT RECORDS
  ═══════════════════════════════════════════════════════════ */

  // List payments for one employee
  app.get('/api/employees/:id/payments', auth, managerOrAdmin, (req, res) => {
    const emp = dbGet('SELECT id FROM employees WHERE id=?', [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    let sql = 'SELECT * FROM payment_records WHERE employee_id=?';
    const p = [req.params.id];
    if (req.query.from) { sql += ' AND payment_date >= ?'; p.push(req.query.from); }
    if (req.query.to)   { sql += ' AND payment_date <= ?'; p.push(req.query.to); }
    sql += ' ORDER BY payment_date DESC, id DESC';
    res.json(dbAll(sql, p));
  });

  // List all payments with filters
  app.get('/api/payments', auth, managerOrAdmin, (req, res) => {
    let sql = `SELECT pr.*, e.first_name, e.last_name, e.position_om, e.employment_type
               FROM payment_records pr
               LEFT JOIN employees e ON e.id = pr.employee_id
               WHERE 1=1`;
    const p = [];
    if (req.query.from)        { sql += ' AND pr.payment_date >= ?'; p.push(req.query.from); }
    if (req.query.to)          { sql += ' AND pr.payment_date <= ?'; p.push(req.query.to); }
    if (req.query.employee_id) { sql += ' AND pr.employee_id = ?';  p.push(req.query.employee_id); }
    if (req.query.category)    { sql += ' AND pr.category = ?';     p.push(req.query.category); }
    if (req.query.search) {
      sql += ' AND (e.first_name LIKE ? OR e.last_name LIKE ?)';
      const s = `%${req.query.search}%`;
      p.push(s, s);
    }
    sql += ' ORDER BY pr.payment_date DESC, pr.id DESC';
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    sql += ' LIMIT ? OFFSET ?';
    p.push(limit, offset);
    const rows = dbAll(sql, p);
    const total = dbGet(`SELECT COUNT(*) as n FROM payment_records pr
      LEFT JOIN employees e ON e.id = pr.employee_id WHERE 1=1
      ${req.query.from ? "AND pr.payment_date >= '" + req.query.from + "'" : ''}
      ${req.query.to ? "AND pr.payment_date <= '" + req.query.to + "'" : ''}
      ${req.query.employee_id ? "AND pr.employee_id = " + parseInt(req.query.employee_id) : ''}
      ${req.query.category ? "AND pr.category = '" + req.query.category.replace(/'/g, '') + "'" : ''}
    `);
    res.json({ rows, total: total?.n || 0 });
  });

  // Record a single payment
  app.post('/api/payments', auth, managerOrAdmin, (req, res) => {
    const { employee_id, pay_period_start, pay_period_end, payment_date, gross_amount,
            payment_method, check_number, invoice_number, hours_worked, sessions,
            days_worked, category, notes } = req.body;

    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    if (gross_amount == null || isNaN(gross_amount))
      return res.status(400).json({ error: 'gross_amount is required' });

    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [employee_id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    dbRun(
      `INSERT INTO payment_records
        (employee_id, pay_period_start, pay_period_end, payment_date, gross_amount,
         payment_method, check_number, invoice_number, hours_worked, sessions,
         days_worked, category, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [employee_id, pay_period_start || null, pay_period_end || null, payment_date,
       Number(gross_amount), payment_method || null, check_number || null,
       invoice_number || null, hours_worked ? Number(hours_worked) : null,
       sessions ? Number(sessions) : null, days_worked ? Number(days_worked) : null,
       category || 'regular', notes || null, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'RECORD_PAYMENT', 'payment_records', id,
      { employee: `${emp.first_name} ${emp.last_name}`, amount: Number(gross_amount), date: payment_date });
    res.status(201).json({ id, message: 'Payment recorded' });
  });

  // Batch record payments
  app.post('/api/payments/batch', auth, managerOrAdmin, (req, res) => {
    const { payments } = req.body;
    if (!Array.isArray(payments) || !payments.length)
      return res.status(400).json({ error: 'payments array is required' });

    const ids = [];
    let totalAmount = 0;
    for (const pay of payments) {
      if (!pay.employee_id || !pay.payment_date || pay.gross_amount == null) continue;
      dbRun(
        `INSERT INTO payment_records
          (employee_id, pay_period_start, pay_period_end, payment_date, gross_amount,
           payment_method, check_number, invoice_number, hours_worked, sessions,
           days_worked, category, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pay.employee_id, pay.pay_period_start || null, pay.pay_period_end || null,
         pay.payment_date, Number(pay.gross_amount), pay.payment_method || null,
         pay.check_number || null, pay.invoice_number || null,
         pay.hours_worked ? Number(pay.hours_worked) : null,
         pay.sessions ? Number(pay.sessions) : null,
         pay.days_worked ? Number(pay.days_worked) : null,
         pay.category || 'regular', pay.notes || null, req.user.username]
      );
      ids.push(lastInsertId());
      totalAmount += Number(pay.gross_amount);
    }
    audit(req, 'BATCH_PAYMENT', 'payment_records', null,
      { count: ids.length, total_amount: totalAmount });
    res.status(201).json({ count: ids.length, total_amount: totalAmount, ids });
  });

  // Update a payment
  app.put('/api/payments/:id', auth, managerOrAdmin, (req, res) => {
    const existing = dbGet('SELECT * FROM payment_records WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Payment not found' });

    const fields = ['pay_period_start','pay_period_end','payment_date','gross_amount',
      'payment_method','check_number','invoice_number','hours_worked','sessions',
      'days_worked','category','notes'];
    const sets = [], params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f}=?`);
        params.push(req.body[f]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push("updated_at=datetime('now')");
    params.push(req.params.id);
    dbRun(`UPDATE payment_records SET ${sets.join(',')} WHERE id=?`, params);
    audit(req, 'UPDATE_PAYMENT', 'payment_records', Number(req.params.id), req.body);
    res.json({ success: true });
  });

  // Delete a payment
  app.delete('/api/payments/:id', auth, adminOnly, (req, res) => {
    const existing = dbGet('SELECT * FROM payment_records WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Payment not found' });
    dbRun('DELETE FROM payment_records WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_PAYMENT', 'payment_records', Number(req.params.id),
      { employee_id: existing.employee_id, amount: existing.gross_amount });
    res.json({ success: true });
  });

  /* ═══════════════════════════════════════════════════════════
     SUMMARY & EXPORT
  ═══════════════════════════════════════════════════════════ */

  // Payment summary
  app.get('/api/payments/summary', auth, managerOrAdmin, (req, res) => {
    const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to   = req.query.to   || new Date().toISOString().split('T')[0];

    const totals = dbGet(
      'SELECT COUNT(*) as count, COALESCE(SUM(gross_amount),0) as total FROM payment_records WHERE payment_date >= ? AND payment_date <= ?',
      [from, to]
    );

    const byEmployee = dbAll(
      `SELECT e.id, e.first_name, e.last_name, e.position_om, e.employment_type,
              COUNT(*) as payment_count, SUM(pr.gross_amount) as total
       FROM payment_records pr
       JOIN employees e ON e.id = pr.employee_id
       WHERE pr.payment_date >= ? AND pr.payment_date <= ?
       GROUP BY pr.employee_id ORDER BY total DESC`,
      [from, to]
    );

    const byCategory = dbAll(
      'SELECT category, COUNT(*) as count, SUM(gross_amount) as total FROM payment_records WHERE payment_date >= ? AND payment_date <= ? GROUP BY category',
      [from, to]
    );

    const byMethod = dbAll(
      'SELECT payment_method, COUNT(*) as count, SUM(gross_amount) as total FROM payment_records WHERE payment_date >= ? AND payment_date <= ? GROUP BY payment_method',
      [from, to]
    );

    const withRate = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='active' AND pay_rate IS NOT NULL AND pay_rate > 0");
    const noRate   = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='active' AND (pay_rate IS NULL OR pay_rate = 0)");

    res.json({
      from, to,
      total_paid: totals?.total || 0,
      payment_count: totals?.count || 0,
      with_rate: withRate?.n || 0,
      no_rate: noRate?.n || 0,
      by_employee: byEmployee,
      by_category: byCategory,
      by_method: byMethod,
    });
  });

  // Excel export
  app.get('/api/payments/export', auth, managerOrAdmin, (req, res) => {
    const from = req.query.from || '2020-01-01';
    const to   = req.query.to   || '2099-12-31';

    const rows = dbAll(
      `SELECT pr.*, e.first_name, e.last_name, e.position_om, e.employment_type
       FROM payment_records pr
       LEFT JOIN employees e ON e.id = pr.employee_id
       WHERE pr.payment_date >= ? AND pr.payment_date <= ?
       ORDER BY pr.payment_date DESC`,
      [from, to]
    );

    const header = [
      'PAYMENT DATE','EMPLOYEE','POSITION','TYPE','PAY PERIOD START','PAY PERIOD END',
      'GROSS AMOUNT','METHOD','CHECK #','INVOICE #','HOURS','SESSIONS','DAYS',
      'CATEGORY','NOTES','RECORDED BY'
    ];
    const data = rows.map(r => [
      r.payment_date, `${r.last_name}, ${r.first_name}`, r.position_om || '',
      r.employment_type || '', r.pay_period_start || '', r.pay_period_end || '',
      r.gross_amount, r.payment_method || '', r.check_number || '',
      r.invoice_number || '', r.hours_worked || '', r.sessions || '',
      r.days_worked || '', r.category || '', r.notes || '', r.created_by || ''
    ]);

    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PAYMENTS');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    audit(req, 'EXPORT_PAYMENTS', null, null, { from, to, count: rows.length });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Payments_${from}_to_${to}.xlsx"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  });
};
