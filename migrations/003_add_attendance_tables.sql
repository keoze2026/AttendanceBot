-- 003_add_attendance_tables.sql
-- Staff-attendance Telegram bot — long-term storage.
-- Applied to the SAME PostgreSQL database as the CallFlow CRM (database "crm").
--
-- Apply with (mirrors MAINTENANCE.md -> Migrations):
--   PGPASSWORD='<password>' psql -h localhost -U crm_user -d crm -f migrations/003_add_attendance_tables.sql
--
-- IMPORTANT: these tables hold long-term attendance history and are deliberately
-- NOT referenced by server/database/cleanup.php, so the 40-day retention job
-- never purges them. Do not add them to that job.
--
-- Idempotent: uses CREATE TABLE IF NOT EXISTS, safe to re-run.

CREATE TABLE IF NOT EXISTS attendance_staff (
    user_id      BIGINT      PRIMARY KEY,              -- Telegram user id
    username     TEXT,                                 -- @handle without @, may be null
    display_name TEXT,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per staff member per working day.
CREATE TABLE IF NOT EXISTS attendance_days (
    user_id           BIGINT      NOT NULL REFERENCES attendance_staff(user_id) ON DELETE CASCADE,
    work_date         DATE        NOT NULL,            -- working day in the bot's TIMEZONE
    login_at          TIMESTAMPTZ,                     -- when the login message was sent
    login_stated      TEXT,                            -- time the staff typed, e.g. "8:48 AM EST"
    login_message_id  BIGINT,
    logout_at         TIMESTAMPTZ,                     -- when the "Goodnight" message was sent
    logout_stated     TEXT,
    logout_message_id BIGINT,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, work_date)
);

-- One row per break taken (from the break groups).
CREATE TABLE IF NOT EXISTS attendance_breaks (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES attendance_staff(user_id) ON DELETE CASCADE,
    work_date    DATE        NOT NULL,
    taken_at     TIMESTAMPTZ NOT NULL,
    duration_min INTEGER     NOT NULL CHECK (duration_min > 0),
    urgent       BOOLEAN     NOT NULL DEFAULT false,
    raw          TEXT,
    group_id     TEXT,                                 -- which break group it came from
    message_id   BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_id, message_id)                      -- de-dupe replays/edits
);

-- Single-row diagnostics table (timestamp of the last message the bot processed).
CREATE TABLE IF NOT EXISTS attendance_state (
    id                INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_processed_at TIMESTAMPTZ
);
INSERT INTO attendance_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_attendance_days_date        ON attendance_days (work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_breaks_user_date ON attendance_breaks (user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendance_breaks_date      ON attendance_breaks (work_date);
