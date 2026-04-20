-- 001_badges_and_user_fields.sql
-- Adds:
--   employees.badge_number TEXT (UNIQUE via index)
--   employees.photo_url    TEXT
--   users.email            TEXT
--   users.phone            TEXT
--   users.employee_id      INTEGER (FK -> employees.id, nullable)
-- Backfills badge_number by employment_date ASC, id ASC -> EMP-0001, EMP-0002, ...

BEGIN;

ALTER TABLE employees ADD COLUMN badge_number TEXT;
ALTER TABLE employees ADD COLUMN photo_url    TEXT;

ALTER TABLE users ADD COLUMN email       TEXT;
ALTER TABLE users ADD COLUMN phone       TEXT;
ALTER TABLE users ADD COLUMN employee_id INTEGER REFERENCES employees(id);

WITH ranked AS (
  SELECT id,
         printf("EMP-%04d", ROW_NUMBER() OVER (
           ORDER BY
             CASE WHEN employment_date IS NULL OR employment_date = "" THEN 1 ELSE 0 END,
             employment_date ASC,
             id ASC
         )) AS new_badge
  FROM employees
)
UPDATE employees
SET badge_number = (SELECT new_badge FROM ranked WHERE ranked.id = employees.id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_badge_number ON employees(badge_number);

COMMIT;
