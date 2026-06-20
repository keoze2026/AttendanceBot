-- 006_add_break_staff_name.sql
-- Include staff_name on attendance_breaks too, so `SELECT * FROM attendance_breaks`
-- shows who took the break without a join.
--
-- Apply:
--   PGPASSWORD='<password>' psql -h localhost -U crm_user -d crm -f migrations/006_add_break_staff_name.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a backfill, safe to re-run.

ALTER TABLE attendance_breaks ADD COLUMN IF NOT EXISTS staff_name TEXT;

-- Backfill existing break rows from the matching day row.
UPDATE attendance_breaks b
   SET staff_name = COALESCE(b.staff_name, d.staff_name)
  FROM attendance_days d
 WHERE d.user_id = b.user_id AND d.work_date = b.work_date
   AND b.staff_name IS NULL;
