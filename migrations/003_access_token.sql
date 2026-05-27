-- 003_access_token.sql
-- Adds employees.access_token — a cryptographically random token used as the
-- barcode/QR payload on physical ID badges (door access).
--
-- IMPORTANT: access_token is NEVER the same as badge_number.
--   badge_number  → human-readable display label (EMP-0001). Shown on card, in the UI.
--   access_token  → barcode payload (EMS-<32 hex chars>). Never displayed; validated
--                   server-side by the door controller via GET /api/access/validate/:token
--
-- Backfill: existing employees get NULL here; the server generates tokens for
-- them on the first save or when rotate-token is called.

BEGIN;
ALTER TABLE employees ADD COLUMN access_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_access_token ON employees(access_token);
COMMIT;
