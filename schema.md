# Staff Attendance — Data Schema & Integration Guide

For the front-end developer building management dashboards on top of the staff-attendance
data. It explains **what the data is, where it lives, what every field means, the rules you
must respect, ready-made queries** for common management views, and a **recommended API
contract** with example JSON and TypeScript types.

---

## 1. What this data is & where it lives

A Telegram bot records staff **login**, **logout**, and **break** events from work groups and
writes them to **PostgreSQL**. The data lives in the **same database as the CRM** (`crm`),
in four tables prefixed `attendance_`:

| Table | Grain | Use it for |
|-------|-------|-----------|
| `attendance_staff` | one row per person | the staff directory |
| `attendance_days` | one row per person **per working day** | daily attendance, hours, timesheets |
| `attendance_breaks` | one row per break taken | break detail & break-time totals |
| `attendance_state` | single diagnostics row | ignore (internal to the bot) |

**Source of truth:** PostgreSQL. The bot updates it continuously (near real-time). There is
also an Excel export, but that's just a review artifact — **build against the database.**

> ⚠️ **Access pattern:** do **not** connect the React app directly to PostgreSQL. Go through
> the CRM's PHP API (it already proxies `/api/*` to the backend). Add read-only attendance
> endpoints there (see §6) so DB credentials never reach the browser.

---

## 2. Entity relationships

```
attendance_staff (user_id) ──1───<  attendance_days   (user_id, work_date)   [PK]
        │
        └──────────────────1───<  attendance_breaks (id) ; (user_id, work_date) links to a day
```

- A **day** is keyed by `(user_id, work_date)`.
- **Breaks** belong to a person and carry their own `(user_id, work_date)`, so you join breaks
  to a day on **both** columns: `b.user_id = d.user_id AND b.work_date = d.work_date`.
- `user_id` is the **Telegram user id** — the stable identifier across all tables.

---

## 3. Table reference

### 3.1 `attendance_staff` — directory

| Column | Type | Null | Meaning |
|--------|------|------|---------|
| `user_id` | `bigint` (PK) | no | Telegram user id (stable key) |
| `username` | `text` | yes | Telegram `@handle` **without** the `@`; may be null |
| `staff_name` | `text` | yes | First + last name from Telegram |
| `first_seen` | `timestamptz` | no | First time the bot saw this person |
| `last_seen` | `timestamptz` | no | Most recent activity |

### 3.2 `attendance_days` — one row per person per working day  ← **main table**

| Column | Type | Null | Meaning |
|--------|------|------|---------|
| `user_id` | `bigint` | no | FK → `attendance_staff.user_id` (PK part) |
| `work_date` | `date` | no | The **working day** in the org timezone (PK part) |
| `staff_name` | `text` | yes | Name snapshot for this row |
| `username` | `text` | yes | `@handle` snapshot for this row |
| `login_at` | `timestamptz` | yes | When the login message was **sent** (UTC in DB) |
| `login_stated` | `text` | yes | The time the staff **typed**, e.g. `"8:48 AM EST"` (free text) |
| `login_message_id` | `bigint` | yes | Telegram message id of the login |
| `logout_at` | `timestamptz` | yes | When the "Goodnight" message was sent; **null = no logout recorded** |
| `logout_stated` | `text` | yes | Stated logout time, if any (usually null) |
| `logout_message_id` | `bigint` | yes | Telegram message id of the logout |
| `updated_at` | `timestamptz` | no | Last time this row changed |

### 3.3 `attendance_breaks` — one row per break

| Column | Type | Null | Meaning |
|--------|------|------|---------|
| `id` | `bigint` (PK) | no | Surrogate key |
| `user_id` | `bigint` | no | Who took the break |
| `work_date` | `date` | no | Working day the break belongs to |
| `staff_name` | `text` | yes | Name snapshot |
| `taken_at` | `timestamptz` | no | When the break message was sent |
| `duration_min` | `integer` | no | **Stated** duration in minutes (`> 0`) |
| `urgent` | `boolean` | no | True if flagged "urgent" (e.g. `taking urgent 15`) |
| `raw` | `text` | yes | The original message text |
| `group_id` | `text` | yes | Which break group it came from |
| `message_id` | `bigint` | yes | Telegram message id |
| `created_at` | `timestamptz` | no | Row insert time |

Unique on `(group_id, message_id)` — the bot de-duplicates, so you won't see the same break twice.

---

## 4. Rules & gotchas you MUST respect

1. **Timezone.** `work_date` is the **already-localized working day** in the org timezone
   (currently **`America/New_York`** — see §8). `login_at` / `logout_at` / `taken_at` are
   `timestamptz` stored in **UTC**. For display, convert timestamps to the **org timezone**,
   not the viewer's browser zone — otherwise times won't line up with `work_date`.
2. **`login_stated` vs `login_at`.** `login_stated` is whatever the person typed (free text,
   may be malformed or absent). `login_at` is the reliable machine timestamp. Use `login_at`
   for calculations; show `login_stated` as a courtesy.
3. **One row per person per day.** The bot keeps the **earliest login** and the **latest
   logout** of the day. Don't expect multiple login rows per day.
4. **`logout_at IS NULL`** means no "Goodnight" was recorded — the person is either **still
   working** (today) or **forgot to log out** (past days). Treat these distinctly (see §5E).
5. **Hours** = `logout_at - login_at` (only when both exist). **Net hours** = hours − break
   minutes. There is no stored "hours" column — compute it (queries below).
6. **Break allowance is a config constant, not a column.** Default **60 min/day**. "Over" =
   `total break minutes − allowance`. Whether **urgent** breaks count is configurable
   (default: they **do** count). See §8.
7. **`username` can be null.** Always display `staff_name` as the primary label; fall back to
   `@username`, then `user_id`.
8. **`user_id` is a `bigint`** — larger than JS can safely represent. The Postgres driver
   returns it as a **string**; keep it a string in the front end (don't `parseInt`).
9. **Near real-time.** Rows appear/update within seconds of a message. Safe to poll or
   refresh; no need for websockets.

---

## 5. Ready-made SQL for management views

All examples assume the org timezone `America/New_York` — change it in one place if §8 changes.

### A) Daily roster (a given date)
```sql
SELECT user_id, staff_name, username, login_stated, login_at, logout_at,
       (login_at IS NOT NULL)                       AS present,
       (login_at IS NOT NULL AND logout_at IS NULL) AS still_in
FROM attendance_days
WHERE work_date = $1            -- 'YYYY-MM-DD'
ORDER BY login_at NULLS LAST;
```

### B) Who is currently logged in (today, no logout yet)
```sql
SELECT user_id, staff_name, login_at
FROM attendance_days
WHERE work_date = (now() AT TIME ZONE 'America/New_York')::date
  AND login_at IS NOT NULL AND logout_at IS NULL
ORDER BY login_at;
```

### C) Daily timesheet with hours + breaks + over-allowance (date range)
```sql
SELECT d.user_id, d.staff_name, d.username, d.work_date,
       d.login_at, d.logout_at,
       ROUND(EXTRACT(EPOCH FROM (d.logout_at - d.login_at)) / 3600.0, 2) AS hours,
       COALESCE(b.break_min, 0)                                           AS break_min,
       ROUND(EXTRACT(EPOCH FROM (d.logout_at - d.login_at)) / 3600.0
             - COALESCE(b.break_min, 0) / 60.0, 2)                        AS net_hours,
       GREATEST(COALESCE(b.break_min, 0) - 60, 0)                         AS over_break_min
FROM attendance_days d
LEFT JOIN (
  SELECT user_id, work_date, SUM(duration_min) AS break_min
  FROM attendance_breaks
  -- to EXCLUDE urgent breaks from the tally, add: WHERE NOT urgent
  GROUP BY user_id, work_date
) b ON b.user_id = d.user_id AND b.work_date = d.work_date
WHERE d.work_date BETWEEN $1 AND $2
ORDER BY d.work_date DESC, d.staff_name;
```

### D) Per-staff summary (date range) — for a management table
```sql
SELECT user_id, staff_name,
       count(*) FILTER (WHERE login_at IS NOT NULL)                          AS days_present,
       count(*) FILTER (WHERE login_at IS NOT NULL AND logout_at IS NOT NULL) AS days_complete,
       ROUND(SUM(EXTRACT(EPOCH FROM (logout_at - login_at)) / 3600.0)
             FILTER (WHERE logout_at IS NOT NULL), 2)                         AS total_hours,
       min(work_date) AS first_day, max(work_date) AS last_day
FROM attendance_days
WHERE work_date BETWEEN $1 AND $2
GROUP BY user_id, staff_name
ORDER BY staff_name;
```

### E) Exceptions — forgot to log out (past days only)
```sql
SELECT user_id, staff_name, work_date, login_at
FROM attendance_days
WHERE login_at IS NOT NULL AND logout_at IS NULL
  AND work_date < (now() AT TIME ZONE 'America/New_York')::date
ORDER BY work_date DESC;
```

### F) Exceptions — break-allowance overages (date range)
```sql
SELECT user_id, staff_name, work_date,
       SUM(duration_min)            AS break_min,
       SUM(duration_min) - 60       AS over_min
FROM attendance_breaks
WHERE work_date BETWEEN $1 AND $2
GROUP BY user_id, staff_name, work_date
HAVING SUM(duration_min) > 60
ORDER BY over_min DESC;
```

### G) Late arrivals vs a target start time (e.g. 09:00 local)
```sql
SELECT user_id, staff_name, work_date,
       (login_at AT TIME ZONE 'America/New_York')::time AS local_login
FROM attendance_days
WHERE login_at IS NOT NULL
  AND (login_at AT TIME ZONE 'America/New_York')::time > TIME '09:00'
  AND work_date BETWEEN $1 AND $2
ORDER BY work_date DESC, local_login DESC;
```
> There's no stored shift-start; pick the target time in the UI/API and compare against `login_at`.

### H) Break detail for one person & day
```sql
SELECT taken_at, duration_min, urgent, raw
FROM attendance_breaks
WHERE user_id = $1 AND work_date = $2
ORDER BY taken_at;
```

---

## 6. Recommended API (build these in the CRM PHP backend)

Read-only JSON endpoints under `/api/attendance/...`. Suggested contract:

| Method & path | Query params | Returns |
|---------------|--------------|---------|
| `GET /api/attendance/staff` | — | staff directory |
| `GET /api/attendance/roster` | `date` (default today) | roster for a day (query A) |
| `GET /api/attendance/live` | — | currently logged-in (query B) |
| `GET /api/attendance/days` | `from`, `to`, `user_id?` | daily timesheet rows (query C) |
| `GET /api/attendance/summary` | `from`, `to` | per-staff summary (query D) |
| `GET /api/attendance/breaks` | `user_id`, `date` | break detail (query H) |
| `GET /api/attendance/exceptions` | `type=missing_logout\|over_break\|late`, `from`, `to` | queries E/F/G |

**Example: `GET /api/attendance/days?from=2026-06-01&to=2026-06-20`**
```json
{
  "timezone": "America/New_York",
  "breakAllowanceMin": 60,
  "rows": [
    {
      "userId": "8671166036",
      "staffName": "Jane Doe",
      "username": "jane",
      "date": "2026-06-20",
      "loginAt": "2026-06-20T12:48:00.000Z",
      "loginStated": "8:48 AM EST",
      "logoutAt": "2026-06-21T01:30:00.000Z",
      "logoutStated": null,
      "hours": 12.7,
      "breakMin": 45,
      "netHours": 11.95,
      "overBreakMin": 0,
      "completed": true
    }
  ]
}
```

**Example: `GET /api/attendance/breaks?user_id=8671166036&date=2026-06-20`**
```json
{
  "userId": "8671166036",
  "staffName": "Jane Doe",
  "date": "2026-06-20",
  "allowanceMin": 60,
  "totalMin": 45,
  "overMin": 0,
  "breaks": [
    { "takenAt": "2026-06-20T15:00:00.000Z", "durationMin": 30, "urgent": false, "raw": "taking 30" },
    { "takenAt": "2026-06-20T17:00:00.000Z", "durationMin": 15, "urgent": true,  "raw": "taking urgent 15" }
  ]
}
```

Always include `timezone` and `breakAllowanceMin` in responses so the UI doesn't hard-code them.

---

## 7. TypeScript types for the front end

```ts
// user_id is a bigint from Postgres -> always a string in JSON. Never parseInt it.
export interface StaffMember {
  userId: string;
  username: string | null;
  staffName: string | null;
  firstSeen: string;   // ISO 8601 (UTC)
  lastSeen: string;
}

export interface AttendanceDay {
  userId: string;
  staffName: string | null;
  username: string | null;
  date: string;               // 'YYYY-MM-DD' (already in org timezone)
  loginAt: string | null;     // ISO 8601 (UTC) — use for math
  loginStated: string | null; // free text the staff typed
  logoutAt: string | null;    // null = no logout recorded
  logoutStated: string | null;
  hours: number | null;       // gross worked hours (null if no logout)
  breakMin: number;           // counted break minutes that day
  netHours: number | null;    // hours - breakMin/60
  overBreakMin: number;       // max(breakMin - allowance, 0)
  completed: boolean;         // has a logout
}

export interface BreakRecord {
  takenAt: string;            // ISO 8601 (UTC)
  durationMin: number;
  urgent: boolean;
  raw: string | null;
}

export interface StaffSummary {
  userId: string;
  staffName: string | null;
  daysPresent: number;
  daysComplete: number;
  totalHours: number;
  firstDay: string;           // 'YYYY-MM-DD'
  lastDay: string;
}
```

**Display tip:** render all timestamps in the **org timezone**, e.g.
```ts
new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true,
}).format(new Date(day.loginAt!));
```

---

## 8. Constants the UI needs (from the bot's config)

These are set in the bot's `.env` and may change — read them from the API response rather than
hard-coding, but current values are:

| Constant | Current value | Meaning |
|----------|---------------|---------|
| Org timezone | `America/New_York` | drives `work_date` and "today"; use for all display |
| Daily break allowance | `60` minutes | the per-day cap |
| Urgent counts toward allowance | `true` | whether `urgent` breaks count in the tally |

---

## 9. Suggested management screens

- **Live board** — present / on a break / out, for today (queries B + H). Auto-refresh ~30s.
- **Daily roster** — everyone for a chosen date with login/logout/hours (query A/C).
- **Per-staff timesheet** — calendar or table of days with hours & breaks (query C), plus a
  range summary header (query D).
- **Exceptions panel** — missing logouts (E), break overages (F), late arrivals (G). The most
  useful screen for management.
- **Reports / export** — monthly per-staff summary (D); offer CSV/Excel download.

---

## 10. Writing / corrections (important)

The current design is **read-only for the dashboard**. The bot **continuously upserts**
`attendance_days` by `(user_id, work_date)` and keeps the earliest login / latest logout. So:

- If you let management **edit** a login/logout directly on `attendance_days`, a later bot
  message for that same day **can overwrite it**. Don't build naive edit-in-place.
- For manual overrides/excused absences, add a **separate** mechanism the bot never touches —
  e.g. an `attendance_overrides` table (or `manual_note` / `is_excused` columns) and have the
  API prefer the override when present. Flag this and we'll add it server-side before the UI
  ships edit features.
- `staff_name` / `username` are auto-managed (refreshed from Telegram); don't treat them as
  user-editable master data.

If you need anything not covered here — extra endpoints, more computed fields, an overrides
table, or a read-only DB view that pre-joins days + breaks — ask and it'll be added on the
backend so the front end stays simple.
