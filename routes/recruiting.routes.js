'use strict';
const { auth, adminOnly, managerOrAdmin, editorOrAbove, audit } = require('../middleware/auth');

const VALID_STAGES = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];

module.exports = function (app) {
  const { dbAll, dbGet, dbRun, lastInsertId } = app.locals;

  /* ═══════════════════════════════════════════════════════════
     JOB POSTINGS
  ═══════════════════════════════════════════════════════════ */

  // List all job postings
  app.get('/api/job-postings', auth, (req, res) => {
    try {
      const status = req.query.status || 'open';
      let sql = 'SELECT * FROM job_postings';
      const params = [];
      if (status !== 'all') {
        sql += ' WHERE status = ?';
        params.push(status);
      }
      sql += ' ORDER BY created_at DESC';
      const rows = dbAll(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Single job posting with applicant count
  app.get('/api/job-postings/:id', auth, (req, res) => {
    try {
      const posting = dbGet('SELECT * FROM job_postings WHERE id = ?', [req.params.id]);
      if (!posting) return res.status(404).json({ error: 'Job posting not found' });
      const countRow = dbGet('SELECT COUNT(*) as count FROM applicants WHERE job_posting_id = ?', [req.params.id]);
      posting.applicant_count = countRow ? countRow.count : 0;
      res.json(posting);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create job posting
  app.post('/api/job-postings', auth, managerOrAdmin, (req, res) => {
    try {
      const { title, department, location, employment_type, salary_min, salary_max, salary_type, description, requirements } = req.body;
      if (!title) return res.status(400).json({ error: 'Title is required' });
      dbRun(
        `INSERT INTO job_postings (title, department, location, employment_type, salary_min, salary_max, salary_type, description, requirements, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, department || null, location || null, employment_type || 'full-time',
         salary_min || null, salary_max || null, salary_type || 'yearly',
         description || null, requirements || null, req.user.username]
      );
      const id = lastInsertId();
      audit(req, 'CREATE_JOB_POSTING', 'job_postings', id, { title });
      res.status(201).json({ id, message: 'Job posting created' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update job posting
  app.put('/api/job-postings/:id', auth, managerOrAdmin, (req, res) => {
    try {
      const existing = dbGet('SELECT id FROM job_postings WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Job posting not found' });
      const fields = ['title', 'department', 'location', 'employment_type', 'salary_min', 'salary_max', 'salary_type', 'description', 'requirements', 'status'];
      const sets = [];
      const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          sets.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(req.params.id);
      dbRun(`UPDATE job_postings SET ${sets.join(', ')} WHERE id = ?`, params);
      audit(req, 'UPDATE_JOB_POSTING', 'job_postings', req.params.id, req.body);
      res.json({ message: 'Job posting updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Close job posting
  app.put('/api/job-postings/:id/close', auth, managerOrAdmin, (req, res) => {
    try {
      const existing = dbGet('SELECT id FROM job_postings WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Job posting not found' });
      dbRun("UPDATE job_postings SET status = 'closed', closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [req.params.id]);
      audit(req, 'CLOSE_JOB_POSTING', 'job_postings', req.params.id, {});
      res.json({ message: 'Job posting closed' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete job posting
  app.delete('/api/job-postings/:id', auth, adminOnly, (req, res) => {
    try {
      const existing = dbGet('SELECT id FROM job_postings WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Job posting not found' });
      dbRun('DELETE FROM job_postings WHERE id = ?', [req.params.id]);
      audit(req, 'DELETE_JOB_POSTING', 'job_postings', req.params.id, {});
      res.json({ message: 'Job posting deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════
     APPLICANTS
  ═══════════════════════════════════════════════════════════ */

  // List applicants with optional filters
  app.get('/api/applicants', auth, (req, res) => {
    try {
      const conditions = [];
      const params = [];
      if (req.query.stage) {
        conditions.push('a.stage = ?');
        params.push(req.query.stage);
      }
      if (req.query.job_posting_id) {
        conditions.push('a.job_posting_id = ?');
        params.push(req.query.job_posting_id);
      }
      if (req.query.search) {
        conditions.push("(a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ?)");
        const term = `%${req.query.search}%`;
        params.push(term, term, term);
      }
      let sql = `SELECT a.*, jp.title AS job_title
                 FROM applicants a
                 LEFT JOIN job_postings jp ON jp.id = a.job_posting_id`;
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY a.created_at DESC';
      const rows = dbAll(sql, params);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Single applicant with job posting title
  app.get('/api/applicants/:id', auth, (req, res) => {
    try {
      const row = dbGet(
        `SELECT a.*, jp.title AS job_title
         FROM applicants a
         LEFT JOIN job_postings jp ON jp.id = a.job_posting_id
         WHERE a.id = ?`,
        [req.params.id]
      );
      if (!row) return res.status(404).json({ error: 'Applicant not found' });
      res.json(row);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create applicant
  app.post('/api/applicants', auth, editorOrAbove, (req, res) => {
    try {
      const { job_posting_id, first_name, last_name, email, phone, resume_text, source, indeed_job_id, notes } = req.body;
      if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' });
      dbRun(
        `INSERT INTO applicants (job_posting_id, first_name, last_name, email, phone, resume_text, source, indeed_job_id, notes, stage, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`,
        [job_posting_id || null, first_name, last_name, email || null, phone || null,
         resume_text || null, source || 'indeed', indeed_job_id || null, notes || null, req.user.username]
      );
      const id = lastInsertId();
      audit(req, 'CREATE_APPLICANT', 'applicants', id, { first_name, last_name });
      res.status(201).json({ id, message: 'Applicant created' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update applicant
  app.put('/api/applicants/:id', auth, editorOrAbove, (req, res) => {
    try {
      const existing = dbGet('SELECT id FROM applicants WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Applicant not found' });
      const fields = ['job_posting_id', 'first_name', 'last_name', 'email', 'phone', 'resume_text', 'source', 'indeed_job_id', 'notes'];
      const sets = [];
      const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          sets.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      }
      if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
      sets.push("updated_at = datetime('now')");
      params.push(req.params.id);
      dbRun(`UPDATE applicants SET ${sets.join(', ')} WHERE id = ?`, params);
      audit(req, 'UPDATE_APPLICANT', 'applicants', req.params.id, req.body);
      res.json({ message: 'Applicant updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Change applicant stage
  app.put('/api/applicants/:id/stage', auth, editorOrAbove, (req, res) => {
    try {
      const { stage } = req.body;
      if (!stage || !VALID_STAGES.includes(stage)) {
        return res.status(400).json({ error: `Invalid stage. Must be one of: ${VALID_STAGES.join(', ')}` });
      }
      const existing = dbGet('SELECT id FROM applicants WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Applicant not found' });
      let extra = '';
      if (stage === 'rejected') extra = ", rejected_at = datetime('now')";
      dbRun(`UPDATE applicants SET stage = ?, updated_at = datetime('now')${extra} WHERE id = ?`, [stage, req.params.id]);
      audit(req, 'UPDATE_APPLICANT_STAGE', 'applicants', req.params.id, { stage });
      res.json({ message: `Stage updated to ${stage}` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Convert applicant to employee
  app.post('/api/applicants/:id/convert-to-employee', auth, managerOrAdmin, (req, res) => {
    try {
      const applicant = dbGet('SELECT * FROM applicants WHERE id = ?', [req.params.id]);
      if (!applicant) return res.status(404).json({ error: 'Applicant not found' });
      if (applicant.employee_id) return res.status(400).json({ error: 'Applicant already converted to employee' });

      dbRun(
        `INSERT INTO employees (first_name, last_name, email, phone, status) VALUES (?, ?, ?, ?, 'active')`,
        [applicant.first_name, applicant.last_name, applicant.email || null, applicant.phone || null]
      );
      const employeeId = lastInsertId();

      dbRun(
        `UPDATE applicants SET stage = 'hired', hired_at = datetime('now'), employee_id = ?, updated_at = datetime('now') WHERE id = ?`,
        [employeeId, req.params.id]
      );

      audit(req, 'CONVERT_APPLICANT_TO_EMPLOYEE', 'applicants', req.params.id, { employee_id: employeeId });
      res.status(201).json({ employee_id: employeeId, message: 'Applicant converted to employee' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete applicant
  app.delete('/api/applicants/:id', auth, adminOnly, (req, res) => {
    try {
      const existing = dbGet('SELECT id FROM applicants WHERE id = ?', [req.params.id]);
      if (!existing) return res.status(404).json({ error: 'Applicant not found' });
      dbRun('DELETE FROM applicants WHERE id = ?', [req.params.id]);
      audit(req, 'DELETE_APPLICANT', 'applicants', req.params.id, {});
      res.json({ message: 'Applicant deleted' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ═══════════════════════════════════════════════════════════
     RECRUITING STATS
  ═══════════════════════════════════════════════════════════ */

  app.get('/api/recruiting/stats', auth, (req, res) => {
    try {
      const openPostings = dbGet("SELECT COUNT(*) as count FROM job_postings WHERE status = 'open'");
      const totalApplicants = dbGet('SELECT COUNT(*) as count FROM applicants');
      const stageRows = dbAll('SELECT stage, COUNT(*) as count FROM applicants GROUP BY stage');
      const byStage = {};
      for (const r of stageRows) byStage[r.stage] = r.count;
      const recentApplicants = dbAll(
        `SELECT a.id, a.first_name, a.last_name, a.stage, a.created_at, jp.title AS job_title
         FROM applicants a
         LEFT JOIN job_postings jp ON jp.id = a.job_posting_id
         ORDER BY a.created_at DESC LIMIT 5`
      );
      res.json({
        open_postings: openPostings ? openPostings.count : 0,
        total_applicants: totalApplicants ? totalApplicants.count : 0,
        by_stage: byStage,
        recent_applicants: recentApplicants,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
