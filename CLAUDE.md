# CLAUDE.md: RFID Student Attendance System

Project context for Claude Code. Read this before changing anything.

## Owner & communication
- Owner: Md Sabbir Ahamed, CSE undergraduate (City University, Savar, Dhaka).
- Reply in **Bengali** (Bangla script). Code comments are in Banglish (Bengali in Latin letters); keep that style.
- Explain steps simply and concretely. The owner deploys from GitHub to Render through the web UI. He is not a full-time backend developer.

## What the system does
1. **ESP32-S3 + RC522 RFID reader** in the classroom. A student taps a card, the board records attendance, and it POSTs the scan to this website.
2. **This website** (Node.js on Render free tier, Postgres on Neon free tier) stores attendance, students, guardians' phone numbers, exam results and class days.
3. If a student is absent for **N consecutive class days** (default 3), the server sends an **SMS to the guardian** with the absence count and the semester's exam results. Results can also be SMSed manually.

## Hardware (for reference, not in this repo)
- Board: ESP32-S3 N8R2 (two USB-C ports), Arduino core 3.x, "ESP32S3 Dev Module", 8MB flash.
- RC522 over SPI: SDA/SS=GPIO10, SCK=12, MOSI=11, MISO=13, RST=9, 3.3V only.
- Green LED GPIO5, red LED GPIO4 (220Ω), active buzzer GPIO6.
- Signals: green + 1 beep = present; green blink + 2 beeps = already marked today; red + 3 beeps = unknown card.
- WiFi must be **2.4 GHz** (ESP32 cannot use 5 GHz).
- Firmware: `../rfid_attendance_web/rfid_attendance_web.ino` (kept outside this repo; it contains the WiFi password, so never commit it). It has `SERVER_URL`, `API_KEY`, `KEEP_AWAKE` and an offline queue with retries. Its `seedStudents[]` is only used on the very first boot. After that the student list comes from the website and is saved in flash (NVS).

## ESP32 ↔ server contract (DO NOT BREAK)
The firmware is already flashed. Changing it means re-flashing by hand, so keep these endpoints backward compatible:
- `GET /health` → `200 ok`. The ESP32 pings this every 10 min to keep Render awake. `HEAD /health` also returns 200, because UptimeRobot's free HTTP monitors send HEAD.
- `POST /api/scan`: header `X-API-Key`, form body `uid, name, roll, status (Present|Unknown), date (YYYY-MM-DD), time (HH:MM:SS)`. Response body must be exactly `OK` or `ALREADY` (ESP32 treats anything else as failure and retries).
- `POST /api/roster`: header `X-API-Key`, form body `list` = lines of `uid|roll|name`. Older firmware sends it once after every boot. Current firmware sends it on first boot, and again if the website's list comes back empty. The server only **inserts new** students and never overwrites names or phones edited on the website.
- `GET /api/students`: header `X-API-Key`. Returns `#STUDENTS <count>` and then one `uid|roll|name` line per student. The firmware fetches it every 10 min and on an unknown card, and it rejects the reply if the count does not match. Keep this format and never add phones or other private data to it.
- If a UID exists in the website's student list, a scan counts as Present even when the ESP32 reports `Unknown`.

## Repo layout
- `server.js`: the whole backend. Plain `http` module, no framework. The only dependency is `pg`.
- `admin.html`: single-page admin UI in Bengali, vanilla JS, served at `/`. Tabs: today, students, results, class days, SMS, settings. Theme selector: system, light, dark, night (saved per browser in `localStorage`, shared with `login.html`). Colors are CSS variables; a new color must be set for every theme.
- `login.html`: login landing page in Bengali, served at `/login`.
- `package.json`: `npm start` → `node server.js`, Node ≥ 20 (uses global `fetch`, `AbortSignal.timeout`).
- `README.md`: Bengali deploy notes.

## Environment variables (Render → Environment)
| Var | Purpose |
|---|---|
| `API_KEY` | Shared secret with the ESP32 (`X-API-Key`). Also used by `/cron?key=`. |
| `DATABASE_URL` | Neon Postgres. If missing, an in-memory store is used (lost on restart; for local testing only). |
| `VIEW_USER` | Website login username. If unset, any username is accepted. |
| `VIEW_PASSWORD` | Website login password. If unset, the website is open to everyone. |
| `SMS_URL` | SMS provider URL template with `{to}` (8801XXXXXXXXX), `{to11}` (01XXXXXXXXX), `{msg}`. If unset, the server runs in **TEST mode** (logs, never sends). |
| `SMS_METHOD` | `GET` (default) or `POST`. |
| `SMS_BODY` | Form body template for POST, same placeholders. |
| `SMS_OK_TEXT` | Substring that must appear in the provider response for a send to count as success. |
| `SMS_TYPE` | `form` (default) or `json`. With `json`, `SMS_BODY` is sent as JSON and placeholders are JSON-escaped instead of URL-encoded. |
| `SMS_AUTH` | `username:password`. If set, it is sent as an HTTP Basic `Authorization` header. Never put credentials in `SMS_URL`, because Node's `fetch` rejects URLs that contain them. |

## Database (Postgres; tables created/migrated in `pgStore.init()`)
- `attendance(id, day DATE, time TEXT, roll, name, uid, status, created_at)`, with a partial unique index of one `Present` per `(day, uid)`.
- `roster(uid PK, roll, name, phone, guardian, father, mother, family_phone, student_id, department, batch, section, last_cgpa, avg_cgpa, added_on)`: the student list (the name is kept from v1). SMS goes only to `phone`; `family_phone` is for reference. CGPA is free text, is not tied to a semester, and is not included in SMS.
- `class_days(day PK)`: auto-inserted on the first Present scan of a day. The admin can add or remove days.
- `results(semester, exam, uid, score TEXT)`, PK `(semester, exam, uid)`. The score is free text like `18/20` or `3.75`.
- `sms_log(id, at, uid, phone, kind absent|result|test, message, status sent|failed|test, info, streak_end DATE)`.
- `settings(key, value)`: `semester`, `semester_start`, `absent_days`, `alert_time` (HH:MM, Asia/Dhaka), `auto_sms` on|off, `absent_template`, `result_template`, `last_check`.
- `memoryStore()` mirrors the same interface. **Any new store method must be added to BOTH stores.**

## Business logic
- All dates use **Asia/Dhaka** (`nowParts()`).
- `computeStats()`: class days counted from `semester_start` (or the first class day) to today. For each student it computes total, absent, present, and `streak` (consecutive absent class days ending at the latest class day).
- `runAbsentCheck(dry)`: alert when `streak >= absent_days`. Dedupe: skip if the last *sent* absent SMS for that UID has `streak_end >= first day of the current N-day window`. This means one SMS per streak, plus a reminder after every further N absent days.
- `scheduledCheck()`: runs at most once per day after `alert_time`. It is triggered by a 60 s `setInterval`, by `/health` and by `GET /cron?key=API_KEY` (for cron-job.org, because Render free sleeps after 15 min). Only the scheduled run sets `last_check`; manual sends do not.
- Template placeholders: `{name} {roll} {days} {total} {absent} {present} {results} {semester} {guardian}`.
- SMS cost: Bangla script gives 70 chars per SMS and Latin gives 160, so the default templates are Banglish to save money.
- Website login: `/login` sets a signed, stateless `att_session` cookie (7 days), so it survives Render sleep and restarts. Changing `VIEW_USER`, `VIEW_PASSWORD` or `API_KEY` invalidates all sessions. Basic auth is still accepted, for curl testing.
- Admin POSTs need a login **and** the header `X-Requested-With: admin` (cheap CSRF guard). Keep that when adding endpoints.

## Admin JSON endpoints (login cookie or Basic auth)
`POST /admin/logout`, `GET /admin/day?date=`, `GET /admin/overview`, `POST /admin/student {uid, oldUid, roll, name, phone, guardian, father, mother, family_phone, student_id, department, batch, section, last_cgpa, avg_cgpa, results: {"Class Test"|"Mid Term"|"Final": score}}`, `POST /admin/student/delete`, `POST /admin/classday {day, action}`, `POST /admin/results {exam, scores|remove}`, `POST /admin/settings`, `POST /admin/sms/absent {dry}`, `POST /admin/sms/results {exam, dry}`, `POST /admin/sms/test {phone, message}`, `GET /admin/sms`, `GET /export.csv?date=`.

## Hosting constraints
- Render free web service: sleeps after 15 min idle, 30–50 s cold start, no persistent disk, outbound IP not fixed (an SMS provider that requires IP whitelisting will not work).
- Neon free Postgres. Do NOT use Render's free Postgres, which expires after 30 days.
- Avoid adding heavy dependencies or a build step. Keep it deployable by "push to GitHub → Render auto-deploys".

## SMS provider status
- Chosen provider: **HostServerBD** non-masking (৳100 minimum top-up, ~৳0.39/SMS, pays via bKash). The account is being opened; **the API docs have not been received yet**.
- Once the docs arrive, map them to `SMS_URL` / `SMS_METHOD` / `SMS_BODY` / `SMS_OK_TEXT`. Prefer configuring over code changes. If the provider returns HTTP 200 with an error code in JSON, set `SMS_OK_TEXT` accordingly.
- Never commit API keys. They live only in Render env vars.
- Free test option: an Android phone running "SMS Gateway for Android" (capcom6, cloud mode). Set `SMS_URL=https://api.sms-gate.app/3rdparty/v1/messages`, `SMS_METHOD=POST`, `SMS_TYPE=json`, `SMS_AUTH=<app user>:<app password>`, `SMS_BODY={"textMessage":{"text":"{msg}"},"phoneNumbers":["+{to}"]}` and `SMS_OK_TEXT="id"`. A 202 response only means the cloud accepted the SMS; the phone sends it later.

## Local testing
```
API_KEY=k VIEW_PASSWORD=pass PORT=3456 node server.js        # memory store (any username)
curl -H 'X-API-Key: k' -d 'uid=AA11&date=2026-10-25&time=09:00:00' localhost:3456/api/scan
curl -u x:pass -H 'X-Requested-With: admin' -H 'Content-Type: application/json' \
     -d '{"dry":true}' localhost:3456/admin/sms/absent
```
Point `SMS_URL` at a tiny local HTTP server to test SMS sending without spending money. Test SQL changes against a real Postgres (local or a Neon branch) before deploying.

## Ideas / pending work
- Optional Telegram bot as a free second channel (guardians must press Start once).
- Possible UI additions: per-student attendance history and a semester-wide CSV report.
