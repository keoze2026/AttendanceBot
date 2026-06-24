-- 007_add_break_returned_at.sql
-- Track when a staff member returned from a break ("I'm back" / "back"), so the
-- bot can compare the ACTUAL break length against the stated duration ("taking 30")
-- and flag anyone who overstays.
--
-- Apply:
--   PGPASSWORD='<password>' psql -h localhost -U crm_user -d crm -f migrations/007_add_break_returned_at.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run. Existing breaks keep a
-- NULL returned_at (treated as "still open / never closed").

ALTER TABLE attendance_breaks ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;

-- Speeds up "find this user's open break for the day" lookups done on each
-- "I'm back" message.
CREATE INDEX IF NOT EXISTS idx_attendance_breaks_open
    ON attendance_breaks (user_id, work_date)
    WHERE returned_at IS NULL;
