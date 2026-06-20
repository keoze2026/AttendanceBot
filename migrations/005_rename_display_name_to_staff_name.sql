-- 005_rename_display_name_to_staff_name.sql
-- Rename the staff-name column to "staff_name" on both tables.
-- Convergent + idempotent: brings the database to the final shape regardless of
-- whether migration 004 was applied, and is safe to re-run.
--
-- Apply:
--   PGPASSWORD='<password>' psql -h localhost -U crm_user -d crm -f migrations/005_rename_display_name_to_staff_name.sql

DO $$
BEGIN
  -- attendance_staff.display_name -> staff_name
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'attendance_staff' AND column_name = 'display_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'attendance_staff' AND column_name = 'staff_name') THEN
    ALTER TABLE attendance_staff RENAME COLUMN display_name TO staff_name;
  END IF;

  -- attendance_days.display_name -> staff_name
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'display_name')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'attendance_days' AND column_name = 'staff_name') THEN
    ALTER TABLE attendance_days RENAME COLUMN display_name TO staff_name;
  END IF;
END $$;

-- Make sure the final columns exist even if migration 004 was never applied.
ALTER TABLE attendance_staff ADD COLUMN IF NOT EXISTS staff_name TEXT;
ALTER TABLE attendance_days  ADD COLUMN IF NOT EXISTS staff_name TEXT;
ALTER TABLE attendance_days  ADD COLUMN IF NOT EXISTS username   TEXT;

-- Backfill day rows from the staff directory.
UPDATE attendance_days d
   SET staff_name = COALESCE(d.staff_name, s.staff_name),
       username   = COALESCE(d.username,   s.username)
  FROM attendance_staff s
 WHERE s.user_id = d.user_id
   AND (d.staff_name IS NULL OR d.username IS NULL);
