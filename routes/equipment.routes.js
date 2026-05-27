'use strict';
const { auth, editorOrAbove, managerOrAdmin, audit } = require('../middleware/auth');

const VALID_TYPES    = ['laptop','phone','tablet','badge','key','key_fob','uniform','vehicle','medical_device','pager','other'];
const VALID_STATUSES = ['available','assigned','maintenance','retired'];
const VALID_CONDS    = ['new','good','fair','poor'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ── LIST equipment ──────────────────────────────────────── */
  app.get('/api/equipment', auth, editorOrAbove, (req, res) => {
    const { status, type, search } = req.query;
    let sql = `SELECT e.*, a.employee_id AS assigned_to_id,
                 em.first_name AS assigned_first, em.last_name AS assigned_last
               FROM equipment e
               LEFT JOIN equipment_assignments a ON a.equipment_id=e.id AND a.returned_date IS NULL
               LEFT JOIN employees em ON a.employee_id=em.id
               WHERE 1=1`;
    const p = [];
    if (status) { sql += ' AND e.status=?'; p.push(status); }
    if (type)   { sql += ' AND e.type=?'; p.push(type); }
    if (search) { sql += ' AND (e.name LIKE ? OR e.asset_tag LIKE ? OR e.serial_number LIKE ?)'; p.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    sql += ' ORDER BY e.name';
    res.json(dbAll(sql, p));
  });

  /* ── GET ONE + assignment history ────────────────────────── */
  app.get('/api/equipment/:id', auth, editorOrAbove, (req, res) => {
    const eq = dbGet('SELECT * FROM equipment WHERE id=?', [req.params.id]);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    eq.assignments = dbAll(
      `SELECT ea.*, e.first_name, e.last_name FROM equipment_assignments ea
       JOIN employees e ON ea.employee_id=e.id WHERE ea.equipment_id=? ORDER BY ea.assigned_date DESC`,
      [req.params.id]
    );
    res.json(eq);
  });

  /* ── LIST equipment assigned to one employee ─────────────── */
  app.get('/api/employees/:id/equipment', auth, editorOrAbove, (req, res) => {
    res.json(dbAll(
      `SELECT ea.*, eq.name, eq.type, eq.asset_tag, eq.serial_number
       FROM equipment_assignments ea JOIN equipment eq ON ea.equipment_id=eq.id
       WHERE ea.employee_id=? ORDER BY ea.assigned_date DESC`,
      [req.params.id]
    ));
  });

  /* ── CREATE equipment ────────────────────────────────────── */
  app.post('/api/equipment', auth, editorOrAbove, (req, res) => {
    const { name, type, asset_tag, serial_number, description, location, purchase_date, purchase_price, warranty_expiration, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    dbRun(
      `INSERT INTO equipment (name, type, asset_tag, serial_number, description, status, location, purchase_date, purchase_price, warranty_expiration, notes, created_by)
       VALUES (?,?,?,?,?,'available',?,?,?,?,?,?)`,
      [name, type || null, asset_tag || null, serial_number || null, description || null,
       location || null, purchase_date || null, purchase_price ? Number(purchase_price) : null,
       warranty_expiration || null, notes || null, req.user.username]
    );
    const id = lastInsertId();
    audit(req, 'CREATE_EQUIPMENT', 'equipment', id, { name, type });
    res.status(201).json({ id, success: true });
  });

  /* ── UPDATE equipment ────────────────────────────────────── */
  app.put('/api/equipment/:id', auth, editorOrAbove, (req, res) => {
    const eq = dbGet('SELECT id FROM equipment WHERE id=?', [req.params.id]);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    const { name, type, asset_tag, serial_number, description, status, location, purchase_date, purchase_price, warranty_expiration, notes } = req.body;
    dbRun(
      `UPDATE equipment SET name=?, type=?, asset_tag=?, serial_number=?, description=?,
        status=?, location=?, purchase_date=?, purchase_price=?, warranty_expiration=?, notes=?, updated_at=?
       WHERE id=?`,
      [name, type || null, asset_tag || null, serial_number || null, description || null,
       status || 'available', location || null, purchase_date || null,
       purchase_price ? Number(purchase_price) : null, warranty_expiration || null,
       notes || null, new Date().toISOString(), req.params.id]
    );
    audit(req, 'UPDATE_EQUIPMENT', 'equipment', Number(req.params.id));
    res.json({ success: true });
  });

  /* ── ASSIGN equipment to employee ────────────────────────── */
  app.post('/api/equipment/:id/assign', auth, editorOrAbove, (req, res) => {
    const eq = dbGet('SELECT * FROM equipment WHERE id=?', [req.params.id]);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    const { employee_id, assigned_date, condition_out, notes } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    const emp = dbGet('SELECT id, first_name, last_name FROM employees WHERE id=?', [employee_id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    // Close any existing open assignment
    dbRun("UPDATE equipment_assignments SET returned_date=? WHERE equipment_id=? AND returned_date IS NULL",
      [assigned_date || new Date().toISOString().split('T')[0], req.params.id]);
    dbRun(
      `INSERT INTO equipment_assignments (equipment_id, employee_id, assigned_date, condition_out, notes, assigned_by)
       VALUES (?,?,?,?,?,?)`,
      [req.params.id, employee_id, assigned_date || new Date().toISOString().split('T')[0],
       condition_out || null, notes || null, req.user.username]
    );
    dbRun("UPDATE equipment SET status='assigned', updated_at=? WHERE id=?",
      [new Date().toISOString(), req.params.id]);
    audit(req, 'ASSIGN_EQUIPMENT', 'equipment', Number(req.params.id),
      { employee: `${emp.first_name} ${emp.last_name}`, equipment: eq.name });
    res.json({ success: true });
  });

  /* ── RETURN equipment ────────────────────────────────────── */
  app.post('/api/equipment/:id/return', auth, editorOrAbove, (req, res) => {
    const eq = dbGet('SELECT * FROM equipment WHERE id=?', [req.params.id]);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    const { returned_date, condition_in, notes } = req.body;
    dbRun(
      "UPDATE equipment_assignments SET returned_date=?, condition_in=?, notes=COALESCE(notes||' | '||?, ?) WHERE equipment_id=? AND returned_date IS NULL",
      [returned_date || new Date().toISOString().split('T')[0], condition_in || null, notes, notes, req.params.id]
    );
    dbRun("UPDATE equipment SET status='available', updated_at=? WHERE id=?",
      [new Date().toISOString(), req.params.id]);
    audit(req, 'RETURN_EQUIPMENT', 'equipment', Number(req.params.id), { equipment: eq.name });
    res.json({ success: true });
  });

  /* ── DELETE equipment (manager+) ─────────────────────────── */
  app.delete('/api/equipment/:id', auth, managerOrAdmin, (req, res) => {
    const eq = dbGet('SELECT id, name FROM equipment WHERE id=?', [req.params.id]);
    if (!eq) return res.status(404).json({ error: 'Equipment not found' });
    dbRun('DELETE FROM equipment WHERE id=?', [req.params.id]);
    audit(req, 'DELETE_EQUIPMENT', 'equipment', Number(req.params.id), { name: eq.name });
    res.json({ success: true });
  });
};
