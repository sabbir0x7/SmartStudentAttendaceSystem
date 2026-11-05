// RFID Attendance website (v2) for Render
//  - ESP32 scan pathay -> hajira save hoy
//  - Chhatro, obhibhabok er phone, porikkhar result rakha jay
//  - Tana koyek din onupostit hole obhibhabok ke SMS jay (jekono SMS API)
//
// Environment variables (Render > Environment):
//   API_KEY        ESP32 er code e jei key, sheta-i (dorkari)
//   DATABASE_URL   Neon Postgres er connection string (dorkari, na dile data harabe)
//   VIEW_USER      Website e dhukte username (na dile jekono username cholbe)
//   VIEW_PASSWORD  Website e dhukte password (dorkari)
//   SMS_URL        SMS company r link, {to} ar {msg} shoho (README dekhun). Na dile TEST mode.
//   SMS_METHOD     GET (default) ba POST
//   SMS_BODY       POST hole body, jemon: api_key=XXX&to={to}&msg={msg}
//   SMS_OK_TEXT    SMS company r uttore ei lekha thakle "pathano holo" dhora hobe (aichhik)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const VIEW_USER = process.env.VIEW_USER || '';
const VIEW_PASSWORD = process.env.VIEW_PASSWORD || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SMS_URL = process.env.SMS_URL || '';
const SMS_METHOD = (process.env.SMS_METHOD || 'GET').toUpperCase();
const SMS_BODY = process.env.SMS_BODY || '';
const SMS_OK_TEXT = process.env.SMS_OK_TEXT || '';
const TZ = 'Asia/Dhaka';

const PAGE = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
const LOGIN_PAGE = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');

// ---------- Date / time (Bangladesh) ----------
function nowParts() {
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}:${p.second}` };
}
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isTime = s => /^\d{2}:\d{2}:\d{2}$/.test(s || '');
const clean = (s, n) => String(s ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, n);

// 01XXXXXXXXX / +8801XXXXXXXXX -> 8801XXXXXXXXX ("" hole bhul number)
function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (/^01[3-9]\d{8}$/.test(d)) return '88' + d;
  if (/^8801[3-9]\d{8}$/.test(d)) return d;
  return '';
}

// Chhatrer form e ei tin porikkhar nombor deya jay
const FORM_EXAMS = ['Class Test', 'Mid Term', 'Final'];
// Chhatrer baki tothyo: ghor er nam -> shorbochcho koto okkhor
const STUDENT_EXTRA = { father: 80, mother: 80, family_phone: 20, student_id: 30, department: 60, batch: 20, section: 20, last_cgpa: 10, avg_cgpa: 10 };
const emptyExtra = () => Object.fromEntries(Object.keys(STUDENT_EXTRA).map(k => [k, '']));

const DEFAULT_SETTINGS = {
  semester: 'Fall 2026',
  semester_start: '',            // khali hole prothom hajirar din theke
  absent_days: '3',
  alert_time: '17:00',
  auto_sms: 'on',
  absent_template: '{name} (Roll {roll}) tana {days} din class e onupostit. Ei semester e class {total} din, onupostit {absent} din.{results}',
  result_template: '{name} (Roll {roll}) {semester} result:{results}. Class {total} din, onupostit {absent} din.',
  last_check: '',
};

// ---------- Storage ----------
// Postgres (Neon) thakle sheta, na thakle memory (shudhu porikkhar jonno)
function memoryStore() {
  const scans = [];
  const students = new Map();
  const classDays = new Set();
  const results = [];      // {semester, exam, uid, score}
  const sms = [];
  const settings = {};
  let smsId = 1;
  return {
    kind: 'memory',
    async init() {},
    async addScan(r) {
      if (r.status === 'Present') {
        if (scans.some(x => x.day === r.day && x.uid === r.uid && x.status === 'Present')) return 'ALREADY';
        classDays.add(r.day);
      }
      scans.push({ ...r });
      return 'OK';
    },
    async listScans(day) {
      return scans.filter(x => x.day === day).sort((a, b) => a.time.localeCompare(b.time));
    },
    async presentSince(from) {
      return scans.filter(x => x.status === 'Present' && x.day >= from).map(x => ({ uid: x.uid, day: x.day }));
    },
    async firstDay() {
      const d = [...classDays].sort()[0];
      return d || '';
    },
    async listStudents() {
      return [...students.values()].sort((a, b) => a.roll.localeCompare(b.roll, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    },
    async saveStudent(s, today) {
      const old = students.get(s.uid);
      students.set(s.uid, { ...s, added_on: old ? old.added_on : today });
    },
    async espRoster(list, today) {
      for (const s of list) {
        if (!students.has(s.uid)) students.set(s.uid, { uid: s.uid, roll: s.roll, name: s.name, phone: '', guardian: '', ...emptyExtra(), added_on: today });
      }
    },
    async deleteStudent(uid) { students.delete(uid); },
    async listClassDays() { return [...classDays].sort(); },
    async addClassDay(day) { classDays.add(day); },
    async removeClassDay(day) { classDays.delete(day); },
    async listResults(semester) { return results.filter(r => r.semester === semester).map(r => ({ ...r })); },
    async saveResults(semester, exam, scores) {
      for (const [uid, score] of scores) {
        const i = results.findIndex(r => r.semester === semester && r.exam === exam && r.uid === uid);
        if (i >= 0) results.splice(i, 1);
        if (score) results.push({ semester, exam, uid, score });
      }
    },
    async deleteExam(semester, exam) {
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].semester === semester && results[i].exam === exam) results.splice(i, 1);
      }
    },
    async addSms(x) { sms.push({ id: smsId++, at: new Date().toISOString(), ...x }); },
    async listSms(limit) { return sms.slice(-limit).reverse(); },
    async lastAlert(uid) {
      const d = sms.filter(x => x.uid === uid && x.kind === 'absent' && x.status === 'sent').map(x => x.streak_end).sort();
      return d[d.length - 1] || '';
    },
    async getSettings() { return { ...DEFAULT_SETTINGS, ...settings }; },
    async setSettings(obj) { Object.assign(settings, obj); },
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  // Neon connection kete dile pool error dey. Listener na thakle puro server crash kore.
  // Porer query te pool nijei notun connection khule ney.
  pool.on('error', err => console.error('Database connection kete geche:', err.message));
  const q = (sql, args) => pool.query(sql, args);
  return {
    kind: 'postgres',
    async init() {
      await q(`CREATE TABLE IF NOT EXISTS attendance (
          id SERIAL PRIMARY KEY,
          day DATE NOT NULL,
          time TEXT NOT NULL,
          roll TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL DEFAULT '',
          uid TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_present_per_day
          ON attendance (day, uid) WHERE status = 'Present'`);
      await q(`CREATE TABLE IF NOT EXISTS roster (
          uid TEXT PRIMARY KEY,
          roll TEXT NOT NULL DEFAULT '',
          name TEXT NOT NULL DEFAULT '')`);
      await q(`ALTER TABLE roster ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`);
      await q(`ALTER TABLE roster ADD COLUMN IF NOT EXISTS guardian TEXT NOT NULL DEFAULT ''`);
      await q(`ALTER TABLE roster ADD COLUMN IF NOT EXISTS added_on DATE NOT NULL DEFAULT CURRENT_DATE`);
      for (const col of Object.keys(STUDENT_EXTRA)) {
        await q(`ALTER TABLE roster ADD COLUMN IF NOT EXISTS ${col} TEXT NOT NULL DEFAULT ''`);
      }
      await q(`CREATE TABLE IF NOT EXISTS class_days (day DATE PRIMARY KEY)`);
      // Ager version er hajira theke class er din bhore deya
      await q(`INSERT INTO class_days (day)
          SELECT DISTINCT day FROM attendance WHERE status = 'Present'
          ON CONFLICT DO NOTHING`);
      await q(`CREATE TABLE IF NOT EXISTS results (
          semester TEXT NOT NULL,
          exam TEXT NOT NULL,
          uid TEXT NOT NULL,
          score TEXT NOT NULL,
          PRIMARY KEY (semester, exam, uid))`);
      await q(`CREATE TABLE IF NOT EXISTS sms_log (
          id SERIAL PRIMARY KEY,
          at TIMESTAMPTZ NOT NULL DEFAULT now(),
          uid TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL,
          info TEXT NOT NULL DEFAULT '',
          streak_end DATE)`);
      await q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    },
    async addScan(r) {
      const res = await q(
        `INSERT INTO attendance (day, time, roll, name, uid, status)
         VALUES ($1::date, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [r.day, r.time, r.roll, r.name, r.uid, r.status]);
      if (res.rowCount !== 1) return 'ALREADY';
      if (r.status === 'Present') {
        await q(`INSERT INTO class_days (day) VALUES ($1::date) ON CONFLICT DO NOTHING`, [r.day]);
      }
      return 'OK';
    },
    async listScans(day) {
      const res = await q(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, time, roll, name, uid, status
         FROM attendance WHERE day = $1::date ORDER BY time, id`, [day]);
      return res.rows;
    },
    async presentSince(from) {
      const res = await q(
        `SELECT uid, to_char(day, 'YYYY-MM-DD') AS day FROM attendance
         WHERE status = 'Present' AND day >= $1::date`, [from]);
      return res.rows;
    },
    async firstDay() {
      const res = await q(`SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM class_days`);
      return (res.rows[0] && res.rows[0].d) || '';
    },
    async listStudents() {
      const res = await q(
        `SELECT uid, roll, name, phone, guardian, father, mother, family_phone, student_id, department, batch, section, last_cgpa, avg_cgpa,
                to_char(added_on, 'YYYY-MM-DD') AS added_on
         FROM roster ORDER BY length(roll), roll, name`);
      return res.rows;
    },
    async saveStudent(s, today) {
      await q(
        `INSERT INTO roster (uid, roll, name, phone, guardian, added_on,
                             father, mother, family_phone, student_id, department, batch, section, last_cgpa, avg_cgpa)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (uid) DO UPDATE SET roll = $2, name = $3, phone = $4, guardian = $5,
           father = $7, mother = $8, family_phone = $9, student_id = $10, department = $11, batch = $12, section = $13,
           last_cgpa = $14, avg_cgpa = $15`,
        [s.uid, s.roll, s.name, s.phone, s.guardian, today,
          s.father, s.mother, s.family_phone, s.student_id, s.department, s.batch, s.section, s.last_cgpa, s.avg_cgpa]);
    },
    async espRoster(list, today) {
      for (const s of list) {
        await q(
          `INSERT INTO roster (uid, roll, name, added_on) VALUES ($1, $2, $3, $4::date)
           ON CONFLICT (uid) DO NOTHING`,
          [s.uid, s.roll, s.name, today]);
      }
    },
    async deleteStudent(uid) { await q(`DELETE FROM roster WHERE uid = $1`, [uid]); },
    async listClassDays() {
      const res = await q(`SELECT to_char(day, 'YYYY-MM-DD') AS d FROM class_days ORDER BY day`);
      return res.rows.map(x => x.d);
    },
    async addClassDay(day) { await q(`INSERT INTO class_days (day) VALUES ($1::date) ON CONFLICT DO NOTHING`, [day]); },
    async removeClassDay(day) { await q(`DELETE FROM class_days WHERE day = $1::date`, [day]); },
    async listResults(semester) {
      const res = await q(`SELECT semester, exam, uid, score FROM results WHERE semester = $1`, [semester]);
      return res.rows;
    },
    async saveResults(semester, exam, scores) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [uid, score] of scores) {
          if (score) {
            await client.query(
              `INSERT INTO results (semester, exam, uid, score) VALUES ($1, $2, $3, $4)
               ON CONFLICT (semester, exam, uid) DO UPDATE SET score = $4`,
              [semester, exam, uid, score]);
          } else {
            await client.query(`DELETE FROM results WHERE semester = $1 AND exam = $2 AND uid = $3`,
              [semester, exam, uid]);
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async deleteExam(semester, exam) {
      await q(`DELETE FROM results WHERE semester = $1 AND exam = $2`, [semester, exam]);
    },
    async addSms(x) {
      await q(
        `INSERT INTO sms_log (uid, phone, kind, message, status, info, streak_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date)`,
        [x.uid || '', x.phone || '', x.kind, x.message, x.status, x.info || '', x.streak_end || null]);
    },
    async listSms(limit) {
      const res = await q(
        `SELECT id, at, uid, phone, kind, message, status, info FROM sms_log ORDER BY id DESC LIMIT $1`, [limit]);
      return res.rows;
    },
    async lastAlert(uid) {
      const res = await q(
        `SELECT to_char(max(streak_end), 'YYYY-MM-DD') AS d FROM sms_log
         WHERE uid = $1 AND kind = 'absent' AND status = 'sent'`, [uid]);
      return (res.rows[0] && res.rows[0].d) || '';
    },
    async getSettings() {
      const res = await q(`SELECT key, value FROM settings`);
      const s = { ...DEFAULT_SETTINGS };
      res.rows.forEach(r => { s[r.key] = r.value; });
      return s;
    },
    async setSettings(obj) {
      for (const [k, v] of Object.entries(obj)) {
        await q(`INSERT INTO settings (key, value) VALUES ($1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = $2`, [k, String(v)]);
      }
    },
  };
}

const store = DATABASE_URL ? pgStore(DATABASE_URL) : memoryStore();

// ---------- Hisab: ke koto din class korlo ----------
// Proti chhatro: semester e class koto din, onupostit koto, sesh theke tana koto din onupostit
async function computeStats(settings) {
  const today = nowParts().date;
  const start = isDate(settings.semester_start) ? settings.semester_start : (await store.firstDay()) || today;
  const [students, allDays, present] = await Promise.all([
    store.listStudents(), store.listClassDays(), store.presentSince(start)]);
  const days = allDays.filter(d => d >= start && d <= today);
  const seen = new Set(present.map(p => p.uid + '|' + p.day));
  return {
    start,
    days,
    students: students.map(s => {
      const mine = days;
      const absentDays = mine.filter(d => !seen.has(s.uid + '|' + d));
      let streak = 0;
      for (let i = mine.length - 1; i >= 0 && !seen.has(s.uid + '|' + mine[i]); i--) streak++;
      return { ...s, total: mine.length, absent: absentDays.length, present: mine.length - absentDays.length, streak, classDays: mine };
    }),
  };
}

function resultText(list, prefix = ' ') {
  return list.length ? prefix + list.map(r => `${r.exam} ${r.score}`).join(', ') : '';
}

function fillTemplate(tpl, s, extra) {
  const vals = {
    name: s.name, roll: s.roll, total: s.total, absent: s.absent, present: s.present,
    days: extra.days ?? s.streak, results: extra.results || '', semester: extra.semester || '',
    guardian: s.guardian || '',
  };
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? String(vals[k]) : m)).replace(/\s+/g, ' ').trim();
}

// SMS ek ta pathano. {ok, status, info}
async function sendSms(phone, message) {
  if (!SMS_URL) return { status: 'test', info: 'SMS_URL সেট করা নেই, তাই আসল SMS যায়নি (টেস্ট)' };
  const to = normPhone(phone);
  if (!to) return { status: 'failed', info: 'ভুল মোবাইল নম্বর' };
  const sub = (tpl) => tpl
    .replace(/\{to\}/g, encodeURIComponent(to))
    .replace(/\{to11\}/g, encodeURIComponent(to.slice(2)))
    .replace(/\{msg\}/g, encodeURIComponent(message));
  try {
    const opts = { method: SMS_METHOD, signal: AbortSignal.timeout(20000) };
    if (SMS_METHOD === 'POST') {
      opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      opts.body = sub(SMS_BODY);
    }
    const res = await fetch(sub(SMS_URL), opts);
    const text = (await res.text()).slice(0, 300);
    const ok = res.ok && (!SMS_OK_TEXT || text.includes(SMS_OK_TEXT));
    return { status: ok ? 'sent' : 'failed', info: `HTTP ${res.status}: ${text}` };
  } catch (e) {
    return { status: 'failed', info: 'নেটওয়ার্ক সমস্যা: ' + e.message };
  }
}

// Tana onupostit chhatroder khuje SMS pathay. dry = true hole shudhu talika dey.
async function runAbsentCheck(dry) {
  const settings = await store.getSettings();
  const need = Math.max(1, parseInt(settings.absent_days, 10) || 3);
  const st = await computeStats(settings);
  const results = await store.listResults(settings.semester);
  const out = [];
  for (const s of st.students) {
    if (s.streak < need) continue;
    const window = s.classDays.slice(-need);           // sesh "need" ta class er din
    const end = window[window.length - 1];
    const last = await store.lastAlert(s.uid);
    const item = { uid: s.uid, name: s.name, roll: s.roll, phone: s.phone, streak: s.streak };
    if (last && last >= window[0]) { item.skip = 'এই অনুপস্থিতির জন্য আগেই SMS গেছে'; out.push(item); continue; }
    if (!normPhone(s.phone)) { item.skip = 'অভিভাবকের মোবাইল নম্বর নেই বা ভুল'; out.push(item); continue; }
    item.message = fillTemplate(settings.absent_template, s, {
      days: s.streak, semester: settings.semester,
      results: resultText(results.filter(r => r.uid === s.uid), ' Result: '),
    });
    if (!dry) {
      const r = await sendSms(s.phone, item.message);
      await store.addSms({ uid: s.uid, phone: s.phone, kind: 'absent', message: item.message, status: r.status, info: r.info, streak_end: end });
      item.status = r.status;
      item.info = r.info;
    }
    out.push(item);
  }
  return out;
}

async function sendResults(exam, dry) {
  const settings = await store.getSettings();
  const st = await computeStats(settings);
  const results = await store.listResults(settings.semester);
  const out = [];
  for (const s of st.students) {
    let mine = results.filter(r => r.uid === s.uid);
    if (exam) mine = mine.filter(r => r.exam === exam);
    const item = { uid: s.uid, name: s.name, roll: s.roll, phone: s.phone };
    if (!mine.length) { item.skip = 'রেজাল্ট দেওয়া নেই'; out.push(item); continue; }
    if (!normPhone(s.phone)) { item.skip = 'অভিভাবকের মোবাইল নম্বর নেই বা ভুল'; out.push(item); continue; }
    item.message = fillTemplate(settings.result_template, s, { semester: settings.semester, results: resultText(mine) });
    if (!dry) {
      const r = await sendSms(s.phone, item.message);
      await store.addSms({ uid: s.uid, phone: s.phone, kind: 'result', message: item.message, status: r.status, info: r.info });
      item.status = r.status;
      item.info = r.info;
    }
    out.push(item);
  }
  return out;
}

// Proti minute dekhe: shomoy hole din e ekbar check chalay
let checking = false;
async function scheduledCheck() {
  if (checking) return false;
  checking = true;
  try {
    const s = await store.getSettings();
    const now = nowParts();
    if (s.auto_sms !== 'on' || s.last_check === now.date) return false;
    if (now.time.slice(0, 5) < (s.alert_time || '17:00')) return false;
    const out = await runAbsentCheck(false);
    await store.setSettings({ last_check: now.date });
    console.log(`Absent check ${now.date}: ${out.filter(x => x.message).length} SMS`);
    return true;
  } catch (e) {
    console.error('Absent check failed:', e.message);
    return false;
  } finally {
    checking = false;
  }
}

// ---------- HTTP helpers ----------
function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const sendJSON = (res, obj, code = 200) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJSON(req) {
  try { return JSON.parse(await readBody(req) || '{}'); } catch { return {}; }
}

const checkKey = req => API_KEY && req.headers['x-api-key'] === API_KEY;

// ---------- Login ----------
// Session server e rakha hoy na, cookie te sign kora thake. Tai Render ghumaleo
// ba restart holeo login thake. Password bodlale shob session batil hoy.
const SESSION_COOKIE = 'att_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const SESSION_KEY = crypto.createHash('sha256').update(`session|${VIEW_USER}|${VIEW_PASSWORD}|${API_KEY}`).digest();

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const signSession = exp => crypto.createHmac('sha256', SESSION_KEY).update(String(exp)).digest('hex');

function credsOk(user, pass) {
  if (!VIEW_PASSWORD) return false;
  const userOk = !VIEW_USER || safeEq(user, VIEW_USER);
  return safeEq(pass, VIEW_PASSWORD) && userOk;
}

function sessionCookie(req, value, maxAge) {
  // Render e https thake, local e http. Secure dile local e cookie kaj korbe na.
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const newSession = req => {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return sessionCookie(req, `${exp}.${signSession(exp)}`, SESSION_SECONDS);
};

function hasSession(req) {
  const c = (req.headers.cookie || '').split(';').map(x => x.trim())
    .find(x => x.startsWith(SESSION_COOKIE + '='));
  if (!c) return false;
  const [exp, sig] = c.slice(SESSION_COOKIE.length + 1).split('.');
  return /^\d+$/.test(exp) && Number(exp) > Date.now() / 1000 && safeEq(sig || '', signSession(exp));
}

// Cookie (website) othoba Basic auth (curl diye test korar jonno)
function isLoggedIn(req) {
  if (!VIEW_PASSWORD) return true;
  if (hasSession(req)) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return credsOk(user, rest.join(':'));
}

const redirect = (res, to, extra = {}) => send(res, 303, '', 'text/plain; charset=utf-8', { Location: to, ...extra });

const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------- Routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const today = nowParts().date;

  // UptimeRobot free plan HEAD pathay, ESP32 pathay GET
  if ((req.method === 'GET' || req.method === 'HEAD') && p === '/health') {
    scheduledCheck();
    return send(res, 200, 'ok');
  }

  // Bairer cron (cron-job.org) theke: /cron?key=API_KEY
  if (req.method === 'GET' && p === '/cron') {
    if (!API_KEY || url.searchParams.get('key') !== API_KEY) return send(res, 401, 'Bhul key');
    const ran = await scheduledCheck();
    return send(res, 200, ran ? 'checked' : 'nothing to do');
  }

  // ESP32 -> ekta scan
  if (req.method === 'POST' && p === '/api/scan') {
    if (!API_KEY) return send(res, 500, 'Server e API_KEY set kora nei');
    if (!checkKey(req)) return send(res, 401, 'Bhul API key');
    const f = new URLSearchParams(await readBody(req, 8 * 1024));
    const uid = clean(f.get('uid'), 32).toUpperCase();
    if (!uid) return send(res, 400, 'uid dorkar');
    const now = nowParts();
    const known = (await store.listStudents()).find(s => s.uid === uid);
    const r = {
      day: isDate(f.get('date')) ? f.get('date') : now.date,
      time: isTime(f.get('time')) ? f.get('time') : now.time,
      roll: known ? known.roll : clean(f.get('roll'), 20),
      name: known ? known.name : clean(f.get('name'), 80),
      uid,
      // Website e chhatro add kora thakle ESP32 "Unknown" bolleo hajira hobe
      status: known || f.get('status') !== 'Unknown' ? 'Present' : 'Unknown',
    };
    const result = await store.addScan(r);
    console.log(`${r.day} ${r.time} ${r.status} ${uid} ${r.name} -> ${result}`);
    return send(res, 200, result);
  }

  // Website er chhatroder talika -> ESP32. Prothom line e kotojon, jate ESP32
  // bhanga ba onno kichu uttor peye nijer talika na muche fele.
  if (req.method === 'GET' && p === '/api/students') {
    if (!API_KEY) return send(res, 500, 'Server e API_KEY set kora nei');
    if (!checkKey(req)) return send(res, 401, 'Bhul API key');
    const list = await store.listStudents();
    const lines = list.map(s => `${s.uid}|${s.roll}|${s.name}`);
    return send(res, 200, [`#STUDENTS ${list.length}`, ...lines].join('\n') + '\n');
  }

  // ESP32 -> chhatroder talika (boot er por ekbar). Shudhu notun chhatro add hoy,
  // website e bodlano nam/phone ESP32 muche dey na.
  if (req.method === 'POST' && p === '/api/roster') {
    if (!API_KEY) return send(res, 500, 'Server e API_KEY set kora nei');
    if (!checkKey(req)) return send(res, 401, 'Bhul API key');
    const f = new URLSearchParams(await readBody(req));
    const list = String(f.get('list') || '').split('\n').map(line => {
      const [uid, roll, ...name] = line.split('|');
      return { uid: clean(uid, 32).toUpperCase(), roll: clean(roll, 20), name: clean(name.join('|'), 80) };
    }).filter(s => s.uid).slice(0, 500);
    await store.espRoster(list, today);
    console.log(`Roster: ${list.length} students`);
    return send(res, 200, 'OK');
  }

  // ---- Login page ----
  if (p === '/login') {
    if (req.method === 'POST') {
      const f = new URLSearchParams(await readBody(req, 8 * 1024));
      if (!credsOk(f.get('username') || '', f.get('password') || '')) return redirect(res, '/login?error=1');
      return redirect(res, '/', { 'Set-Cookie': newSession(req) });
    }
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
    if (isLoggedIn(req)) return redirect(res, '/');
    const error = url.searchParams.has('error')
      ? '<div class="err" role="alert">ইউজারনেম বা পাসওয়ার্ড ভুল হয়েছে।</div>' : '';
    return send(res, 200, LOGIN_PAGE.replace('<!--ERROR-->', error), 'text/html; charset=utf-8');
  }

  // ---- Website (login kore) ----
  if (p === '/' || p.startsWith('/admin/') || p === '/export.csv') {
    if (!isLoggedIn(req)) {
      if (p.startsWith('/admin/')) return sendJSON(res, { error: 'Login dorkar' }, 401);
      return redirect(res, '/login');
    }
    if (req.method === 'GET' && p === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    // POST shudhu amader page theke (onno site theke jor kore pathano atkate)
    if (req.method === 'POST' && req.headers['x-requested-with'] !== 'admin') return send(res, 403, 'Forbidden');

    if (req.method === 'POST' && p === '/admin/logout') {
      return send(res, 200, '{}', 'application/json; charset=utf-8', { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    const day = isDate(url.searchParams.get('date')) ? url.searchParams.get('date') : today;

    if (req.method === 'GET' && p === '/admin/day') {
      const [scans, students] = await Promise.all([store.listScans(day), store.listStudents()]);
      return sendJSON(res, { day, today, storage: store.kind, scans, students });
    }

    if (req.method === 'GET' && p === '/admin/overview') {
      const settings = await store.getSettings();
      const st = await computeStats(settings);
      const results = await store.listResults(settings.semester);
      st.students.forEach(s => { delete s.classDays; });
      return sendJSON(res, {
        today, storage: store.kind, sms: SMS_URL ? 'live' : 'test', settings,
        start: st.start, classDays: st.days, students: st.students, results,
      });
    }

    if (req.method === 'POST' && p === '/admin/student') {
      const b = await readJSON(req);
      const uid = clean(b.uid, 32).toUpperCase().replace(/\s/g, '');
      if (!/^[0-9A-F]{4,20}$/.test(uid)) return sendJSON(res, { error: 'UID ঠিক নেই (শুধু 0-9 আর A-F)' }, 400);
      const phone = clean(b.phone, 20);
      if (phone && !normPhone(phone)) return sendJSON(res, { error: 'মোবাইল নম্বর ঠিক নেই (01XXXXXXXXX)' }, 400);
      const extra = {};
      for (const [k, n] of Object.entries(STUDENT_EXTRA)) extra[k] = clean(b[k], n);
      if (extra.family_phone && !normPhone(extra.family_phone)) return sendJSON(res, { error: 'পরিবারের নম্বর ঠিক নেই (01XXXXXXXXX)' }, 400);
      // Onno chhatrer UID diye save korle tar tothyo muche jeto, tai atkano
      if (b.oldUid !== uid && (await store.listStudents()).some(s => s.uid === uid)) {
        return sendJSON(res, { error: 'এই UID আরেকজন ছাত্রের নামে আছে' }, 400);
      }
      if (b.oldUid && b.oldUid !== uid) await store.deleteStudent(clean(b.oldUid, 32));
      await store.saveStudent({
        uid, roll: clean(b.roll, 20), name: clean(b.name, 80), phone, guardian: clean(b.guardian, 80), ...extra,
      }, today);
      if (b.results && typeof b.results === 'object') {
        const { semester } = await store.getSettings();
        for (const exam of FORM_EXAMS) {
          if (exam in b.results) await store.saveResults(semester, exam, [[uid, clean(b.results[exam], 20)]]);
        }
      }
      return sendJSON(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/student/delete') {
      const b = await readJSON(req);
      await store.deleteStudent(clean(b.uid, 32));
      return sendJSON(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/classday') {
      const b = await readJSON(req);
      if (!isDate(b.day)) return sendJSON(res, { error: 'তারিখ ঠিক নেই' }, 400);
      if (b.action === 'remove') await store.removeClassDay(b.day);
      else await store.addClassDay(b.day);
      return sendJSON(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/results') {
      const b = await readJSON(req);
      const settings = await store.getSettings();
      const exam = clean(b.exam, 30);
      if (!exam) return sendJSON(res, { error: 'পরীক্ষার নাম লিখুন' }, 400);
      if (b.remove) { await store.deleteExam(settings.semester, exam); return sendJSON(res, { ok: true }); }
      const scores = Object.entries(b.scores || {}).slice(0, 1000)
        .map(([uid, sc]) => [clean(uid, 32), clean(sc, 20)]);
      await store.saveResults(settings.semester, exam, scores);
      return sendJSON(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/settings') {
      const b = await readJSON(req);
      const s = {};
      if ('semester' in b) s.semester = clean(b.semester, 40) || DEFAULT_SETTINGS.semester;
      if ('semester_start' in b) s.semester_start = isDate(b.semester_start) ? b.semester_start : '';
      if ('absent_days' in b) s.absent_days = String(Math.min(30, Math.max(1, parseInt(b.absent_days, 10) || 3)));
      if ('alert_time' in b && /^\d{2}:\d{2}$/.test(b.alert_time)) s.alert_time = b.alert_time;
      if ('auto_sms' in b) s.auto_sms = b.auto_sms === 'on' ? 'on' : 'off';
      if ('absent_template' in b) s.absent_template = clean(b.absent_template, 500) || DEFAULT_SETTINGS.absent_template;
      if ('result_template' in b) s.result_template = clean(b.result_template, 500) || DEFAULT_SETTINGS.result_template;
      await store.setSettings(s);
      return sendJSON(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/admin/sms/absent') {
      const b = await readJSON(req);
      return sendJSON(res, { mode: SMS_URL ? 'live' : 'test', items: await runAbsentCheck(!!b.dry) });
    }

    if (req.method === 'POST' && p === '/admin/sms/results') {
      const b = await readJSON(req);
      return sendJSON(res, { mode: SMS_URL ? 'live' : 'test', items: await sendResults(clean(b.exam, 30), !!b.dry) });
    }

    if (req.method === 'POST' && p === '/admin/sms/test') {
      const b = await readJSON(req);
      const phone = clean(b.phone, 20);
      if (!normPhone(phone)) return sendJSON(res, { error: 'মোবাইল নম্বর ঠিক নেই (01XXXXXXXXX)' }, 400);
      const message = clean(b.message, 300) || 'Attendance system theke test SMS.';
      const r = await sendSms(phone, message);
      await store.addSms({ phone, kind: 'test', message, status: r.status, info: r.info });
      return sendJSON(res, r);
    }

    if (req.method === 'GET' && p === '/admin/sms') {
      return sendJSON(res, { mode: SMS_URL ? 'live' : 'test', log: await store.listSms(100) });
    }

    if (req.method === 'GET' && p === '/export.csv') {
      const [scans, students] = await Promise.all([store.listScans(day), store.listStudents()]);
      const present = new Map(scans.filter(s => s.status === 'Present').map(s => [s.uid, s]));
      const rows = [['Date', 'Roll', 'Name', 'UID', 'Status', 'Time']];
      students.forEach(s => {
        const x = present.get(s.uid);
        rows.push([day, s.roll, s.name, s.uid, x ? 'Present' : 'Absent', x ? x.time : '']);
        present.delete(s.uid);
      });
      present.forEach(x => rows.push([day, x.roll, x.name, x.uid, 'Present', x.time]));
      scans.filter(s => s.status === 'Unknown').forEach(s => rows.push([day, '', '', s.uid, 'Unknown card', s.time]));
      const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
      return send(res, 200, csv, 'text/csv; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="attendance-${day}.csv"` });
    }
  }

  send(res, 404, 'Not found');
}

// ---------- Start ----------
http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error');
  });
}).listen(PORT, async () => {
  try {
    await store.init();
    console.log(`Attendance server on port ${PORT} (storage: ${store.kind}, sms: ${SMS_URL ? 'live' : 'TEST'})`);
    if (!API_KEY) console.warn('WARNING: API_KEY set kora nei, ESP32 data pathate parbe na.');
    if (!DATABASE_URL) console.warn('WARNING: DATABASE_URL nei, data memory te thakbe (muche jabe).');
    if (!VIEW_PASSWORD) console.warn('WARNING: VIEW_PASSWORD nei, je keu website e dhukte parbe.');
    setInterval(scheduledCheck, 60 * 1000);
  } catch (e) {
    console.error('Database init failed:', e.message);
    process.exit(1);
  }
});
