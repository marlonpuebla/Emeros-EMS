'use strict';
/**
 * HR Automated Credential Reminder Scheduler
 *
 * Monitors ALL 11 expiration fields:
 *   license_expiration, dea_expiration, driver_license_expiration,
 *   ahca_background_expiration, professional_liability_expiration,
 *   ceu_expiration, cpr_bls_expiration, passport_expiration,
 *   i9_expiration, exemption_worker_comp_expiration, yearly_evaluation_due
 *
 * Reminder schedule (per field, per employee):
 *   - 90 days before expiration
 *   - 60 days before expiration
 *   - 30 days before expiration
 *   -  7 days before expiration
 *   -  On the day of expiration (day 0)
 *   -  Each day for 7 days AFTER expiration (expired reminders)
 *
 * Duplicate prevention: tracks sent reminders in audit_log.
 * A reminder at a given threshold is only sent once per employee per field.
 */

const cron = require('node-cron');
const { sendCredentialReminder, sendWeeklyDigest, CRED_LABELS } = require('./email.service');

// Reminder thresholds in days (positive = before expiry, 0 = on day, negative = after)
const REMINDER_THRESHOLDS = [90, 60, 30, 7, 0];
// Also send once per day for 7 days after expiration
const POST_EXPIRY_DAYS = 7;

module.exports = function startScheduler(dbGet, dbAll, dbRun) {

  /* ── Helper: check if reminder was already sent ── */
  function wasReminderSent(empId, field, threshold) {
    const key = `CRED_REMINDER:${empId}:${field}:${threshold}`;
    const row = dbGet(
      "SELECT id FROM audit_log WHERE action='EMAIL_CREDENTIAL_REMINDER' AND detail LIKE ? AND ts > datetime('now','-2 days')",
      [`%${key}%`]
    );
    return !!row;
  }

  function markReminderSent(empId, empName, field, threshold) {
    const key = `CRED_REMINDER:${empId}:${field}:${threshold}`;
    dbRun(
      'INSERT INTO audit_log (username,action,entity,entity_id,detail) VALUES (?,?,?,?,?)',
      ['system', 'EMAIL_CREDENTIAL_REMINDER', 'employees', empId,
       JSON.stringify({ key, name: empName, field, threshold })]
    );
  }

  /* ── Daily credential check — 8:00 AM ET every day ── */
  cron.schedule('0 8 * * *', async () => {
    console.log(`[Scheduler] ${new Date().toISOString()} — Running daily credential check…`);
    try {
      const today   = new Date().toISOString().split('T')[0];
      const emps    = dbAll(
        "SELECT * FROM employees WHERE status='active' AND email IS NOT NULL AND email != '' AND email != 'N/A'"
      );

      let sent = 0, skipped = 0;

      for (const emp of emps) {
        const empName = `${emp.first_name} ${emp.last_name}`;
        // Collect all fields that need a reminder today
        const toRemind = [];

        for (const field of Object.keys(CRED_LABELS)) {
          const dateStr = emp[field];
          if (!dateStr || dateStr === 'N/A') continue;

          let expDate;
          try { expDate = new Date(dateStr + 'T00:00:00'); } catch { continue; }
          const daysUntil = Math.ceil((expDate - new Date(today + 'T00:00:00')) / 86400000);

          // Determine which threshold this falls on (if any)
          let threshold = null;
          if (REMINDER_THRESHOLDS.includes(daysUntil)) {
            threshold = daysUntil;
          } else if (daysUntil < 0 && daysUntil >= -POST_EXPIRY_DAYS) {
            // Post-expiry daily reminder (use actual days value as threshold key)
            threshold = daysUntil;
          }

          if (threshold === null) continue;

          // Skip if already sent this reminder
          if (wasReminderSent(emp.id, field, threshold)) {
            skipped++;
            continue;
          }

          toRemind.push({ field, date: dateStr, daysUntil });
        }

        // Send one combined email per employee covering all due reminders
        if (toRemind.length > 0) {
          // Group by urgency — most urgent drives the subject line
          const minDays = Math.min(...toRemind.map(r => r.daysUntil));
          try {
            await sendCredentialReminder(
              emp,
              toRemind.map(r => [r.field, r.date]),
              minDays
            );
            // Mark all as sent
            for (const r of toRemind) {
              const threshold = REMINDER_THRESHOLDS.includes(r.daysUntil)
                ? r.daysUntil : r.daysUntil;
              markReminderSent(emp.id, empName, r.field, threshold);
            }
            sent++;
            console.log(`[Scheduler]   Sent reminder to ${empName} — ${toRemind.length} credential(s) (${minDays}d)`);
          } catch (e) {
            console.error(`[Scheduler]   Error sending to ${empName}:`, e.message);
          }
        }
      }

      console.log(`[Scheduler] Daily check complete — ${sent} reminder email(s) sent, ${skipped} already sent.`);
    } catch (e) {
      console.error('[Scheduler] Daily check error:', e.message);
    }
  }, { timezone: 'America/New_York' });

  /* ── Weekly admin digest — Monday 7:00 AM ET ── */
  cron.schedule('0 7 * * 1', async () => {
    console.log(`[Scheduler] ${new Date().toISOString()} — Sending weekly HR digest…`);
    try {
      const total      = dbGet('SELECT COUNT(*) as n FROM employees').n;
      const active     = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='active'").n;
      const discharged = dbGet("SELECT COUNT(*) as n FROM employees WHERE status='discharged'").n;
      const today      = new Date().toISOString().split('T')[0];
      const in30       = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

      const emps   = dbAll("SELECT * FROM employees WHERE status='active'");
      const alerts = [];

      for (const emp of emps) {
        for (const field of Object.keys(CRED_LABELS)) {
          const d = emp[field];
          if (!d || d === 'N/A') continue;
          const daysUntil = Math.ceil((new Date(d) - new Date(today)) / 86400000);
          // Bug fix: was comparing date strings (d <= in30) which breaks for non-ISO
          // formats. Compare numeric days instead.
          if (daysUntil <= 30) {
            alerts.push({
              name:  `${emp.last_name}, ${emp.first_name}`,
              field, date: d, days: daysUntil,
            });
          }
        }
      }
      alerts.sort((a, b) => a.days - b.days);

      await sendWeeklyDigest({ total, active, discharged }, alerts);
      console.log(`[Scheduler] Weekly digest sent — ${alerts.length} credential alert(s).`);
    } catch (e) {
      console.error('[Scheduler] Weekly digest error:', e.message);
    }
  }, { timezone: 'America/New_York' });

  console.log('[Scheduler] ✓ Started');
  console.log('[Scheduler]   Daily credential check:  8:00 AM ET every day');
  console.log('[Scheduler]   Weekly admin digest:     7:00 AM ET every Monday');
  console.log(`[Scheduler]   Monitoring ${Object.keys(CRED_LABELS).length} credential fields per employee`);
  console.log(`[Scheduler]   Thresholds: ${[...REMINDER_THRESHOLDS, '...(daily post-expiry for 7 days)'].join(', ')}`);
};
