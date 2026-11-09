'use strict';
// Qalam Arabic Academy — Mini App frontend (vanilla JS)
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { try { tg.ready(); tg.expand(); } catch {} }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = { get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} } };
let token = store.get('tok'), me = null, pollTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyun', 'iyul', 'avg', 'sen', 'okt', 'noy', 'dek'];
const p2 = (n) => String(n).padStart(2, '0');
const fdate = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const ftime = (iso) => { const d = new Date(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const fdt = (iso) => `${fdate(iso)}, ${ftime(iso)}`;
const toLocalInput = (iso) => { const d = new Date(iso || Date.now() + 36e5); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const LS = { rejalashtirilgan: ['Rejalashtirilgan', 'pri'], otkazildi: ['O‘tkazildi', 'ok'], bekor: ['Bekor qilindi', 'bad'], kochirildi: ['Ko‘chirildi', 'warn'] };
const AS = { keldi: ['Keldi', 'ok'], kelmadi: ['Kelmadi', 'bad'], kechikdi: ['Kechikdi', 'warn'] };
const SS = { kutilmoqda: ['Kutilmoqda', 'warn'], tekshirildi: ['Tekshirildi', 'ok'], qayta: ['Qayta ishlash kerak', 'bad'] };
const ROLE = { admin: 'Admin', teacher: 'Ustoz', student: 'O‘quvchi' };
const pill = (map, k) => `<span class="pill ${map[k][1]}">${map[k][0]}</span>`;

function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3000); }

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && me) { token = null; location.reload(); }
  if (!r.ok) throw new Error(j.error || 'Xatolik');
  return j;
}
const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r === undefined ? true : r; } catch (e) { toast(e.message, true); return false; } };
async function upload(file, groupId) {
  if (file.size > 20 * 1024 * 1024) throw new Error('Fayl 20 MB dan katta');
  const r = await fetch('/api/upload?group=' + (groupId || ''), { method: 'POST', headers: { authorization: 'Bearer ' + token, 'x-file-name': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' }, body: file });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Yuklashda xatolik'); return j.id;
}
const fileUrl = (id) => `/api/files/${id}?t=${token}`;
const fileLink = (id, name) => `<a class="btn sec sm" href="${fileUrl(id)}" target="_blank" rel="noopener">📎 ${esc(name || 'Fayl')}</a>`;

// ---------- Modal / forma ----------
function modal(html) { const m = $('#modal'); m.innerHTML = `<div class="sheet">${html}</div>`; m.hidden = false; m.onclick = (e) => { if (e.target === m) closeModal(); }; return m; }
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
function field(f) {
  const v = f.value ?? '', req = f.required ? ' required' : '';
  let input;
  if (f.type === 'select') input = `<select name="${f.name}"${req}>${f.options.map((o) => `<option value="${esc(o[0])}"${String(o[0]) === String(v) ? ' selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  else if (f.type === 'textarea') input = `<textarea name="${f.name}"${req}>${esc(v)}</textarea>`;
  else if (f.type === 'file') input = `<input type="file" name="${f.name}">`;
  else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}"${req}${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}>`;
  return `<label>${esc(f.label)}</label>${input}`;
}
function form(title, fields, onSubmit, submitText = 'Saqlash') {
  const m = modal(`<h2>${esc(title)}</h2><form>${fields.map(field).join('')}<div class="btns"><button class="btn" type="submit">${submitText}</button><button class="btn sec" type="button" id="cancel">Bekor</button></div></form>`);
  $('#cancel', m).onclick = closeModal;
  $('form', m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), data = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === 'string'));
    for (const f of fields) if (f.type === 'file') data[f.name] = fd.get(f.name);
    const btn = $('button[type=submit]', m); btn.disabled = true;
    const ok = await act(() => onSubmit(data));
    btn.disabled = false;
    if (ok) { closeModal(); route(); }
  };
}
const confirmBox = (text, fn) => { const m = modal(`<h2>${esc(text)}</h2><div class="btns"><button class="btn bad" id="y">Ha</button><button class="btn sec" id="n">Yo‘q</button></div>`); $('#n', m).onclick = closeModal; $('#y', m).onclick = async () => { closeModal(); if (await act(fn)) route(); }; };

// ---------- Marshrutlash ----------
const TABS = {
  student: [['home', '🏠', 'Bosh'], ['schedule', '📅', 'Jadval'], ['assignments', '📝', 'Vazifalar'], ['grades', '⭐', 'Baholar'], ['more', '☰', 'Yana']],
  teacher: [['home', '🏠', 'Bosh'], ['groups', '👥', 'Guruhlar'], ['schedule', '📅', 'Jadval'], ['assignments', '📝', 'Vazifalar'], ['more', '☰', 'Yana']],
  admin: [['home', '🏠', 'Bosh'], ['users', '👤', 'Foydalanuvchilar'], ['groups', '👥', 'Guruhlar'], ['schedule', '📅', 'Jadval'], ['more', '☰', 'Yana']],
};
const isStaff = () => me.role !== 'student';
const PAGES = {};
async function route() {
  clearInterval(pollTimer);
  if (!me) return;
  const [name, ...args] = (location.hash.slice(2) || 'home').split('/');
  const page = PAGES[name] || PAGES.home;
  const tab = (TABS[me.role].find((t) => t[0] === name) ? name : 'more');
  $('#tabs').innerHTML = TABS[me.role].map((t) => `<a href="#/${t[0]}" class="${t[0] === (name === 'home' ? 'home' : tab) ? 'on' : ''}"><span>${t[1]}</span>${t[2]}</a>`).join('');
  const v = $('#view');
  try { v.innerHTML = '<div class="empty">Yuklanmoqda…</div>'; await page(v, ...args); }
  catch (e) { v.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
  refreshBadge();
}
async function refreshBadge() { try { const n = (await api('/notifications')).filter((x) => !x.read).length; $('#badge').hidden = !n; $('#badge').textContent = n; } catch {} }
window.addEventListener('hashchange', route);
const go = (h) => (location.hash = '#/' + h);
const empty = (t) => `<div class="empty">${t}</div>`;
const back = (to) => `<p><a href="#/${to}" class="sub">← Orqaga</a></p>`;
const groupOpts = (gs) => gs.map((g) => [g.id, g.name]);

// ---------- Bosh sahifa ----------
PAGES.home = async (v) => {
  const d = await api('/home');
  const lesson = (l) => `<div class="card click" data-go="schedule"><div class="row between"><div class="grow"><div class="t">${esc(l.title)}</div><div class="sub">${esc(l.group_name)} · ${fdt(l.starts_at)} · ${l.duration} daq</div></div>${pill(LS, l.status)}</div>${l.link && l.status !== 'bekor' ? `<a class="btn sm mt" href="${esc(l.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Darsga kirish</a>` : ''}</div>`;
  let h = `<h2>Salom, ${esc(me.name.split(' ')[0])} 👋</h2>`;
  if (me.role === 'student') h += `<div class="grid"><div class="stat"><b>${d.avg ?? '—'}</b><span>O‘rtacha baho</span></div><div class="stat"><b>${d.attendance === null ? '—' : d.attendance + '%'}</b><span>Davomat</span></div><div class="stat"><b>${d.todo.length}</b><span>Topshirilmagan vazifa</span></div></div>`;
  else h += `<div class="grid"><div class="stat"><b>${d.groups}</b><span>Guruhlar</span></div><div class="stat"><b>${d.toReview}</b><span>Tekshirilmagan javob</span></div>${me.role === 'admin' ? `<div class="stat"><b>${d.students}</b><span>O‘quvchilar</span></div><div class="stat"><b>${d.teachers}</b><span>Ustozlar</span></div>` : ''}</div>`;
  h += '<h3>Yaqin darslar</h3>' + (d.upcoming.map(lesson).join('') || empty('Yaqin dars yo‘q'));
  if (me.role === 'student') h += '<h3>Yangi vazifalar</h3>' + (d.todo.map((a) => `<div class="card click" data-go="assignment/${a.id}"><div class="row between"><div class="grow"><div class="t">${esc(a.title)}</div><div class="sub">${esc(a.group_name)} · muddat: ${fdt(a.due_at)}</div></div>${new Date(a.due_at) < new Date() ? '<span class="pill bad">Kechikkan</span>' : ''}</div></div>`).join('') || empty('Hamma vazifa topshirilgan 🎉'));
  h += '<h3>So‘nggi e’lonlar</h3>' + (d.announcements.map((a) => `<div class="card"><div class="t">${esc(a.title)}</div><div class="sub">${esc(a.author)} · ${fdate(a.created_at)}</div>${a.body ? `<pre>${esc(a.body)}</pre>` : ''}</div>`).join('') || empty('E’lon yo‘q'));
  v.innerHTML = h; bindGo(v);
};
function bindGo(r) { $$('[data-go]', r).forEach((e) => (e.onclick = () => go(e.dataset.go))); }

// ---------- Jadval ----------
PAGES.schedule = async (v) => {
  const [ls, gs] = await Promise.all([api('/lessons'), isStaff() ? api('/groups') : []]);
  const nowD = new Date(), upcoming = ls.filter((l) => new Date(l.starts_at) >= new Date(nowD - 36e5)), past = ls.filter((l) => !upcoming.includes(l)).reverse();
  let tab = 'up';
  const draw = () => {
    const list = tab === 'up' ? upcoming : past;
    let lastDay = '';
    v.innerHTML = `<h2>Jadval</h2>${isStaff() ? '<button class="btn" id="add">+ Dars qo‘shish</button>' : ''}<div class="seg mt"><button data-t="up" class="${tab === 'up' ? 'on' : ''}">Kelgusi (${upcoming.length})</button><button data-t="past" class="${tab === 'past' ? 'on' : ''}">O‘tgan (${past.length})</button></div>` +
      (list.map((l) => { const day = fdate(l.starts_at); const hd = day !== lastDay ? `<h3>${day}</h3>` : ''; lastDay = day;
        return hd + `<div class="card"><div class="row between"><div class="grow"><div class="t">${esc(l.title)}</div><div class="sub">${ftime(l.starts_at)} · ${l.duration} daq · ${esc(l.group_name)}</div></div><div>${pill(LS, l.status)}${l.my_att ? '<br>' + pill(AS, l.my_att) : ''}</div></div>
        <div class="btns">${l.link && l.status !== 'bekor' ? `<a class="btn sm" href="${esc(l.link)}" target="_blank" rel="noopener">Darsga kirish</a>` : ''}${isStaff() ? `<button class="btn sm sec" data-att="${l.id}">Davomat</button><button class="btn sm sec" data-edit="${l.id}">Tahrirlash</button><button class="btn sm sec" data-del="${l.id}">O‘chirish</button>` : ''}</div></div>`; }).join('') || empty('Darslar yo‘q'));
    $$('[data-t]', v).forEach((b) => (b.onclick = () => { tab = b.dataset.t; draw(); }));
    $$('[data-att]', v).forEach((b) => (b.onclick = () => go('attendance/' + b.dataset.att)));
    $$('[data-del]', v).forEach((b) => (b.onclick = () => confirmBox('Darsni o‘chirasizmi?', () => api('/lessons/' + b.dataset.del, 'DELETE'))));
    $$('[data-edit]', v).forEach((b) => (b.onclick = () => lessonForm(ls.find((l) => l.id == b.dataset.edit))));
    if ($('#add', v)) $('#add', v).onclick = () => lessonForm();
  };
  const lessonForm = (l) => form(l ? 'Darsni tahrirlash' : 'Yangi dars', [
    ...(l ? [] : [{ name: 'group_id', label: 'Guruh', type: 'select', options: groupOpts(gs), required: true }]),
    { name: 'title', label: 'Mavzu', value: l?.title, required: true },
    { name: 'starts_at', label: 'Sana va vaqt', type: 'datetime-local', value: toLocalInput(l?.starts_at), required: true },
    { name: 'duration', label: 'Davomiyligi (daqiqa)', type: 'number', value: l?.duration || 60, min: 10, max: 600 },
    { name: 'link', label: 'Online dars havolasi (Meet/Zoom)', type: 'url', value: l?.link || '' },
    ...(l ? [{ name: 'status', label: 'Holati', type: 'select', value: l.status, options: Object.entries(LS).map(([k, x]) => [k, x[0]]) }] : []),
  ], (d) => { d.starts_at = new Date(d.starts_at).toISOString(); return l ? api('/lessons/' + l.id, 'PUT', d) : api('/lessons', 'POST', d); });
  draw();
};

// ---------- Davomat ----------
PAGES.attendance = async (v, lid) => {
  if (!isStaff()) return PAGES.myAttendance(v);
  if (!lid) { const ls = (await api('/lessons')).reverse(); v.innerHTML = `<h2>Davomat</h2>` + (ls.map((l) => `<div class="card click" data-go="attendance/${l.id}"><div class="t">${esc(l.title)}</div><div class="sub">${esc(l.group_name)} · ${fdt(l.starts_at)}</div></div>`).join('') || empty('Darslar yo‘q')); return bindGo(v); }
  const d = await api('/attendance?lesson=' + lid);
  v.innerHTML = `${back('schedule')}<h2>${esc(d.lesson.title)}</h2><div class="sub">${fdt(d.lesson.starts_at)}</div><div class="mt"></div>` +
    (d.students.map((s) => `<div class="card"><div class="t">${esc(s.name)}</div><div class="seg mt" data-s="${s.id}">${Object.entries(AS).map(([k, x]) => `<button data-k="${k}" class="${s.status === k ? 'on' : ''}">${x[0]}</button>`).join('')}</div></div>`).join('') || empty('Guruhda o‘quvchi yo‘q'));
  $$('[data-s]', v).forEach((row) => $$('button', row).forEach((b) => (b.onclick = async () => {
    if (await act(() => api('/attendance', 'PUT', { lesson_id: +lid, student_id: +row.dataset.s, status: b.dataset.k }))) { $$('button', row).forEach((x) => x.classList.toggle('on', x === b)); }
  })));
};
PAGES.myAttendance = async (v) => {
  const a = await api('/attendance'), p = a.filter((x) => x.status !== 'kelmadi').length;
  v.innerHTML = `<h2>Davomat</h2><div class="grid"><div class="stat"><b>${a.length ? Math.round((p / a.length) * 100) + '%' : '—'}</b><span>Qatnashish</span></div><div class="stat"><b>${a.filter((x) => x.status === 'kelmadi').length}</b><span>Kelmagan</span></div></div>` +
    (a.map((x) => `<div class="card row between"><div class="grow"><div class="t">${esc(x.title)}</div><div class="sub">${esc(x.group_name)} · ${fdate(x.starts_at)}</div></div>${pill(AS, x.status)}</div>`).join('') || empty('Davomat ma’lumoti yo‘q'));
};

// ---------- Baholar ----------
PAGES.grades = async (v) => {
  const [gr, gs] = await Promise.all([api('/grades'), isStaff() ? api('/groups') : []]);
  const bar = (s) => `<div class="bar"><i style="width:${s}%;${s < 60 ? 'background:var(--bad)' : s < 80 ? 'background:var(--warn)' : ''}"></i></div>`;
  const hist = (g) => (g.prev_score !== null && g.prev_score !== undefined ? `<div class="sub">O‘zgartirilgan: ${g.prev_score} → ${g.score} (${fdate(g.updated_at)})</div>` : '');
  const avg = gr.length ? Math.round((gr.reduce((a, g) => a + g.score, 0) / gr.length) * 10) / 10 : '—';
  v.innerHTML = `<h2>Baholar</h2>${isStaff() ? '<button class="btn" id="add">+ Baho qo‘yish</button>' : `<div class="grid"><div class="stat"><b>${avg}</b><span>O‘rtacha</span></div><div class="stat"><b>${gr.length}</b><span>Baholar soni</span></div></div>`}<div class="mt"></div>` +
    (gr.map((g) => `<div class="card"><div class="row between"><div class="grow"><div class="t">${esc(g.title || 'Baho')}${g.student_name ? ' — ' + esc(g.student_name) : ''}</div><div class="sub">${esc(g.group_name)} · ${fdate(g.created_at)}</div></div><b style="font-size:20px">${g.score}</b></div>${bar(g.score)}${g.comment ? `<div class="sub mt">💬 ${esc(g.comment)}</div>` : ''}${hist(g)}${isStaff() ? `<div class="btns"><button class="btn sm sec" data-edit="${g.id}">O‘zgartirish</button></div>` : ''}</div>`).join('') || empty('Baholar hali yo‘q'));
  $$('[data-edit]', v).forEach((b) => (b.onclick = () => { const g = gr.find((x) => x.id == b.dataset.edit); form('Bahoni o‘zgartirish', [{ name: 'score', label: 'Baho (0–100)', type: 'number', min: 0, max: 100, value: g.score, required: true }, { name: 'comment', label: 'Izoh', type: 'textarea', value: g.comment }], (d) => api('/grades/' + g.id, 'PUT', d)); }));
  if ($('#add', v)) $('#add', v).onclick = async () => {
    if (!gs.length) return toast('Avval guruh kerak', true);
    const pick = (gid) => api('/groups/' + gid).then((g) => g.members);
    let members = await pick(gs[0].id);
    form('Baho qo‘yish', [{ name: 'group_id', label: 'Guruh', type: 'select', options: groupOpts(gs) }, { name: 'student_id', label: 'O‘quvchi', type: 'select', options: members.map((m) => [m.id, m.name]) }, { name: 'title', label: 'Nima uchun (test, imlo…)' }, { name: 'score', label: 'Baho (0–100)', type: 'number', min: 0, max: 100, required: true }, { name: 'comment', label: 'Izoh', type: 'textarea' }], (d) => api('/grades', 'POST', d));
    $('[name=group_id]').onchange = async (e) => { members = await pick(e.target.value); $('[name=student_id]').innerHTML = members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join(''); };
  };
};

// ---------- Vazifalar ----------
PAGES.assignments = async (v) => {
  const [as, gs] = await Promise.all([api('/assignments'), isStaff() ? api('/groups') : []]);
  const late = (a) => new Date(a.due_at) < new Date();
  v.innerHTML = `<h2>Vazifalar</h2>${isStaff() ? '<button class="btn" id="add">+ Vazifa yaratish</button><div class="mt"></div>' : ''}` +
    (as.map((a) => `<div class="card click" data-go="assignment/${a.id}"><div class="row between"><div class="grow"><div class="t">${esc(a.title)}</div><div class="sub">${esc(a.group_name)} · muddat: ${fdt(a.due_at)}</div></div>
      ${isStaff() ? `<div><span class="pill pri">${a.submitted}/${a.students}</span>${a.pending ? ` <span class="pill warn">${a.pending} tekshirilmagan</span>` : ''}</div>` : a.mine ? `<div>${pill(SS, a.mine.status)}${a.mine.late ? ' <span class="pill bad">Kechikib</span>' : ''}</div>` : late(a) ? '<span class="pill bad">Kechikkan</span>' : '<span class="pill warn">Topshirilmagan</span>'}</div></div>`).join('') || empty('Vazifalar yo‘q'));
  bindGo(v);
  if ($('#add', v)) $('#add', v).onclick = () => form('Yangi vazifa', [{ name: 'group_id', label: 'Guruh', type: 'select', options: groupOpts(gs), required: true }, { name: 'title', label: 'Topshiriq nomi', required: true }, { name: 'description', label: 'Ko‘rsatma', type: 'textarea' }, { name: 'due_at', label: 'Topshirish muddati', type: 'datetime-local', value: toLocalInput(Date.now() + 864e5 * 2), required: true }, { name: 'link', label: 'Havola (ixtiyoriy)', type: 'url' }, { name: 'file', label: 'Fayl (ixtiyoriy, 20 MB gacha)', type: 'file' }],
      async (d) => { const file = d.file; d.due_at = new Date(d.due_at).toISOString(); delete d.file; if (file && file.size) d.file_id = await upload(file, d.group_id); return api('/assignments', 'POST', d); });
};
PAGES.assignment = async (v, id) => {
  const a = await api('/assignments/' + id);
  let h = `${back('assignments')}<h2>${esc(a.title)}</h2><div class="sub">${esc(a.group_name)} · muddat: ${fdt(a.due_at)}${new Date(a.due_at) < new Date() ? ' <span class="pill bad">muddat o‘tgan</span>' : ''}</div>${a.description ? `<div class="card mt"><pre>${esc(a.description)}</pre></div>` : ''}<div class="btns">${a.file_id ? fileLink(a.file_id, a.file_name) : ''}${a.link ? `<a class="btn sec sm" href="${esc(a.link)}" target="_blank" rel="noopener">🔗 Havola</a>` : ''}${isStaff() ? '<button class="btn bad sm" id="del">O‘chirish</button>' : ''}</div>`;
  if (!isStaff()) {
    const s = a.mine;
    if (s) h += `<h3>Sizning javobingiz</h3><div class="card">${pill(SS, s.status)}${s.late ? ' <span class="pill bad">Kechikib</span>' : ''}<div class="sub">${fdt(s.submitted_at)}</div>${s.text ? `<pre>${esc(s.text)}</pre>` : ''}${s.file_id ? `<div class="btns">${fileLink(s.file_id, s.file_name)}</div>` : ''}${s.score !== null ? `<div class="t mt">Baho: ${s.score}/100</div>` : ''}${s.feedback ? `<div class="mt">💬 ${esc(s.feedback)}</div>` : ''}</div>`;
    if (!s || s.status !== 'tekshirildi') h += `<h3>${s ? 'Qayta yuborish' : 'Javob yuborish'}</h3><div class="card"><label>Matnli javob</label><textarea id="txt">${esc(s?.text || '')}</textarea><label>Fayl (ixtiyoriy)</label><input type="file" id="file"><div class="btns"><button class="btn" id="send">Yuborish</button></div></div>`;
  } else {
    h += `<h3>Javoblar (${a.submissions.length})</h3>` + (a.submissions.map((s) => `<div class="card"><div class="row between"><div class="t">${esc(s.student_name)}</div><div>${pill(SS, s.status)}${s.late ? ' <span class="pill bad">Kechikib</span>' : ''}</div></div><div class="sub">${fdt(s.submitted_at)}</div>${s.text ? `<pre>${esc(s.text)}</pre>` : ''}${s.file_id ? `<div class="btns">${fileLink(s.file_id, s.file_name)}</div>` : ''}${s.feedback ? `<div class="sub mt">💬 ${esc(s.feedback)}${s.score !== null ? ' · ' + s.score + '/100' : ''}</div>` : ''}<div class="btns"><button class="btn sm" data-rev="${s.id}">${s.status === 'kutilmoqda' ? 'Tekshirish' : 'Qayta baholash'}</button></div></div>`).join('') || empty('Hali javob yo‘q'));
    if (a.missing.length) h += `<h3>Topshirmaganlar (${a.missing.length})</h3><div class="card">${a.missing.map((m) => esc(m.name)).join(', ')}</div>`;
  }
  v.innerHTML = h;
  if ($('#del', v)) $('#del', v).onclick = () => confirmBox('Vazifani o‘chirasizmi?', async () => { await api('/assignments/' + id, 'DELETE'); go('assignments'); });
  if ($('#send', v)) $('#send', v).onclick = async (e) => {
    e.target.disabled = true;
    const ok = await act(async () => { const f = $('#file', v).files[0]; const r = await api('/assignments/' + id + '/submit', 'POST', { text: $('#txt', v).value, file_id: f ? await upload(f, a.group_id) : undefined }); if (r.late) toast('Javob kechikib yuborildi', true); }, 'Yuborildi ✅');
    e.target.disabled = false; if (ok) route();
  };
  $$('[data-rev]', v).forEach((b) => (b.onclick = () => { const s = a.submissions.find((x) => x.id == b.dataset.rev); form('Javobni tekshirish — ' + s.student_name, [{ name: 'status', label: 'Holat', type: 'select', value: s.status === 'kutilmoqda' ? 'tekshirildi' : s.status, options: [['tekshirildi', 'Tekshirildi'], ['qayta', 'Qayta ishlash kerak']] }, { name: 'score', label: 'Baho (0–100, ixtiyoriy)', type: 'number', min: 0, max: 100, value: s.score ?? '' }, { name: 'feedback', label: 'Fikr-mulohaza', type: 'textarea', value: s.feedback }], (d) => api('/submissions/' + s.id, 'PUT', d)); }));
};

// ---------- Materiallar ----------
PAGES.resources = async (v) => {
  const [rs, gs] = await Promise.all([api('/resources'), isStaff() ? api('/groups') : []]);
  const ICON = { pdf: '📄', audio: '🎧', video: '🎬', havola: '🔗', yozuv: '🎥' };
  v.innerHTML = `<h2>Materiallar</h2>${isStaff() ? '<button class="btn" id="add">+ Material qo‘shish</button><div class="mt"></div>' : ''}` +
    (rs.map((r) => { const isMedia = r.file_id && /\.(mp3|m4a|ogg|wav|mp4|webm|mov)$/i.test(r.file_name || '');
      return `<div class="card"><div class="row between"><div class="grow"><div class="t">${ICON[r.kind] || '📎'} ${esc(r.title)}</div><div class="sub">${esc(r.group_name)} · ${fdate(r.created_at)}</div></div>${isStaff() ? `<button class="btn sm sec" data-del="${r.id}">✕</button>` : ''}</div>
      ${isMedia ? (/\.(mp3|m4a|ogg|wav)$/i.test(r.file_name) ? `<audio controls preload="none" src="${fileUrl(r.file_id)}"></audio>` : `<video controls preload="none" playsinline src="${fileUrl(r.file_id)}"></video>`) : ''}
      <div class="btns">${r.file_id ? fileLink(r.file_id, r.file_name) : ''}${r.url ? `<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Ochish</a>` : ''}</div></div>`; }).join('') || empty('Materiallar yo‘q'));
  $$('[data-del]', v).forEach((b) => (b.onclick = () => confirmBox('Materialni o‘chirasizmi?', () => api('/resources/' + b.dataset.del, 'DELETE'))));
  if ($('#add', v)) $('#add', v).onclick = () => form('Yangi material', [{ name: 'group_id', label: 'Guruh', type: 'select', options: groupOpts(gs), required: true }, { name: 'title', label: 'Nomi', required: true }, { name: 'kind', label: 'Turi', type: 'select', options: [['pdf', 'PDF'], ['audio', 'Audio'], ['video', 'Video'], ['yozuv', 'Dars yozuvi'], ['havola', 'Tashqi havola']] }, { name: 'file', label: 'Fayl (20 MB gacha)', type: 'file' }, { name: 'url', label: 'yoki havola (https://…)', type: 'url' }],
    async (d) => { const f = d.file; delete d.file; if (f && f.size) d.file_id = await upload(f, d.group_id); return api('/resources', 'POST', d); });
};

// ---------- Guruhlar ----------
PAGES.groups = async (v) => {
  const gs = await api('/groups');
  v.innerHTML = `<h2>Guruhlar</h2>${me.role === 'admin' ? '<button class="btn" id="add">+ Guruh ochish</button><div class="mt"></div>' : ''}` + (gs.map((g) => `<div class="card click" data-go="group/${g.id}"><div class="row between"><div class="grow"><div class="t">${esc(g.name)}</div><div class="sub">Ustoz: ${esc(g.teacher_name || 'biriktirilmagan')} · ${g.members} o‘quvchi</div></div>${g.active ? '' : '<span class="pill bad">Faolsiz</span>'}</div></div>`).join('') || empty('Guruhlar yo‘q'));
  bindGo(v);
  if ($('#add', v)) { const ts = (await api('/users?role=teacher')).filter((t) => t.active); $('#add', v).onclick = () => form('Yangi guruh', [{ name: 'name', label: 'Guruh nomi', required: true }, { name: 'teacher_id', label: 'Ustoz', type: 'select', options: [['', '— tanlanmagan —'], ...ts.map((t) => [t.id, t.name])] }], (d) => api('/groups', 'POST', d)); }
};
PAGES.group = async (v, id) => {
  const g = await api('/groups/' + id);
  v.innerHTML = `${back('groups')}<h2>${esc(g.name)}</h2><div class="sub">Ustoz: ${esc(g.teacher_name || '—')}</div>
  <div class="btns"><button class="btn sm" data-go="schedule">Jadval</button><button class="btn sm sec" data-go="chat/g/${g.id}">Guruh chati</button>${me.role === 'admin' ? '<button class="btn sm sec" id="edit">Tahrirlash</button><button class="btn sm sec" id="addm">+ O‘quvchi</button>' : ''}</div>
  <h3>O‘quvchilar (${g.members.length})</h3>` + (g.members.map((m) => `<div class="card row between"><div class="grow"><div class="t">${esc(m.name)}</div>${m.username ? `<div class="sub">@${esc(m.username)}</div>` : ''}</div>${me.role === 'admin' ? `<button class="btn sm sec" data-rm="${m.id}">Chiqarish</button>` : `<button class="btn sm sec" data-go="chat/p/${m.id}">Yozish</button>`}</div>`).join('') || empty('O‘quvchi yo‘q'));
  bindGo(v);
  $$('[data-rm]', v).forEach((b) => (b.onclick = () => confirmBox('Guruhdan chiqarasizmi?', () => api(`/groups/${id}/members/${b.dataset.rm}`, 'DELETE'))));
  if (me.role === 'admin') {
    const ts = (await api('/users?role=teacher')).filter((t) => t.active);
    $('#edit', v).onclick = () => form('Guruhni tahrirlash', [{ name: 'name', label: 'Nomi', value: g.name }, { name: 'teacher_id', label: 'Ustoz', type: 'select', value: g.teacher_id || '', options: [['', '— tanlanmagan —'], ...ts.map((t) => [t.id, t.name])] }, { name: 'active', label: 'Holati', type: 'select', value: g.active, options: [[1, 'Faol'], [0, 'Faolsiz']] }], (d) => { d.active = +d.active; return api('/groups/' + id, 'PUT', d); });
    $('#addm', v).onclick = async () => { const have = new Set(g.members.map((m) => m.id)); const ss = (await api('/users?role=student')).filter((s) => s.active && !have.has(s.id)); if (!ss.length) return toast('Biriktiradigan o‘quvchi yo‘q', true); form('O‘quvchi biriktirish', [{ name: 'user_id', label: 'O‘quvchi', type: 'select', options: ss.map((s) => [s.id, s.name]) }], (d) => api(`/groups/${id}/members`, 'POST', d)); };
  }
};

// ---------- Foydalanuvchilar (admin) ----------
PAGES.users = async (v) => {
  const us = await api('/users');
  let filter = 'all';
  const draw = () => {
    v.innerHTML = `<h2>Foydalanuvchilar</h2><button class="btn" id="add">+ Foydalanuvchi qo‘shish</button><div class="seg mt">${[['all', 'Hammasi'], ['student', 'O‘quvchilar'], ['teacher', 'Ustozlar'], ['admin', 'Adminlar']].map((f) => `<button data-f="${f[0]}" class="${filter === f[0] ? 'on' : ''}">${f[1]}</button>`).join('')}</div>` +
      (us.filter((u) => filter === 'all' || u.role === filter).map((u) => `<div class="card click" data-u="${u.id}"><div class="row between"><div class="grow"><div class="t">${esc(u.name)}</div><div class="sub">${u.username ? '@' + esc(u.username) + ' · ' : ''}${u.tg_id ? 'ID ' + u.tg_id : 'hali kirmagan'}${u.groups ? ' · ' + esc(u.groups) : ''}</div></div><div><span class="pill pri">${ROLE[u.role]}</span>${u.active ? '' : ' <span class="pill bad">Faolsiz</span>'}</div></div></div>`).join('') || empty('Topilmadi'));
    $$('[data-f]', v).forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    $$('[data-u]', v).forEach((c) => (c.onclick = () => { const u = us.find((x) => x.id == c.dataset.u); form('Tahrirlash', [{ name: 'name', label: 'Ism', value: u.name }, { name: 'username', label: 'Telegram @username', value: u.username || '' }, { name: 'role', label: 'Rol', type: 'select', value: u.role, options: Object.entries(ROLE) }, { name: 'active', label: 'Holati', type: 'select', value: u.active, options: [[1, 'Faol'], [0, 'Faolsiz']] }], (d) => { d.active = +d.active; return api('/users/' + u.id, 'PUT', d); }); }));
    $('#add', v).onclick = () => form('Yangi foydalanuvchi', [{ name: 'name', label: 'To‘liq ism', required: true }, { name: 'role', label: 'Rol', type: 'select', options: [['student', 'O‘quvchi'], ['teacher', 'Ustoz'], ['admin', 'Admin']] }, { name: 'tg_id', label: 'Telegram ID (raqam)', type: 'number' }, { name: 'username', label: 'yoki Telegram @username' }], (d) => api('/users', 'POST', d));
  };
  draw();
};

// ---------- Chat ----------
PAGES.chat = async (v, kind, id) => {
  if (!kind) {
    const [gs, ps] = await Promise.all([api('/groups'), api('/chat/peers')]);
    v.innerHTML = `<h2>Chat</h2><h3>Guruh chatlari</h3>${gs.map((g) => `<div class="card click" data-go="chat/g/${g.id}"><div class="t">👥 ${esc(g.name)}</div></div>`).join('') || empty('Guruh yo‘q')}<h3>Shaxsiy xabarlar</h3>${ps.map((p) => `<div class="card click" data-go="chat/p/${p.id}"><div class="t">💬 ${esc(p.name)}</div><div class="sub">${ROLE[p.role]}</div></div>`).join('') || empty('Suhbatdosh yo‘q')}`;
    return bindGo(v);
  }
  const key = kind === 'g' ? 'group' : 'peer';
  v.innerHTML = `${back('chat')}<div class="chat" id="msgs"></div><form class="compose"><input id="m" placeholder="Xabar yozing…" autocomplete="off" maxlength="2000"><button class="btn">➤</button></form>`;
  let last = 0;
  const load = async () => {
    const ms = await api(`/chat?${key}=${id}&after=${last}`);
    if (!ms.length) return;
    const box = $('#msgs'); if (!box) return;
    const atEnd = window.innerHeight + scrollY >= document.body.scrollHeight - 80 || !last;
    for (const m of ms) { last = Math.max(last, m.id); box.insertAdjacentHTML('beforeend', `<div class="msg ${m.from_id === me.id ? 'me' : ''}">${m.from_id !== me.id && kind === 'g' ? `<small>${esc(m.from_name)}</small>` : ''}${esc(m.text)}<small>${ftime(m.created_at)}</small></div>`); }
    if (atEnd) scrollTo(0, document.body.scrollHeight);
  };
  await load();
  $('form', v).onsubmit = async (e) => { e.preventDefault(); const i = $('#m'), text = i.value.trim(); if (!text) return; i.value = ''; if (await act(() => api('/chat', 'POST', kind === 'g' ? { group_id: +id, text } : { to_id: +id, text }))) load(); else i.value = text; };
  pollTimer = setInterval(() => load().catch(() => {}), 4000);
};

// ---------- E'lonlar ----------
PAGES.announcements = async (v) => {
  const [as, gs] = await Promise.all([api('/announcements'), isStaff() ? api('/groups') : []]);
  v.innerHTML = `<h2>E’lonlar</h2>${isStaff() ? '<button class="btn" id="add">+ E’lon yuborish</button><div class="mt"></div>' : ''}` + (as.map((a) => `<div class="card"><div class="row between"><div class="grow"><div class="t">${esc(a.title)}</div><div class="sub">${esc(a.author)} · ${fdate(a.created_at)} · ${a.group_name ? esc(a.group_name) : 'Barchaga'}</div></div>${isStaff() && (me.role === 'admin' || a.author_id === me.id) ? `<button class="btn sm sec" data-del="${a.id}">✕</button>` : ''}</div>${a.body ? `<pre>${esc(a.body)}</pre>` : ''}</div>`).join('') || empty('E’lon yo‘q'));
  $$('[data-del]', v).forEach((b) => (b.onclick = () => confirmBox('E’lonni o‘chirasizmi?', () => api('/announcements/' + b.dataset.del, 'DELETE'))));
  if ($('#add', v)) $('#add', v).onclick = () => form('Yangi e’lon', [{ name: 'group_id', label: 'Kimga', type: 'select', options: [...(me.role === 'admin' ? [['', 'Barcha foydalanuvchilarga']] : []), ...groupOpts(gs)] }, { name: 'title', label: 'Sarlavha', required: true }, { name: 'body', label: 'Matn', type: 'textarea' }], (d) => api('/announcements', 'POST', d), 'Yuborish');
};

// ---------- Bildirishnomalar ----------
PAGES.notifications = async (v) => {
  const ns = await api('/notifications');
  v.innerHTML = `<h2>Bildirishnomalar</h2>` + (ns.map((n) => `<div class="card" ${n.read ? 'style="opacity:.65"' : ''}><div>${esc(n.text)}</div><div class="sub">${fdt(n.created_at)}</div></div>`).join('') || empty('Bildirishnoma yo‘q'));
  if (ns.some((n) => !n.read)) { await api('/notifications/read', 'POST'); $('#badge').hidden = true; }
};

// ---------- Yana (menyu) ----------
PAGES.more = async (v) => {
  const items = [['resources', '📚', 'Materiallar'], ['attendance', '✅', 'Davomat'], ['grades', '⭐', 'Baholar'], ['assignments', '📝', 'Vazifalar'], ['chat', '💬', 'Chat'], ['announcements', '📣', 'E’lonlar'], ['notifications', '🔔', 'Bildirishnomalar']];
  if (me.role === 'admin') items.push(['audit', '🛡️', 'Audit va zaxira']);
  v.innerHTML = `<h2>Yana</h2><div class="card"><div class="t">${esc(me.name)}</div><div class="sub">${ROLE[me.role]}${me.username ? ' · @' + esc(me.username) : ''}</div></div>` + items.map((i) => `<div class="card click" data-go="${i[0]}"><div class="t">${i[1]} ${i[2]}</div></div>`).join('') + (store.get('dev') ? '<div class="btns"><button class="btn sec" id="out">Chiqish (demo rol almashtirish)</button></div>' : '');
  bindGo(v);
  if ($('#out', v)) $('#out', v).onclick = () => { store.set('tok', ''); location.hash = ''; location.reload(); };
};
PAGES.audit = async (v) => {
  const [au, bk] = await Promise.all([api('/admin/audit'), api('/admin/backups')]);
  v.innerHTML = `${back('more')}<h2>Audit va zaxira</h2><button class="btn" id="bk">💾 Zaxira nusxa yaratish</button><div class="sub mt">Zaxira har 24 soatda avtomatik olinadi. Oxirgi nusxalar: ${bk.length ? esc(bk.slice(0, 3).join(', ')) : 'yo‘q'}</div><h3>Harakatlar tarixi</h3>` + (au.map((a) => `<div class="card"><div>${esc(a.action)}</div><div class="sub">${esc(a.user_name || '—')} · ${fdt(a.created_at)}</div></div>`).join('') || empty('Hali yozuv yo‘q'));
  $('#bk', v).onclick = async () => { if (await act(() => api('/admin/backup', 'POST'), 'Zaxira yaratildi ✅')) route(); };
};

$('#bell').onclick = () => go('notifications');

// ---------- Kirish ----------
async function boot() {
  const v = $('#view');
  try {
    if (token) { try { me = await api('/me'); } catch { token = null; } }
    if (!me) {
      const cfg = await api('/config');
      if (tg && tg.initData) { const r = await api('/auth', 'POST', { initData: tg.initData }); token = r.token; me = r.user; }
      else if (cfg.dev) {
        const us = await api('/dev/users');
        v.innerHTML = `<div class="login"><div class="big">قلم</div><h2>Qalam Arabic Academy</h2><p class="sub">DEV rejim: Telegram'siz sinash uchun rolni tanlang</p>${us.map((u) => `<div class="card click" data-id="${u.id}"><div class="t">${esc(u.name)}</div><div class="sub">${ROLE[u.role]}</div></div>`).join('')}</div>`;
        $('#tabs').innerHTML = '';
        $$('[data-id]', v).forEach((c) => (c.onclick = async () => { const r = await api('/dev/login', 'POST', { user_id: +c.dataset.id }); token = r.token; store.set('tok', token); store.set('dev', '1'); location.hash = ''; boot(); }));
        return;
      } else { v.innerHTML = '<div class="login"><div class="big">قلم</div><p>Ilovani Telegram bot orqali oching.</p></div>'; return; }
      store.set('tok', token);
    }
    route();
  } catch (e) { v.innerHTML = `<div class="login"><div class="big">قلم</div><h2>Kirish imkonsiz</h2><p>${esc(e.message)}</p></div>`; $('#tabs').innerHTML = ''; }
}
boot();
