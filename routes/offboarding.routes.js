'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');

// Standard offboarding checklist items
const DEFAULT_ITEMS = [
  { category: 'HR & Paperwork',  item_name: 'Termination letter issued',              required: 1, sort_order: 10 },
  { category: 'HR & Paperwork',  item_name: 'Separation agreement signed (if applicable)', required: 0, sort_order: 20 },
  { category: 'HR & Paperwork',  item_name: 'Final paycheck calculated',              required: 1, sort_order: 30 },
  { category: 'HR & Paperwork',  item_name: 'PTO payout calculated',                 required: 1, sort_order: 40 },
  { category: 'HR & Paperwork',  item_name: 'COBRA notice sent (within 14 days)',     required: 1, sort_order: 50 },
  { category: 'HR & Paperwork',  item_name: 'FL Reemployment Assistance notice given',required: 1, sort_order: 60 },
  { category: 'HR & Paperwork',  item_name: 'W-2 / 1099 filing noted',               required: 1, sort_order: 70 },
  { category: 'HR & Paperwork',  item_name: 'Benefits termination date confirmed',    required: 1, sort_order: 80 },
  { category: 'HR & Paperwork',  item_name: 'Exit interview conducted',               required: 0, sort_order: 90 },
  { category: 'Access & Security', item_name: 'Physical badge / ID card collected',  required: 1, sort_order: 100 },
  { category: 'Access & Security', item_name: 'Access token revoked (EMS badge scan)', required: 1, sort_order: 110 },
  { category: 'Access & Security', item_name: 'Building keys / key fobs returned',   required: 1, sort_order: 120 },
  { category: 'Access & Security', item_name: 'Parking access removed',              required: 0, sort_order: 130 },
  { category: 'IT & Systems',   item_name: 'EHR / EMS system access disabled',       required: 1, sort_order: 140 },
  { category: 'IT & Systems',   item_name: 'Email account disabled / forwarded',     required: 1, sort_order: 150 },
  { category: 'IT & Systems',   item_name: 'Laptop / tablet returned',               required: 0, sort_order: 160 },
  { category: 'IT & Systems',   item_name: 'Phone / pager returned',                 required: 0, sort_order: 170 },
  { category: 'IT & Systems',   item_name: 'Password reset for shared accounts',     required: 1, sort_order: 180 },
  { category: 'Credentialing',  item_name: 'Payer credentialing terminated (Medicare/Medicaid)', required: 0, sort_order: 190 },
  { category: 'Credentialing',  item_name: 'CAQH profile updated / deactivated',     required: 0, sort_order: 200 },
  { category: 'Credentialing',  item_name: 'NPI deactivation reviewed',              required: 0, sort_order: 210 },
  { category: 'Notifications',  item_name: 'Malpractice carrier notified',           required: 0, sort_order: 220 },
  { category: 'Notifications',  item_name: 'Supervisor / team informed',             required: 1, sort_order: 230 },
  { category: 'Notifications',  item_name: 'Patients transitioned (if clinical)',    required: 0, sort_order: 240 },
];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST (all packages or filter by employee) ──────────── */
  app.get('/api/offboarding', auth, editorOrAbove, (req, res) => {
    const { employee_id, status } = req.query;
    let sql = `SELECT op.*, e.first_name, e.last_name, e.badge_number, e.position_om
               FROM offboarding_packages op JOIN employees e ON op.employee_id=e.id WHERE 1=1`;
    const p = [];
    if (employee_id) { sql += ' AND op.employee_id=?'; p.push(employee_id); }
    if (status)      { sql += ' AND op.status=?'; p.push(status); }
    sql += ' ORDER BY op.created_at DESC';
    const pkgs = dbAll(sql, p);
    for (const pkg of pkgs) {
      const items = dbAll('SELECT * FROM offboarding_items WHERE package_id=?', [pkg.id]);
      pkg.total    = items.length;
      pkg.done     = items.filter(i => i.status === 'completed' || i.status === 'n_a').length;
    }
    res.json(pkgs);
  });

  /* ── GET ONE package with items ──────────────────────────── */
  app.get('/api/offboarding/:id', auth, editorOrAbove, (req, res) => {
    const pkg = dbGet('SELECT op.*, e.first_name, e.last_name, e.badge_number FROM offboarding_packages op JOIN employees e ON op.employee_id=e.id WHERE op.id=?', [req.params.id]);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    pkg.items = dbAll('SELECT * FROM offboarding_items WHERE package_id=? ORDER BY sort_order, id', [req.params.id]);
    res.json(pkg);
  });

  /* ── CREATE package for employee ─────────────────────────── */
  app.post('/api/offboarding', auth, editorOrAbove, (req, res) => {
    const { employee_id, termination_type, last_day, assigned_to } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [employee_id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    dbRun(
      `INSERT INTO offboarding_packages (employee_id, termination_type, last_day, assigned_to, created_by)
       VALUES (?,?,?,?,?)`,
      [employee_id, termination_type || null, last_day || null, assigned_to || null, req.user.username]
    );
    const pkgId = lastInsertId();

    // Seed default checklist items
    for (const item of DEFAULT_ITEMS) {
      dbRun(
        `INSERT INTO offboarding_items (package_id, category, item_name, required, sort_order)
         VALUES (?,?,?,?,?)`,
        [pkgId, item.category, item.item_name, item.required, item.sort_order]
      );
    }

    audit(req, 'CREATE_OFFBOARDING', 'offboarding_packages', pkgId,
      { employee: `${emp.first_name} ${emp.last_name}`, termination_type });
    res.status(201).json({ id: pkgId, success: true });
  });

  /* ── UPDATE package ──────────────────────────────────────── */
  app.put('/api/offboarding/:id', auth, editorOrAbove, (req, res) => {
    const pkg = dbGet('SELECT * FROM offboarding_packages WHERE id=?', [req.params.id]);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    const { termination_type, last_day, assigned_to, exit_interview_done, status } = req.body;
    const newStatus = status || pkg.status;
    const completedAt = newStatus === 'completed' && pkg.status !== 'completed' ? new Date().toISOString() : pkg.completed_at;
    dbRun(
      `UPDATE offboarding_packages SET termination_type=?, last_day=?, assigned_to=?,
        exit_interview_done=?, status=?, completed_at=?, updated_at=? WHERE id=?`,
      [termination_type ?? pkg.termination_type, last_day ?? pkg.last_day,
       assigned_to ?? pkg.assigned_to,
       exit_interview_done !== undefined ? (exit_interview_done ? 1 : 0) : pkg.exit_interview_done,
       newStatus, completedAt, new Date().toISOString(), req.params.id]
    );
    audit(req, 'UPDATE_OFFBOARDING', 'offboarding_packages', Number(req.params.id), { status: newStatus });
    res.json({ success: true });
  });

  /* ── UPDATE a single item ────────────────────────────────── */
  app.put('/api/offboarding/items/:itemId', auth, editorOrAbove, (req, res) => {
    const item = dbGet('SELECT * FROM offboarding_items WHERE id=?', [req.params.itemId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { status, notes } = req.body;
    const validItemStatuses = ['pending', 'completed', 'n_a'];
    if (status && !validItemStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const completedAt = status === 'completed' && item.status !== 'completed' ? new Date().toISOString() : item.completed_at;
    const completedBy = status === 'completed' ? req.user.username : item.completed_by;
    dbRun(
      'UPDATE offboarding_items SET status=?, notes=?, completed_by=?, completed_at=? WHERE id=?',
      [status || item.status, notes ?? item.notes, completedBy, completedAt, req.params.itemId]
    );
    // Auto-complete package if all required items are done
    const remaining = dbGet(
      "SELECT COUNT(*) as n FROM offboarding_items WHERE package_id=? AND required=1 AND status NOT IN ('completed','n_a')",
      [item.package_id]
    );
    if (remaining?.n === 0) {
      dbRun("UPDATE offboarding_packages SET status='completed', completed_at=?, updated_at=? WHERE id=? AND status!='completed'",
        [new Date().toISOString(), new Date().toISOString(), item.package_id]);
    }
    res.json({ success: true });
  });

  /* ── DELETE package (manager+) ───────────────────────────── */
  app.delete('/api/offboarding/:id', auth, managerOrAdmin, (req, res) => {
    const pkg = dbGet('SELECT id FROM offboarding_packages WHERE id=?', [req.params.id]);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    dbRun('DELETE FROM offboarding_packages WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_OFFBOARDING', 'offboarding_packages', Number(req.params.id));
    res.json({ success: true });
  });
};
