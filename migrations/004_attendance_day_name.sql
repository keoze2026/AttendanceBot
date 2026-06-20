-- 004_attendance_day_name.sql
-- Put the staff username + name directly on each day row, so a login record is
-- self-describing (no JOIN to attendance_staff needed to see who it is).
--
-- Apply after 003:
--   PGPASSWORD='<password>' psql -h localhost -U crm_user -d crm -f migrations/004_attendance_day_name.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a backfill, safe to re-run.

ALTER TABLE attendance_days ADD COLUMN IF NOT EXISTS username     TEXT;
ALTER TABLE attendance_days ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Backfill any rows created before this migration from the staff directory.
UPDATE attendance_days d
   SET username     = COALESCE(d.username, s.username),
       display_name = COALESCE(d.display_name, s.display_name)
  FROM attendance_staff s
 WHERE s.user_id = d.user_id
   AND (d.display_name IS NULL OR d.username IS NULL);
