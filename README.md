# Staff Attendance Telegram Bot

A TypeScript Telegram **bot** that **silently** records staff attendance across
**three groups** and exports everything to an Excel sheet. It listens quietly in the
background, never posts, and needs no `/start`.

- **Main group** (`TELEGRAM_GROUP`) — login/logout.
- **Two break groups** (`TELEGRAM_BREAK_GROUPS`) — breaks.

One bot, added to all three, routes each message by which group it came from.

In the main group it reads messages like:

```
Good Morning
Logged in - 8:48 AM EST.
```

and end-of-day messages like:

```
Goodnight
```

In the break groups it reads messages like `Taking 30`, `taking urgent 15`, etc.,
where the number is the duration in minutes.

Matching is **case-insensitive** and works whether a message is one line, two lines,
or three. For each staff member each working day it records the **username**, the
**login** and **logout** times, and the **breaks taken** — and flags anyone who
exceeds their break allowance.

---

## How it works (and one limitation to know)

This uses the Telegram **Bot API** (via [grammy](https://grammy.dev)). You create a
bot with **@BotFather** and add it to your group **as an admin**.

- ✅ Records every new message from the moment it's running — silently, no `/start`.
- ✅ If the bot is briefly offline, Telegram holds updates for ~24h and it **catches
  up automatically** on restart.
- ⚠️ **A bot cannot read messages sent before it joined.** The Bot API has no
  "get history" method, so there is **no backtracking** — recording starts from when
  the bot goes live. (If you ever need to import older history, that requires a user
  account / MTProto instead.)

---

## 1. Create the bot

1. Open Telegram, talk to **@BotFather**, send `/newbot`, follow the prompts.
2. Copy the **token** it gives you (looks like `123456:ABC-DEF...`).
3. Add the bot to **all three groups** (main + 2 break groups). So it can see *all*
   messages (not just `/commands`), in each group do **either**:
   - **Make it an administrator** (recommended), **or**
   - In BotFather: `/setprivacy` → select the bot → **Disable**.

## 2. Install

```bash
npm install
```

## 3. Configure

```bash
cp .env.example .env
```

Set:
- `TELEGRAM_BOT_TOKEN` — from BotFather.
- `TELEGRAM_GROUP` — the **main** login/logout group id (required).
- `TELEGRAM_BREAK_GROUPS` — the two **break** group ids, comma-separated.

Everything else — keywords, break allowance, timezone, start date, file paths — is
configurable in [.env.example](.env.example).

> **Finding a group id:** add the bot to the group, send any message there, and read
> the bot's log output (it logs the chat id of messages it sees) — or use a helper
> like @RawDataBot. Group ids look like `-1001234567890`.

## 4. Run

Development:

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

All activity is logged to the console (stdout/stderr). Nothing is ever posted to the
group.

---

## Breaks & allowance

In the break groups, staff declare breaks by typing the keyword + a duration:

```
Taking 30
taking urgent 15
```

The number is the duration in minutes; `urgent` (configurable) tags the break type.
Each break folds into that staff member's day. The bot tallies the minutes and flags
the day when the total goes over `DAILY_BREAK_ALLOWANCE_MIN` (default 60), showing how
many minutes they're over.

When the user comes back they post a return message in the break group:

```
I'm back
back
```

The bot matches it to their currently open break, measures the **actual** time away
(return time − break-start time), and compares it to the stated duration. There's a
grace window (`BREAK_GRACE_MIN`, default 10): a break is only flagged once the actual
time away exceeds **stated + grace**. So someone who typed `Taking 30` and is back
within 40 minutes is fine; back after an hour is flagged as **20 minutes late**
(60 − 30 stated − 10 grace). (`back` is matched as a whole word, so `background` /
`comeback` don't trigger it.)

Configurable in `.env`:

```env
BREAK_KEYWORDS=taking
BREAK_URGENT_KEYWORDS=urgent
BACK_KEYWORDS=i'm back,im back,i am back,back,im online,back online
DAILY_BREAK_ALLOWANCE_MIN=60
BREAK_GRACE_MIN=10
URGENT_COUNTS_TOWARD_ALLOWANCE=true
```

Notes / assumptions (tell me to change any):
- The **allowance** tally uses the **stated duration** in each message. The separate
  **late** flag uses the measured return time and the grace window, so the two are
  independent: a break can be within the daily allowance yet still flagged for coming
  back late, or vice versa.
- A return message closes the **most recently started** still-open break. A `back`
  with no open break (already returned, or no prior `taking`) is ignored.
- **Urgent breaks count** toward the allowance by default (set the flag to `false` to
  exclude them — they're still recorded and shown).

## Storage & output

- `data/attendance.json` is the **long-term source of truth**: one row per staff
  member per working day. Point a real database at this later — only `src/store.ts`
  touches storage.
- `data/attendance.xlsx` is **regenerated from the JSON** after each change (for
  testing/review). Delete it any time; it gets rebuilt.
- `data/state.json` keeps a small diagnostic timestamp.

**Attendance Log** sheet — one row per staff member per day: date, username, name,
user id, login/logout (stated + recorded), gross hours, **net hours** (gross minus
breaks), break count, break minutes, allowance, minutes over, **late (min)**
(total minutes their breaks ran past stated + grace), **break status**
(`OK` / `OVER by Nm` / `+Nm late (past 10m grace)`, highlighted red when flagged), and
a break detail string like `30 (→60, +20), urgent 15` — stated, then `→actual` and
`+late` once the user is back.

- *stated* = the time the staff member typed (e.g. `8:48 AM EST`).
- *recorded* = the actual time the Telegram message was sent (in `TIMEZONE`).

**Breaks** sheet — every individual break: date, who, start time, **return time**
(`— still out —` if they never said "back"), stated minutes, **actual minutes**,
**late minutes** (red when > 0 — minutes past stated + grace), type (regular/urgent),
which group, and the original message.

**Staff Summary** sheet — long-term totals per staff member (days present, days with a
logout, first/last day, total hours, total break minutes, **excess min** — total
minutes over the break allowance, and **late min** — total minutes returning late past
the grace window).

The "working day" is computed in `TIMEZONE`, so a `Goodnight` sent just after midnight
still attaches to the correct day's login.

---

## Deploying on a Hostinger VPS (always-on)

```bash
# on the VPS, in the project folder
npm install
npm run build
cp .env.example .env      # then edit .env with your token

npm i -g pm2
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 startup               # follow the printed command so it restarts on reboot

pm2 logs staff-attendance-bot     # view logs
```

### Alternative: systemd

```ini
# /etc/systemd/system/staff-attendance-bot.service
[Unit]
Description=Staff Attendance Telegram Bot
After=network-online.target

[Service]
WorkingDirectory=/root/Staff_attendance
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now staff-attendance-bot
journalctl -u staff-attendance-bot -f    # view logs
```

> Long polling is used, so **no public URL, domain, or SSL is required** — it works on
> a bare VPS.

---

## Customising what counts as login / logout

In `.env`:

```env
LOGIN_KEYWORDS=logged in,clocked in
LOGOUT_KEYWORDS=goodnight,good night,logging out
```

A message is a login/logout if it **contains** any of these phrases (case-insensitive).
The login time shown is parsed from the message text when present (e.g. `8:48 AM EST`),
otherwise the message's send time is used. `Goodnight` usually has no time, so the send
time is used.
