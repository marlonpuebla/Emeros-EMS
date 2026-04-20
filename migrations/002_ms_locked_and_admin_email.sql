-- 002_ms_locked_and_admin_email.sql
-- Adds users.ms_locked (0/1). When 1, the user can ONLY sign in via Microsoft
-- SSO; local password login is rejected. Set to 1 automatically after the
-- user's first successful Microsoft login. Admin can clear it.
-- Also backfills the admin account's email.

BEGIN;

ALTER TABLE users ADD COLUMN ms_locked INTEGER DEFAULT 0;

UPDATE users SET email = 'info@thecommunitywellness.com' WHERE username = 'admin';

COMMIT;
