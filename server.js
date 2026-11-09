'use strict';
// Qalam Arabic Academy — Telegram Mini App (backend). Nol tashqi kutubxona: Node >= 22.5
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------- .env (oddiy yuklovchi) ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const PORT = +process.env.PORT || 3000;
const DEV = !BOT_TOKEN; // DEV rejim: Telegram'siz demo kirish
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FILE = 20 * 1024 * 1024;
const ALLOWED_EXT = new Set(['pdf', 'mp3', 'm4a', 'ogg', 'wav', 'mp4', 'mov', 'webm', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'png', 'jpg', 'jpeg', 'zip']);
for (const d of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- Ma'lumotlar bazasi ----------
const DB_FILE = path.join(DATA_DIR, 'qalam.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, tg_id INTEGER UNIQUE, username TEXT, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','teacher','student')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, teacher_id INTEGER REFERENCES users(id), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(group_id,user_id));
CREATE TABLE IF NOT EXISTS lessons(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, title TEXT NOT NULL, starts_at TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 60, link TEXT, status TEXT NOT NULL DEFAULT 'rejalashtirilgan', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance(lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, PRIMARY KEY(lesson_id,student_id));
CREATE TABLE IF NOT EXISTS grades(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, teacher_id INTEGER, title TEXT, score INTEGER NOT NULL, prev_score INTEGER, comment TEXT, created_at TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT, owner_id INTEGER NOT NULL, group_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT, due_at TEXT NOT NULL, file_id INTEGER, link TEXT, created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT, file_id INTEGER, status TEXT NOT NULL DEFAULT 'kutilmoqda', score INTEGER, feedback TEXT, late INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL, reviewed_at TEXT, UNIQUE(assignment_id,student_id));
CREATE TABLE IF NOT EXISTS resources(id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, title TEXT NOT NULL, kind TEXT NOT NULL, url TEXT, file_id INTEGER, uploaded_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, group_id INTEGER, from_id INTEGER NOT NULL, to_id INTEGER, text TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS announcements(id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL, group_id INTEGER, title TEXT NOT NULL, body TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_lessons ON lessons(group_id,starts_at);
CREATE INDEX IF NOT EXISTS i_msgs ON messages(group_id,to_id,id);
CREATE INDEX IF NOT EXISTS i_notif ON notifications(user_id,read);
`);

const now = () => new Date().toISOString();
const q = (sql, ...p) => db.prepare(sql).all(...p).map((r) => ({ ...r }));
const q1 = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? { ...r } : null; };
const run = (sql, ...p) => db.prepare(sql).run(...p);
const insert = (sql, ...p) => Number(db.prepare(sql).run(...p).lastInsertRowid);
const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';
const audit = (u, action) => run('INSERT INTO audit(user_id,action,created_at) VALUES(?,?,?)', u?.id ?? null, action, now());

// Birinchi adminlar (ADMIN_TG_IDS)
for (const id of (process.env.ADMIN_TG_IDS || '').split(',').map((s) => +s.trim()).filter(Boolean)) {
  if (!q1('SELECT 1 FROM users WHERE tg_id=?', id)) run('INSERT INTO users(tg_id,name,role,created_at) VALUES(?,?,?,?)', id, 'Admin', 'admin', now());
}

// ---------- Yordamchilar ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const clean = (s, max = 2000) => String(s ?? '').trim().slice(0, max);
const need = (v, msg) => { if (v === undefined || v === null || v === '') fail(400, msg); return v; };
const isoOrFail = (v, msg) => { const d = new Date(v); if (isNaN(d)) fail(400, msg); return d.toISOString(); };
const safeUrl = (u) => { u = clean(u, 500); if (!u) return null; if (!/^https?:\/\//i.test(u)) fail(400, 'Havola http(s):// bilan boshlanishi kerak'); return u; };

function groupIds(u) {
  if (u.role === 'admin') return q('SELECT id FROM groups WHERE active=1').map((r) => r.id);
  if (u.role === 'teacher') return q('SELECT id FROM groups WHERE teacher_id=? AND active=1', u.id).map((r) => r.id);
  return q('SELECT g.id FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=? AND g.active=1', u.id).map((r) => r.id);
}
function canGroup(u, gid) { return groupIds(u).includes(+gid); }
function needGroup(u, gid) { if (!canGroup(u, gid)) fail(403, 'Bu guruhga ruxsat yo‘q'); return +gid; }
const isStaff = (u) => u.role === 'admin' || u.role === 'teacher';
const needStaff = (u) => { if (!isStaff(u)) fail(403, 'Ruxsat yo‘q'); };
const needAdmin = (u) => { if (u.role !== 'admin') fail(403, 'Faqat admin uchun'); };
const studentsOf = (gid) => q("SELECT u.id,u.name,u.username FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id=? AND u.active=1 AND u.role='student' ORDER BY u.name", gid).map((r) => r);

// Bildirishnoma: bazaga + Telegram bot orqali
async function tgApi(method, payload) {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    return await r.json();
  } catch (e) { console.error('Telegram xato:', e.message); return null; }
}
function notify(userIds, text) {
  for (const id of [...new Set(userIds)]) {
    const u = q1('SELECT tg_id,active FROM users WHERE id=?', id);
    if (!u || !u.active) continue;
    run('INSERT INTO notifications(user_id,text,created_at) VALUES(?,?,?)', id, text, now());
    if (u.tg_id) tgApi('sendMessage', { chat_id: u.tg_id, text: '🔔 ' + text, reply_markup: WEBAPP_URL ? { inline_keyboard: [[{ text: 'Ilovani ochish', web_app: { url: WEBAPP_URL } }]] } : undefined });
  }
}
const groupStudentIds = (gid) => studentsOf(gid).map((s) => s.id);

// ---------- Telegram initData tekshiruvi ----------
function verifyInitData(initData) {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash'); if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - +p.get('auth_date') > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('DELETE FROM sessions WHERE expires_at<?', Date.now());
  run('INSERT INTO sessions VALUES(?,?,?)', token, userId, Date.now() + 7 * 864e5);
  return token;
}
function userFromToken(token) {
  if (!token) return null;
  const s = q1('SELECT * FROM sessions WHERE token=? AND expires_at>?', token, Date.now());
  if (!s) return null;
  const u = q1('SELECT * FROM users WHERE id=? AND active=1', s.user_id);
  return u;
}

// ---------- Marshrutlar ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

// Auth
route('POST', '/api/auth', async ({ body }) => {
  if (DEV) fail(400, 'DEV rejim: /api/dev/login ishlating');
  const tu = verifyInitData(clean(body.initData, 5000));
  if (!tu) fail(401, 'Telegram imzosi noto‘g‘ri yoki eskirgan');
  let u = q1('SELECT * FROM users WHERE tg_id=?', tu.id);
  if (!u && tu.username) {
    u = q1('SELECT * FROM users WHERE tg_id IS NULL AND lower(username)=lower(?)', tu.username);
    if (u) run('UPDATE users SET tg_id=? WHERE id=?', tu.id, u.id);
  }
  if (!u || !u.active) fail(403, 'Siz ro‘yxatda yo‘qsiz. Admin sizni o‘quvchi/ustoz sifatida qo‘shishi kerak.');
  return { token: newSession(u.id), user: pubUser(u) };
}, { public: true });
route('GET', '/api/dev/users', () => { if (!DEV) fail(404, 'Topilmadi'); return q('SELECT id,name,role FROM users WHERE active=1 ORDER BY role,name'); }, { public: true });
route('POST', '/api/dev/login', ({ body }) => {
  if (!DEV) fail(404, 'Topilmadi');
  const u = q1('SELECT * FROM users WHERE id=? AND active=1', +body.user_id); if (!u) fail(404, 'Topilmadi');
  return { token: newSession(u.id), user: pubUser(u) };
}, { public: true });
const pubUser = (u) => ({ id: u.id, name: u.name, role: u.role, username: u.username });
route('GET', '/api/config', () => ({ dev: DEV }), { public: true });
route('GET', '/api/me', ({ user }) => pubUser(user));

// Bosh sahifa
route('GET', '/api/home', ({ user }) => {
  const gids = groupIds(user), ph = inList(gids);
  const upcoming = q(`SELECT l.*,g.name group_name FROM lessons l JOIN groups g ON g.id=l.group_id WHERE l.group_id IN(${ph}) AND l.status!='bekor' AND datetime(l.starts_at,'+'||l.duration||' minutes')>datetime('now') ORDER BY l.starts_at LIMIT 3`, ...gids);
  const ann = q(`SELECT a.*,u.name author FROM announcements a JOIN users u ON u.id=a.author_id WHERE a.group_id IS NULL OR a.group_id IN(${ph}) ORDER BY a.id DESC LIMIT 3`, ...gids);
  const unread = q1('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', user.id).c;
  const out = { upcoming, announcements: ann, unread };
  if (user.role === 'student') {
    out.todo = q(`SELECT a.id,a.title,a.due_at,g.name group_name FROM assignments a JOIN groups g ON g.id=a.group_id WHERE a.group_id IN(${ph}) AND NOT EXISTS(SELECT 1 FROM submissions s WHERE s.assignment_id=a.id AND s.student_id=?) ORDER BY a.due_at LIMIT 5`, ...gids, user.id);
    out.avg = q1('SELECT ROUND(AVG(score),1) a FROM grades WHERE student_id=?', user.id).a;
    const at = q1("SELECT COUNT(*) t, SUM(status!='kelmadi') p FROM attendance WHERE student_id=?", user.id);
    out.attendance = at.t ? Math.round((at.p / at.t) * 100) : null;
  } else {
    out.toReview = q1(`SELECT COUNT(*) c FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE a.group_id IN(${ph}) AND s.status='kutilmoqda'`, ...gids).c;
    out.groups = gids.length;
    if (user.role === 'admin') {
      out.students = q1("SELECT COUNT(*) c FROM users WHERE role='student' AND active=1").c;
      out.teachers = q1("SELECT COUNT(*) c FROM users WHERE role='teacher' AND active=1").c;
    }
  }
  return out;
});

// Foydalanuvchilar (admin)
route('GET', '/api/users', ({ user, query }) => {
  needStaff(user);
  if (user.role === 'teacher') { // ustoz faqat o'z o'quvchilarini ko'radi
    const gids = groupIds(user);
    return q(`SELECT DISTINCT u.id,u.name,u.username,u.role,u.active FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id IN(${inList(gids)}) ORDER BY u.name`, ...gids);
  }
  const role = query.get('role');
  return q(`SELECT u.*,(SELECT group_concat(g.name,', ') FROM groups g JOIN memberships m ON m.group_id=g.id WHERE m.user_id=u.id) groups FROM users u ${role ? 'WHERE role=?' : ''} ORDER BY active DESC,role,name`, ...(role ? [role] : []));
});
route('POST', '/api/users', ({ user, body }) => {
  needAdmin(user);
  const name = need(clean(body.name, 100), 'Ism kiriting');
  const role = ['admin', 'teacher', 'student'].includes(body.role) ? body.role : fail(400, 'Rol noto‘g‘ri');
  const tg = body.tg_id ? +body.tg_id : null;
  const un = clean(body.username, 64).replace(/^@/, '') || null;
  if (!tg && !un) fail(400, 'Telegram ID yoki @username kiriting');
  if (tg && q1('SELECT 1 FROM users WHERE tg_id=?', tg)) fail(409, 'Bu Telegram ID allaqachon bor');
  const id = insert('INSERT INTO users(tg_id,username,name,role,created_at) VALUES(?,?,?,?,?)', tg, un, name, role, now());
  audit(user, `Foydalanuvchi yaratildi: ${name} (${role})`);
  return { id };
});
route('PUT', '/api/users/:id', ({ user, params, body }) => {
  needAdmin(user);
  const u = q1('SELECT * FROM users WHERE id=?', params.id) || fail(404, 'Topilmadi');
  const role = ['admin', 'teacher', 'student'].includes(body.role) ? body.role : u.role;
  const active = body.active === undefined ? u.active : body.active ? 1 : 0;
  if (u.id === user.id && (!active || role !== 'admin')) fail(400, 'O‘zingizni o‘chira/pasaytira olmaysiz');
  run('UPDATE users SET name=?,role=?,active=?,username=? WHERE id=?', clean(body.name, 100) || u.name, role, active, body.username === undefined ? u.username : clean(body.username, 64).replace(/^@/, '') || null, u.id);
  if (!active) run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(user, `Foydalanuvchi o‘zgartirildi: ${u.name} → ${role}${active ? '' : ' (faolsiz)'}`);
  return { ok: true };
});

// Guruhlar
route('GET', '/api/groups', ({ user }) => {
  const gids = groupIds(user);
  return q(`SELECT g.*,t.name teacher_name,(SELECT COUNT(*) FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.group_id=g.id AND u.active=1) members FROM groups g LEFT JOIN users t ON t.id=g.teacher_id WHERE g.id IN(${inList(gids)}) ORDER BY g.name`, ...gids);
});
route('GET', '/api/groups/:id', ({ user, params }) => {
  needGroup(user, params.id);
  const g = q1('SELECT g.*,t.name teacher_name FROM groups g LEFT JOIN users t ON t.id=g.teacher_id WHERE g.id=?', params.id);
  return { ...g, members: user.role === 'student' ? [] : studentsOf(g.id) };
});
route('POST', '/api/groups', ({ user, body }) => {
  needAdmin(user);
  const t = body.teacher_id ? +body.teacher_id : null;
  if (t && !q1("SELECT 1 FROM users WHERE id=? AND role='teacher'", t)) fail(400, 'Ustoz topilmadi');
  const id = insert('INSERT INTO groups(name,teacher_id,created_at) VALUES(?,?,?)', need(clean(body.name, 100), 'Guruh nomini kiriting'), t, now());
  audit(user, `Guruh yaratildi: ${body.name}`);
  return { id };
});
route('PUT', '/api/groups/:id', ({ user, params, body }) => {
  needAdmin(user);
  const g = q1('SELECT * FROM groups WHERE id=?', params.id) || fail(404, 'Topilmadi');
  const t = body.teacher_id === undefined ? g.teacher_id : body.teacher_id ? +body.teacher_id : null;
  if (t && !q1("SELECT 1 FROM users WHERE id=? AND role='teacher'", t)) fail(400, 'Ustoz topilmadi');
  run('UPDATE groups SET name=?,teacher_id=?,active=? WHERE id=?', clean(body.name, 100) || g.name, t, body.active === undefined ? g.active : body.active ? 1 : 0, g.id);
  audit(user, `Guruh o‘zgartirildi: ${g.name}`);
  return { ok: true };
});
route('POST', '/api/groups/:id/members', ({ user, params, body }) => {
  needAdmin(user);
  q1('SELECT 1 FROM groups WHERE id=?', params.id) || fail(404, 'Guruh topilmadi');
  const s = q1("SELECT * FROM users WHERE id=? AND role='student'", +body.user_id) || fail(400, 'O‘quvchi topilmadi');
  run('INSERT OR IGNORE INTO memberships VALUES(?,?)', params.id, s.id);
  notify([s.id], `Siz “${q1('SELECT name FROM groups WHERE id=?', params.id).name}” guruhiga qo‘shildingiz`);
  audit(user, `${s.name} guruhga biriktirildi (#${params.id})`);
  return { ok: true };
});
route('DELETE', '/api/groups/:id/members/:uid', ({ user, params }) => {
  needAdmin(user);
  run('DELETE FROM memberships WHERE group_id=? AND user_id=?', params.id, params.uid);
  audit(user, `O‘quvchi #${params.uid} guruhdan chiqarildi (#${params.id})`);
  return { ok: true };
});

// Jadval / darslar
const LESSON_STATUS = ['rejalashtirilgan', 'otkazildi', 'bekor', 'kochirildi'];
route('GET', '/api/lessons', ({ user, query }) => {
  const gids = groupIds(user), ph = inList(gids);
  const g = query.get('group');
  if (g) needGroup(user, g);
  const my = user.role === 'student' ? ', (SELECT status FROM attendance a WHERE a.lesson_id=l.id AND a.student_id=' + user.id + ') my_att' : '';
  return q(`SELECT l.*,g.name group_name${my} FROM lessons l JOIN groups g ON g.id=l.group_id WHERE l.group_id IN(${ph}) ${g ? 'AND l.group_id=' + +g : ''} ORDER BY l.starts_at`, ...gids);
});
route('POST', '/api/lessons', ({ user, body }) => {
  needStaff(user);
  const gid = needGroup(user, body.group_id);
  const starts = isoOrFail(body.starts_at, 'Sana/vaqt noto‘g‘ri');
  const title = need(clean(body.title, 150), 'Mavzuni kiriting');
  const id = insert('INSERT INTO lessons(group_id,title,starts_at,duration,link,created_at) VALUES(?,?,?,?,?,?)', gid, title, starts, Math.min(600, Math.max(10, +body.duration || 60)), safeUrl(body.link), now());
  notify(groupStudentIds(gid), `Yangi dars: ${title} — ${fmtDate(starts)}`);
  return { id };
});
const fmtDate = (iso) => new Date(iso).toLocaleString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
route('PUT', '/api/lessons/:id', ({ user, params, body }) => {
  needStaff(user);
  const l = q1('SELECT * FROM lessons WHERE id=?', params.id) || fail(404, 'Topilmadi');
  needGroup(user, l.group_id);
  const status = body.status === undefined ? l.status : LESSON_STATUS.includes(body.status) ? body.status : fail(400, 'Holat noto‘g‘ri');
  const starts = body.starts_at ? isoOrFail(body.starts_at, 'Sana/vaqt noto‘g‘ri') : l.starts_at;
  run('UPDATE lessons SET title=?,starts_at=?,duration=?,link=?,status=? WHERE id=?', clean(body.title, 150) || l.title, starts, body.duration ? Math.min(600, Math.max(10, +body.duration)) : l.duration, body.link === undefined ? l.link : safeUrl(body.link), status, l.id);
  if (status !== l.status || starts !== l.starts_at) {
    const label = { rejalashtirilgan: 'rejalashtirildi', otkazildi: 'o‘tkazildi', bekor: 'BEKOR QILINDI', kochirildi: 'ko‘chirildi' }[status];
    notify(groupStudentIds(l.group_id), `Dars “${l.title}” ${label}${starts !== l.starts_at ? ` — yangi vaqt: ${fmtDate(starts)}` : ''}`);
  }
  return { ok: true };
});
route('DELETE', '/api/lessons/:id', ({ user, params }) => {
  needStaff(user);
  const l = q1('SELECT * FROM lessons WHERE id=?', params.id) || fail(404, 'Topilmadi');
  needGroup(user, l.group_id); run('DELETE FROM lessons WHERE id=?', l.id); return { ok: true };
});

// Davomat
route('GET', '/api/attendance', ({ user, query }) => {
  if (user.role === 'student') {
    return q(`SELECT a.status,l.id lesson_id,l.title,l.starts_at,g.name group_name FROM attendance a JOIN lessons l ON l.id=a.lesson_id JOIN groups g ON g.id=l.group_id WHERE a.student_id=? ORDER BY l.starts_at DESC`, user.id);
  }
  const lid = +query.get('lesson') || fail(400, 'lesson kerak');
  const l = q1('SELECT * FROM lessons WHERE id=?', lid) || fail(404, 'Topilmadi'); needGroup(user, l.group_id);
  return { lesson: l, students: q('SELECT u.id,u.name,(SELECT status FROM attendance a WHERE a.lesson_id=? AND a.student_id=u.id) status FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id=? AND u.active=1 AND u.role=\'student\' ORDER BY u.name', lid, l.group_id) };
});
route('PUT', '/api/attendance', ({ user, body }) => {
  needStaff(user);
  const l = q1('SELECT * FROM lessons WHERE id=?', +body.lesson_id) || fail(404, 'Dars topilmadi'); needGroup(user, l.group_id);
  const status = ['keldi', 'kelmadi', 'kechikdi'].includes(body.status) ? body.status : fail(400, 'Holat noto‘g‘ri');
  if (!q1('SELECT 1 FROM memberships WHERE group_id=? AND user_id=?', l.group_id, +body.student_id)) fail(400, 'O‘quvchi bu guruhda emas');
  run('INSERT INTO attendance VALUES(?,?,?) ON CONFLICT(lesson_id,student_id) DO UPDATE SET status=excluded.status', l.id, +body.student_id, status);
  return { ok: true };
});

// Baholar
route('GET', '/api/grades', ({ user, query }) => {
  if (user.role === 'student') return q('SELECT gr.*,g.name group_name FROM grades gr JOIN groups g ON g.id=gr.group_id WHERE gr.student_id=? ORDER BY gr.created_at DESC', user.id);
  const gids = groupIds(user), g = query.get('group');
  if (g) needGroup(user, g);
  return q(`SELECT gr.*,g.name group_name,u.name student_name FROM grades gr JOIN groups g ON g.id=gr.group_id JOIN users u ON u.id=gr.student_id WHERE gr.group_id IN(${inList(gids)}) ${g ? 'AND gr.group_id=' + +g : ''} ORDER BY gr.created_at DESC LIMIT 300`, ...gids);
});
route('POST', '/api/grades', ({ user, body }) => {
  needStaff(user);
  const gid = needGroup(user, body.group_id), sid = +body.student_id;
  if (!q1('SELECT 1 FROM memberships WHERE group_id=? AND user_id=?', gid, sid)) fail(400, 'O‘quvchi bu guruhda emas');
  const score = Math.round(+body.score); if (!(score >= 0 && score <= 100)) fail(400, 'Baho 0 dan 100 gacha bo‘lishi kerak');
  const id = insert('INSERT INTO grades(student_id,group_id,teacher_id,title,score,comment,created_at) VALUES(?,?,?,?,?,?,?)', sid, gid, user.id, clean(body.title, 150) || null, score, clean(body.comment) || null, now());
  notify([sid], `Yangi baho: ${score}/100${body.title ? ' — ' + clean(body.title, 80) : ''}`);
  return { id };
});
route('PUT', '/api/grades/:id', ({ user, params, body }) => {
  needStaff(user);
  const g = q1('SELECT * FROM grades WHERE id=?', params.id) || fail(404, 'Topilmadi'); needGroup(user, g.group_id);
  const score = Math.round(+body.score); if (!(score >= 0 && score <= 100)) fail(400, 'Baho 0 dan 100 gacha bo‘lishi kerak');
  run('UPDATE grades SET score=?,prev_score=?,comment=?,updated_at=? WHERE id=?', score, g.score, body.comment === undefined ? g.comment : clean(body.comment) || null, now(), g.id);
  notify([g.student_id], `Baho o‘zgartirildi: ${g.score} → ${score}`);
  return { ok: true };
});

// Fayllar
route('POST', '/api/upload', async ({ user, req, query }) => {
  const gid = query.get('group') ? needGroup(user, query.get('group')) : null;
  const name = clean(decodeURIComponent(req.headers['x-file-name'] || 'fayl'), 150).replace(/[\\/\0]/g, '_');
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) fail(400, 'Bu fayl turi ruxsat etilmagan');
  if (+req.headers['content-length'] > MAX_FILE) fail(413, 'Fayl 20 MB dan katta');
  const stored = crypto.randomBytes(16).toString('hex') + '.' + ext, full = path.join(UPLOAD_DIR, stored);
  let size = 0;
  const out = fs.createWriteStream(full);
  try {
    await new Promise((res, rej) => {
      req.on('data', (c) => { size += c.length; if (size > MAX_FILE) { rej(new HttpError(413, 'Fayl 20 MB dan katta')); req.destroy(); } else out.write(c); });
      req.on('end', () => out.end(res)); req.on('error', rej);
    });
  } catch (e) { out.destroy(); fs.rmSync(full, { force: true }); throw e; }
  if (!size) { fs.rmSync(full, { force: true }); fail(400, 'Fayl bo‘sh'); }
  const id = insert('INSERT INTO files(name,path,size,mime,owner_id,group_id,created_at) VALUES(?,?,?,?,?,?,?)', name, stored, size, MIME[ext] || 'application/octet-stream', user.id, gid, now());
  return { id, name, size };
}, { raw: true });
const MIME = { pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain; charset=utf-8' };
route('GET', '/api/files/:id', ({ user, params, res, req }) => {
  const f = q1('SELECT * FROM files WHERE id=?', params.id) || fail(404, 'Topilmadi');
  if (!(user.role === 'admin' || f.owner_id === user.id || (f.group_id && canGroup(user, f.group_id)))) fail(403, 'Ruxsat yo‘q');
  // Talabaning topshirgan fayli (group_id bor) faqat egasi va ustozga ko'rinadi
  if (user.role === 'student' && f.owner_id !== user.id && q1('SELECT 1 FROM submissions WHERE file_id=?', f.id)) fail(403, 'Ruxsat yo‘q');
  const full = path.join(UPLOAD_DIR, f.path);
  if (!fs.existsSync(full)) fail(404, 'Fayl topilmadi');
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  const headers = { 'content-type': f.mime, 'accept-ranges': 'bytes', 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=3600' };
  if (range) { // audio/video uchun
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], f.size - 1) : f.size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${f.size}`, 'content-length': end - start + 1 });
    fs.createReadStream(full, { start, end }).pipe(res);
  } else { res.writeHead(200, { ...headers, 'content-length': f.size }); fs.createReadStream(full).pipe(res); }
  return undefined;
}, { stream: true });
const fileOf = (id, user, gid) => {
  if (!id) return null;
  const f = q1('SELECT * FROM files WHERE id=?', +id) || fail(400, 'Fayl topilmadi');
  if (f.owner_id !== user.id) fail(403, 'Bu fayl sizniki emas');
  if (gid && f.group_id !== gid) fail(400, 'Fayl boshqa guruh uchun yuklangan');
  return f.id;
};

// Vazifalar
const ASSIGN_SQL = `SELECT a.*,g.name group_name,f.name file_name FROM assignments a JOIN groups g ON g.id=a.group_id LEFT JOIN files f ON f.id=a.file_id`;
route('GET', '/api/assignments', ({ user, query }) => {
  const gids = groupIds(user), g = query.get('group');
  if (g) needGroup(user, g);
  const rows = q(`${ASSIGN_SQL} WHERE a.group_id IN(${inList(gids)}) ${g ? 'AND a.group_id=' + +g : ''} ORDER BY a.due_at DESC`, ...gids);
  for (const a of rows) {
    if (user.role === 'student') a.mine = q1('SELECT id,status,score,late,submitted_at FROM submissions WHERE assignment_id=? AND student_id=?', a.id, user.id);
    else { const c = q1("SELECT COUNT(*) total, SUM(status='kutilmoqda') pending FROM submissions WHERE assignment_id=?", a.id); a.submitted = c.total; a.pending = c.pending || 0; a.students = studentsOf(a.group_id).length; }
  }
  return rows;
});
route('GET', '/api/assignments/:id', ({ user, params }) => {
  const a = q1(`${ASSIGN_SQL} WHERE a.id=?`, params.id) || fail(404, 'Topilmadi'); needGroup(user, a.group_id);
  const sel = 'SELECT s.*,u.name student_name,f.name file_name FROM submissions s JOIN users u ON u.id=s.student_id LEFT JOIN files f ON f.id=s.file_id';
  if (user.role === 'student') a.mine = q1(`${sel} WHERE s.assignment_id=? AND s.student_id=?`, a.id, user.id);
  else {
    a.submissions = q(`${sel} WHERE s.assignment_id=? ORDER BY s.submitted_at`, a.id);
    const done = new Set(a.submissions.map((s) => s.student_id));
    a.missing = studentsOf(a.group_id).filter((s) => !done.has(s.id));
  }
  return a;
});
route('POST', '/api/assignments', ({ user, body }) => {
  needStaff(user);
  const gid = needGroup(user, body.group_id);
  const title = need(clean(body.title, 150), 'Topshiriq nomini kiriting');
  const id = insert('INSERT INTO assignments(group_id,title,description,due_at,file_id,link,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', gid, title, clean(body.description, 4000) || null, isoOrFail(body.due_at, 'Muddat noto‘g‘ri'), fileOf(body.file_id, user, gid), safeUrl(body.link), user.id, now());
  notify(groupStudentIds(gid), `Yangi vazifa: ${title} — muddat ${fmtDate(body.due_at)}`);
  return { id };
});
route('DELETE', '/api/assignments/:id', ({ user, params }) => {
  needStaff(user);
  const a = q1('SELECT * FROM assignments WHERE id=?', params.id) || fail(404, 'Topilmadi'); needGroup(user, a.group_id);
  run('DELETE FROM assignments WHERE id=?', a.id); return { ok: true };
});
route('POST', '/api/assignments/:id/submit', ({ user, params, body }) => {
  if (user.role !== 'student') fail(403, 'Faqat o‘quvchi topshiradi');
  const a = q1('SELECT * FROM assignments WHERE id=?', params.id) || fail(404, 'Topilmadi'); needGroup(user, a.group_id);
  const text = clean(body.text, 5000), file = fileOf(body.file_id, user, a.group_id);
  if (!text && !file) fail(400, 'Javob matni yoki fayl kerak');
  const old = q1('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?', a.id, user.id);
  if (old && old.status === 'tekshirildi') fail(400, 'Tekshirilgan javobni o‘zgartirib bo‘lmaydi');
  const late = new Date() > new Date(a.due_at) ? 1 : 0;
  run(`INSERT INTO submissions(assignment_id,student_id,text,file_id,late,submitted_at) VALUES(?,?,?,?,?,?) ON CONFLICT(assignment_id,student_id) DO UPDATE SET text=excluded.text,file_id=COALESCE(excluded.file_id,file_id),status='kutilmoqda',late=excluded.late,submitted_at=excluded.submitted_at`, a.id, user.id, text || null, file, late, now());
  const g = q1('SELECT teacher_id FROM groups WHERE id=?', a.group_id);
  if (g.teacher_id) notify([g.teacher_id], `${user.name} “${a.title}” vazifasiga javob yubordi${late ? ' (kechikib)' : ''}`);
  return { ok: true, late: !!late };
});
route('PUT', '/api/submissions/:id', ({ user, params, body }) => {
  needStaff(user);
  const s = q1('SELECT s.*,a.group_id,a.title FROM submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.id=?', params.id) || fail(404, 'Topilmadi'); needGroup(user, s.group_id);
  const status = ['tekshirildi', 'qayta'].includes(body.status) ? body.status : fail(400, 'Holat noto‘g‘ri');
  let score = null;
  if (body.score !== '' && body.score !== undefined && body.score !== null) { score = Math.round(+body.score); if (!(score >= 0 && score <= 100)) fail(400, 'Baho 0 dan 100 gacha'); }
  run('UPDATE submissions SET status=?,score=?,feedback=?,reviewed_at=? WHERE id=?', status, score, clean(body.feedback) || null, now(), s.id);
  if (score !== null && status === 'tekshirildi') insert('INSERT INTO grades(student_id,group_id,teacher_id,title,score,comment,created_at) VALUES(?,?,?,?,?,?,?)', s.student_id, s.group_id, user.id, s.title, score, clean(body.feedback) || null, now());
  notify([s.student_id], status === 'qayta' ? `“${s.title}”: qayta ishlash kerak. ${clean(body.feedback, 150)}` : `“${s.title}” tekshirildi${score !== null ? ': ' + score + '/100' : ''}`);
  return { ok: true };
});

// Materiallar
route('GET', '/api/resources', ({ user, query }) => {
  const gids = groupIds(user), g = query.get('group');
  if (g) needGroup(user, g);
  return q(`SELECT r.*,g.name group_name,f.name file_name,f.size file_size FROM resources r JOIN groups g ON g.id=r.group_id LEFT JOIN files f ON f.id=r.file_id WHERE r.group_id IN(${inList(gids)}) ${g ? 'AND r.group_id=' + +g : ''} ORDER BY r.id DESC`, ...gids);
});
route('POST', '/api/resources', ({ user, body }) => {
  needStaff(user);
  const gid = needGroup(user, body.group_id), title = need(clean(body.title, 150), 'Nomini kiriting');
  const kind = ['pdf', 'audio', 'video', 'havola', 'yozuv'].includes(body.kind) ? body.kind : 'havola';
  const file = fileOf(body.file_id, user, gid), url = safeUrl(body.url);
  if (!file && !url) fail(400, 'Fayl yoki havola kerak');
  const id = insert('INSERT INTO resources(group_id,title,kind,url,file_id,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)', gid, title, kind, url, file, user.id, now());
  notify(groupStudentIds(gid), `Yangi material: ${title}`);
  return { id };
});
route('DELETE', '/api/resources/:id', ({ user, params }) => {
  needStaff(user);
  const r = q1('SELECT * FROM resources WHERE id=?', params.id) || fail(404, 'Topilmadi'); needGroup(user, r.group_id);
  run('DELETE FROM resources WHERE id=?', r.id); return { ok: true };
});

// Chat
route('GET', '/api/chat/peers', ({ user }) => {
  if (user.role === 'admin') return q('SELECT id,name,role FROM users WHERE active=1 AND id!=? ORDER BY name', user.id);
  const gids = groupIds(user), ph = inList(gids);
  return user.role === 'student'
    ? q(`SELECT DISTINCT u.id,u.name,u.role FROM users u JOIN groups g ON g.teacher_id=u.id WHERE g.id IN(${ph}) AND u.active=1`, ...gids)
    : q(`SELECT DISTINCT u.id,u.name,u.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.group_id IN(${ph}) AND u.active=1 ORDER BY u.name`, ...gids);
});
function canPeer(u, pid) {
  const p = q1('SELECT * FROM users WHERE id=? AND active=1', pid);
  if (!p || p.id === u.id) return false;
  if (u.role === 'admin' || p.role === 'admin') return true;
  if (u.role === p.role) return false;
  const [t, s] = u.role === 'teacher' ? [u.id, p.id] : [p.id, u.id];
  return !!q1('SELECT 1 FROM groups g JOIN memberships m ON m.group_id=g.id WHERE g.teacher_id=? AND m.user_id=?', t, s);
}
route('GET', '/api/chat', ({ user, query }) => {
  const after = +query.get('after') || 0;
  if (query.get('group')) {
    const gid = needGroup(user, query.get('group'));
    return q('SELECT m.*,u.name from_name FROM messages m JOIN users u ON u.id=m.from_id WHERE m.group_id=? AND m.to_id IS NULL AND m.id>? ORDER BY m.id DESC LIMIT 100', gid, after).reverse();
  }
  const peer = +query.get('peer') || fail(400, 'group yoki peer kerak');
  if (!canPeer(user, peer)) fail(403, 'Ruxsat yo‘q');
  return q('SELECT m.*,u.name from_name FROM messages m JOIN users u ON u.id=m.from_id WHERE m.group_id IS NULL AND ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?)) AND m.id>? ORDER BY m.id DESC LIMIT 100', user.id, peer, peer, user.id, after).reverse();
});
route('POST', '/api/chat', ({ user, body }) => {
  const text = need(clean(body.text, 2000), 'Xabar bo‘sh');
  if (body.group_id) { const gid = needGroup(user, body.group_id); return { id: insert('INSERT INTO messages(group_id,from_id,text,created_at) VALUES(?,?,?,?)', gid, user.id, text, now()) }; }
  const peer = +body.to_id; if (!canPeer(user, peer)) fail(403, 'Ruxsat yo‘q');
  const id = insert('INSERT INTO messages(from_id,to_id,text,created_at) VALUES(?,?,?,?)', user.id, peer, text, now());
  notify([peer], `${user.name}: ${text.slice(0, 100)}`);
  return { id };
});

// E'lonlar
route('GET', '/api/announcements', ({ user }) => {
  const gids = groupIds(user);
  return q(`SELECT a.*,u.name author,g.name group_name FROM announcements a JOIN users u ON u.id=a.author_id LEFT JOIN groups g ON g.id=a.group_id WHERE ${user.role === 'admin' ? '1' : `a.group_id IS NULL OR a.group_id IN(${inList(gids)})`} ORDER BY a.id DESC LIMIT 100`, ...(user.role === 'admin' ? [] : gids));
});
route('POST', '/api/announcements', ({ user, body }) => {
  needStaff(user);
  const title = need(clean(body.title, 150), 'Sarlavha kiriting'), gid = body.group_id ? needGroup(user, body.group_id) : null;
  if (!gid && user.role !== 'admin') fail(403, 'Barchaga e’lonni faqat admin yuboradi');
  const id = insert('INSERT INTO announcements(author_id,group_id,title,body,created_at) VALUES(?,?,?,?,?)', user.id, gid, title, clean(body.body, 4000) || null, now());
  const rec = gid ? groupStudentIds(gid) : q("SELECT id FROM users WHERE active=1 AND id!=?", user.id).map((r) => r.id);
  notify(rec, `E’lon: ${title}`);
  return { id };
});
route('DELETE', '/api/announcements/:id', ({ user, params }) => {
  needStaff(user);
  const a = q1('SELECT * FROM announcements WHERE id=?', params.id) || fail(404, 'Topilmadi');
  if (user.role !== 'admin' && a.author_id !== user.id) fail(403, 'Ruxsat yo‘q');
  run('DELETE FROM announcements WHERE id=?', a.id); return { ok: true };
});

// Bildirishnomalar
route('GET', '/api/notifications', ({ user }) => q('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', user.id));
route('POST', '/api/notifications/read', ({ user }) => { run('UPDATE notifications SET read=1 WHERE user_id=?', user.id); return { ok: true }; });

// Admin: audit va zaxira
route('GET', '/api/admin/audit', ({ user }) => { needAdmin(user); return q('SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200'); });
route('POST', '/api/admin/backup', ({ user }) => { needAdmin(user); const f = makeBackup(); audit(user, 'Zaxira nusxa yaratildi'); return { file: f }; });
route('GET', '/api/admin/backups', ({ user }) => { needAdmin(user); return fs.readdirSync(BACKUP_DIR).sort().reverse().slice(0, 14); });

function makeBackup() {
  const f = `qalam-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  db.exec(`VACUUM INTO '${path.join(BACKUP_DIR, f).replace(/'/g, "''")}'`);
  const all = fs.readdirSync(BACKUP_DIR).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(BACKUP_DIR, old), { force: true }); // oxirgi 14 ta
  return f;
}
setInterval(() => { try { makeBackup(); } catch (e) { console.error('Zaxira xatosi', e.message); } }, 24 * 3600e3).unref();

// ---------- HTTP server ----------
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org",
};
const hits = new Map(); // oddiy rate limit: IP bo'yicha daqiqada 300 so'rov
setInterval(() => hits.clear(), 60e3).unref();

function send(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(body);
}
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) fail(413, 'So‘rov juda katta'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'JSON noto‘g‘ri'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (url.pathname.startsWith('/api/')) {
      if ((hits.set(ip, (hits.get(ip) || 0) + 1).get(ip)) > 600) fail(429, 'Juda ko‘p so‘rov. Biroz kuting.');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) fail(404, 'Topilmadi');
      const params = url.pathname.match(r.re).groups || {};
      let user = null;
      if (!r.public) {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '') || (r.stream ? url.searchParams.get('t') : '');
        user = userFromToken(token) || fail(401, 'Kirish kerak');
      }
      const body = ['POST', 'PUT'].includes(req.method) && !r.raw ? await readJson(req) : {};
      const out = await r.handler({ req, res, user, params, query: url.searchParams, body });
      if (r.stream) return;
      return send(res, 200, out);
    }
    // Statik fayllar
    let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
    const full = path.normalize(path.join(PUBLIC_DIR, p));
    if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Topilmadi'); }
    res.writeHead(200, { 'content-type': STATIC_TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SEC_HEADERS });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'Server xatosi' });
  }
});

// ---------- Telegram bot (long polling): /start → "Ilovani ochish" ----------
async function botLoop() {
  if (!BOT_TOKEN) return;
  if (WEBAPP_URL) await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Ilovani ochish', web_app: { url: WEBAPP_URL } } });
  let offset = 0;
  for (;;) {
    const r = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
    if (!r?.ok) { await new Promise((s) => setTimeout(s, 5000)); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      const m = u.message; if (!m?.text?.startsWith('/start')) continue;
      tgApi('sendMessage', { chat_id: m.chat.id, text: 'Qalam Arabic Academy platformasiga xush kelibsiz! 📖\nIlovani ochish uchun tugmani bosing.', reply_markup: WEBAPP_URL ? { inline_keyboard: [[{ text: 'Ilovani ochish', web_app: { url: WEBAPP_URL } }]] } : undefined });
    }
  }
}

// ---------- DEV rejim uchun demo ma'lumotlar ----------
function seedDemo() {
  if (q1('SELECT 1 FROM users LIMIT 1')) return;
  const t = now(), h = (n) => new Date(Date.now() + n * 36e5).toISOString();
  const U = (tg, un, name, role) => insert('INSERT INTO users(tg_id,username,name,role,created_at) VALUES(?,?,?,?,?)', tg, un, name, role, t);
  const admin = U(900001, 'admin_demo', 'Admin (demo)', 'admin');
  const teacher = U(900002, 'ustoz_demo', 'Ustoz Abdulloh', 'teacher');
  const s = [U(900003, null, 'Madina Karimova', 'student'), U(900004, null, 'Aziz Rahimov', 'student'), U(900005, null, 'Zarina Yusupova', 'student')];
  const g1 = insert('INSERT INTO groups(name,teacher_id,created_at) VALUES(?,?,?)', 'Arab tili — Boshlang‘ich A1', teacher, t);
  const g2 = insert('INSERT INTO groups(name,teacher_id,created_at) VALUES(?,?,?)', 'Qur’on o‘qish — Tajvid', teacher, t);
  for (const x of s) run('INSERT INTO memberships VALUES(?,?)', g1, x);
  run('INSERT INTO memberships VALUES(?,?)', g2, s[0]);
  const l1 = insert('INSERT INTO lessons(group_id,title,starts_at,duration,link,created_at) VALUES(?,?,?,?,?,?)', g1, 'Alifbo: harflarning yozilishi', h(-48), 60, null, t);
  insert('INSERT INTO lessons(group_id,title,starts_at,duration,link,created_at) VALUES(?,?,?,?,?,?)', g1, 'Harakatlar: fatha, kasra, damma', h(3), 60, 'https://meet.google.com/', t);
  insert('INSERT INTO lessons(group_id,title,starts_at,duration,link,created_at) VALUES(?,?,?,?,?,?)', g1, 'Birinchi so‘zlar va salomlashish', h(51), 60, 'https://meet.google.com/', t);
  insert('INSERT INTO lessons(group_id,title,starts_at,duration,link,created_at) VALUES(?,?,?,?,?,?)', g2, 'Makhraj — harflar chiqish joylari', h(27), 45, 'https://zoom.us/', t);
  run('INSERT INTO attendance VALUES(?,?,?)', l1, s[0], 'keldi'); run('INSERT INTO attendance VALUES(?,?,?)', l1, s[1], 'kechikdi'); run('INSERT INTO attendance VALUES(?,?,?)', l1, s[2], 'kelmadi');
  run('INSERT INTO grades(student_id,group_id,teacher_id,title,score,comment,created_at) VALUES(?,?,?,?,?,?,?)', s[0], g1, teacher, 'Alifbo testi', 92, 'Ajoyib!', t);
  run('INSERT INTO grades(student_id,group_id,teacher_id,title,score,comment,created_at) VALUES(?,?,?,?,?,?,?)', s[1], g1, teacher, 'Alifbo testi', 74, 'Yana mashq qiling', t);
  const a1 = insert('INSERT INTO assignments(group_id,title,description,due_at,created_by,created_at) VALUES(?,?,?,?,?,?)', g1, 'Harflarni yozish mashqi', 'Alifbodagi 28 ta harfni har birini 5 martadan yozing va rasmga olib yuboring.', h(30), teacher, t);
  insert('INSERT INTO assignments(group_id,title,description,due_at,created_by,created_at) VALUES(?,?,?,?,?,?)', g1, 'Salomlashish lug‘ati', '10 ta salomlashish so‘zini yodlang.', h(-5), teacher, t);
  run('INSERT INTO submissions(assignment_id,student_id,text,submitted_at) VALUES(?,?,?,?)', a1, s[1], 'Vazifani bajardim, ustoz.', t);
  insert('INSERT INTO resources(group_id,title,kind,url,uploaded_by,created_at) VALUES(?,?,?,?,?,?)', g1, 'Arab alifbosi — video dars', 'video', 'https://www.youtube.com/', teacher, t);
  insert('INSERT INTO announcements(author_id,group_id,title,body,created_at) VALUES(?,?,?,?,?)', admin, null, 'Yangi o‘quv oyi boshlandi', 'Barcha o‘quvchilarga muvaffaqiyat tilaymiz! Dars jadvali “Jadval” bo‘limida.', t);
  insert('INSERT INTO messages(group_id,from_id,text,created_at) VALUES(?,?,?,?)', g1, teacher, 'Assalomu alaykum! Birinchi darsga tayyor bo‘ling.', t);
  console.log('Demo ma\'lumotlar yaratildi.');
}

if (require.main === module) {
  if (DEV) seedDemo();
  server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
    console.log(`Qalam Mini App: http://localhost:${PORT}  [${DEV ? 'DEV rejim (BOT_TOKEN yo‘q)' : 'PRODUCTION'}]`);
    botLoop();
  });
}
module.exports = { server, db };
