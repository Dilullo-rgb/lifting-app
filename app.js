'use strict';
/* ---------- data ---------- */
const KEY = 'lifttrack.v1';
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
const defaultDB = () => ({
  v: 1,
  days: ['Legs', 'Chest & Back', 'Arms', 'Shoulders'].map(n => ({ id: uid(), name: n, exercises: [] })),
  history: {},
  settings: { sound: true, flash: true, awake: true, rest: 120 },
  lastDayId: null,
  active: null,
  updatedAt: 0,
  syncedAt: 0
});
function load() {
  try {
    const r = localStorage.getItem(KEY);
    if (r) {
      const d = JSON.parse(r), base = defaultDB();
      return Object.assign(base, d, { settings: Object.assign(base.settings, d.settings || {}) });
    }
  } catch (e) {}
  return defaultDB();
}
let db = load();
// Everything except the in-progress workout and sync bookkeeping is what gets synced.
function dataOnly() { const { active, updatedAt, syncedAt, ...rest } = db; return rest; }
let lastSnap = JSON.stringify(dataOnly()), applyingRemote = false;
function save() {
  try {
    const s = JSON.stringify(dataOnly());
    if (s !== lastSnap) {
      lastSnap = s;
      if (!applyingRemote) { db.updatedAt = Date.now(); schedulePush(); }
    }
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (e) {}
}

/* ---------- cloud sync (Firebase: email/password + Firestore, one doc per user) ---------- */
const FB_CONFIG = {
  apiKey: 'AIzaSyBKeI80V73qPPTlrPv2pxp2ppMOC5gH45s',
  authDomain: 'lifting-app-28c9b.firebaseapp.com',
  projectId: 'lifting-app-28c9b',
  storageBucket: 'lifting-app-28c9b.firebasestorage.app',
  messagingSenderId: '876239792508',
  appId: '1:876239792508:web:176c4544cd35b34bb99cf9'
};
const cloud = { user: null, status: '', busy: false, again: false };
let fauth = null, fdb = null, pushT = null;
function cloudInit() {
  if (!window.firebase) { cloud.status = 'Cloud sync unavailable (no connection to load it)'; return; }
  try {
    firebase.initializeApp(FB_CONFIG); fauth = firebase.auth(); fdb = firebase.firestore();
    fauth.onAuthStateChanged(u => { cloud.user = u; if (u) cloudSync(); else { cloud.status = ''; refreshCloudBox(); } });
  } catch (e) { cloud.status = 'Cloud error: ' + e.message; }
}
function schedulePush() {
  if (!cloud.user || !fdb) return;
  clearTimeout(pushT); pushT = setTimeout(cloudSync, 1500);
}
function applyRemote(d, t) {
  applyingRemote = true;
  const active = db.active, base = defaultDB();
  db = Object.assign(base, d, { active, updatedAt: t, settings: Object.assign(base.settings, d.settings || {}) });
  lastSnap = JSON.stringify(dataOnly()); save(); applyingRemote = false;
  if (backfillWarmups()) save();
  if (!db.active) render();
}
async function cloudSync() {
  if (!cloud.user || !fdb) return;
  if (cloud.busy) { cloud.again = true; return; }
  cloud.busy = true; cloud.status = 'Syncing…'; refreshCloudBox();
  try {
    const ref = fdb.collection('users').doc(cloud.user.uid), snap = await ref.get();
    // Data saved before sync existed has no timestamp; if it has real content, treat it as newer than an empty cloud copy.
    if (!db.updatedAt && (Object.keys(db.history).length || db.days.some(d => d.exercises.length))) db.updatedAt = 1;
    const mine = db.updatedAt || 0;
    if (snap.exists && snap.data().updatedAt > mine) applyRemote(JSON.parse(snap.data().data), snap.data().updatedAt);
    else if (!snap.exists || snap.data().updatedAt < mine) await ref.set({ data: JSON.stringify(dataOnly()), updatedAt: mine });
    db.syncedAt = Date.now(); save();
    cloud.status = 'Synced ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) { cloud.status = 'Sync failed (' + (e.code || e.message) + '). Will retry.'; }
  cloud.busy = false; refreshCloudBox();
  if (cloud.again) { cloud.again = false; schedulePush(); }
}
function cloudHtml() {
  if (!window.firebase) return `<div class="sub">${esc(cloud.status || 'Cloud sync not loaded.')}</div>`;
  if (cloud.user) return `<div class="card"><div>Signed in as <b>${esc(cloud.user.email)}</b></div>
    <div class="sub" style="margin-top:4px">${esc(cloud.status)}</div></div>
    <div class="row"><button class="btn" data-a="cloudNow">Sync now</button><button class="btn" data-a="cloudOut">Sign out</button></div>`;
  return `<div class="field"><label>Email</label><input type="email" id="cEmail" autocomplete="username" autocapitalize="off"></div>
    <div class="field"><label>Password (6+ characters)</label><input type="password" id="cPass" autocomplete="current-password"></div>
    <div class="row"><button class="btn pri" data-a="cloudIn">Sign in</button><button class="btn" data-a="cloudUp">Create account</button></div>
    <div class="sub" style="margin-top:8px">${esc(cloud.status)}</div>`;
}
function refreshCloudBox() {
  const el = document.getElementById('cloudBox'); if (el && !db.active) el.innerHTML = cloudHtml();
}
async function cloudAuth(create) {
  const e = document.getElementById('cEmail').value.trim(), p = document.getElementById('cPass').value;
  if (!e || !p) { toast('Enter email and password'); return; }
  cloud.status = create ? 'Creating account…' : 'Signing in…'; refreshCloudBox();
  try { await (create ? fauth.createUserWithEmailAndPassword(e, p) : fauth.signInWithEmailAndPassword(e, p)); }
  catch (err) { cloud.status = (err.code || err.message).replace('auth/', '').replace(/-/g, ' '); refreshCloudBox(); }
}

/* ---------- helpers ---------- */
const $app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const fw = v => String(Math.round(v * 100) / 100);
const findDay = id => db.days.find(d => d.id === id);
function findEx(id) {
  for (const d of db.days) { const e = d.exercises.find(x => x.id === id); if (e) return { day: d, ex: e }; }
  return null;
}
const hist = id => db.history[id] || [];
const lastEntry = id => { const h = hist(id); return h[h.length - 1] || null; };
// Weight to use next time: last working weight, +increment if last reps exceeded the threshold.
function target(ex) { const l = lastEntry(ex.id); if (!l) return 0; return l.reps > ex.thr ? l.w + ex.inc : l.w; }
const isToday = t => new Date(t).toDateString() === new Date().toDateString();
const doneToday = id => hist(id).some(e => isToday(e.t));
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
let toastT;
function toast(msg) {
  const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2000);
}

/* ---------- UI state ---------- */
let ui = { view: 'home', dayId: null, editDayId: null, editExId: null, progEx: null, mode: 'progress', showLast: false };

/* ---------- audio / flash / wake lock ---------- */
let actx = null;
function unlockAudio() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
}
function alertUser() {
  if (db.settings.sound && actx) {
    [0, 0.3, 0.6].forEach(t => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = 880; g.gain.value = 0.25; o.connect(g); g.connect(actx.destination);
      o.start(actx.currentTime + t); o.stop(actx.currentTime + t + 0.18);
    });
  }
  if (db.settings.flash) { document.body.classList.add('flash'); setTimeout(() => document.body.classList.remove('flash'), 3300); }
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
}
// iOS suspends a page's timers once it's in the background, unless it is playing audio.
// A silent looping clip during rest keeps the timer (and the alarm sound) alive. Best effort.
let keepEl = null;
function silentWav() {
  const n = 8000, b = new ArrayBuffer(44 + n), v = new DataView(b);
  const ws = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true); ws(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
function keepAlive(on) {
  try {
    if (on) {
      if (!keepEl) { keepEl = new Audio(silentWav()); keepEl.loop = true; keepEl.setAttribute('playsinline', ''); }
      keepEl.play().catch(() => {});
    } else if (keepEl) keepEl.pause();
  } catch (e) {}
}
let wl = null;
async function wake() {
  if (!db.settings.awake || !('wakeLock' in navigator) || wl) return;
  try { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } catch (e) {}
}
function unwake() { try { wl && wl.release(); } catch (e) {} wl = null; }

/* ---------- workout flow ---------- */
function startEx(id) {
  const f = findEx(id); if (!f) return;
  const ex = f.ex, w = [];
  for (let i = 0; i < ex.wc; i++) w.push(ex.ww && ex.ww[i] != null ? ex.ww[i] : (i ? w[i - 1] : 0));
  w.push(target(ex));
  db.active = { dayId: f.day.id, exId: id, step: 0, weights: w, phase: 'set', timerEnd: null, restTotal: 0, reps: '', result: null };
  ui.showLast = false; save(); unlockAudio(); wake(); render();
}
function completeWarm() {
  const a = db.active, ex = findEx(a.exId).ex; unlockAudio(); keepAlive(true);
  // Remember "too light" flags so next session shows a hint on that warm-up set.
  ex.lt = Object.assign({}, ex.lt); if (a.lt && a.lt[a.step]) ex.lt[a.step] = true; else delete ex.lt[a.step];
  a.phase = 'rest'; a.restTotal = db.settings.rest; a.timerEnd = Date.now() + a.restTotal * 1000;
  save(); render();
}
function finishRest(withAlert) {
  const a = db.active; if (!a || a.phase !== 'rest') return;
  a.step++; a.phase = 'set'; a.timerEnd = null; a.paused = false; keepAlive(false);
  if (a.step < a.weights.length - 1 && !a.weights[a.step]) a.weights[a.step] = a.weights[a.step - 1]; // carry forward
  save();
  if (withAlert) alertUser();
  render();
}
function buildResult(ex, prev, e) {
  const nextW = e.reps > ex.thr ? e.w + ex.inc : e.w;
  const nextLine = e.reps > ex.thr ? `Next time: ${fw(nextW)} lb (over ${ex.thr} reps)` : `Next time: ${fw(nextW)} lb, beat ${e.reps} reps`;
  if (!prev) return { cls: 'up', title: 'First session logged!', sub: `${fw(e.w)} lb × ${e.reps}`, next: nextLine };
  if (e.w > prev.w) return { cls: 'up', title: `Weight up +${fw(e.w - prev.w)} lb!`, sub: `${fw(e.w)} lb × ${e.reps}  (last: ${fw(prev.w)} × ${prev.reps})`, next: nextLine };
  if (e.w < prev.w) return { cls: 'down', title: `Weight down ${fw(prev.w - e.w)} lb`, sub: `${fw(e.w)} lb × ${e.reps}  (last: ${fw(prev.w)} × ${prev.reps})`, next: nextLine };
  const d = e.reps - prev.reps;
  if (d > 0) return { cls: 'up', title: `Congrats, +${d} rep${d > 1 ? 's' : ''}!`, sub: `${fw(e.w)} lb × ${e.reps}  (last: ${prev.reps})`, next: nextLine };
  if (d < 0) return { cls: 'down', title: `${d} rep${d < -1 ? 's' : ''}`, sub: `${fw(e.w)} lb × ${e.reps}  (last: ${prev.reps})`, next: nextLine };
  return { cls: '', title: 'Matched last time', sub: `${fw(e.w)} lb × ${e.reps}`, next: nextLine };
}
function saveSet() {
  const a = db.active, f = findEx(a.exId), ex = f.ex;
  const reps = Math.round(num(a.reps));
  if (reps <= 0) { toast('Enter your reps first'); return; }
  const w = a.weights[ex.wc], prev = lastEntry(ex.id);
  const entry = { t: Date.now(), w, reps, wu: a.weights.slice(0, ex.wc).map(x => ({ w: x, reps: ex.wreps })) };
  (db.history[ex.id] = hist(ex.id)).push(entry);
  ex.ww = a.weights.slice(0, ex.wc);
  db.lastDayId = f.day.id;
  a.phase = 'result'; a.result = buildResult(ex, prev, entry);
  save(); render();
}
function leaveWorkout(goDay) {
  const a = db.active; db.active = null; save(); unwake(); keepAlive(false);
  if (a && goDay) { ui.view = 'day'; ui.dayId = a.dayId; }
  render();
}

/* ---------- views ---------- */
const hdr = (title, back, right = '') =>
  `<div class="hdr">${back ? `<button class="ib" data-a="${back}">‹</button>` : '<div style="width:44px"></div>'}
   <div class="t">${esc(title)}</div>${right || '<div style="width:44px"></div>'}</div>`;

function viewHome() {
  const idx = db.lastDayId ? db.days.findIndex(d => d.id === db.lastDayId) : -1;
  const nextIdx = db.days.length ? (idx + 1) % db.days.length : -1;
  return `${hdr('Lift', null, '<button class="ib" data-a="settings">⚙︎</button>')}
  <div class="sub" style="margin:0 2px 14px">Pick today's workout</div>
  <div class="grid">${db.days.map((d, i) => `
    <button class="day ${i === nextIdx ? 'next' : ''}" data-a="openDay" data-id="${d.id}">
      ${i === nextIdx ? '<span class="badge">NEXT</span>' : ''}
      <span class="n">DAY ${i + 1}</span><span class="nm">${esc(d.name)}</span>
      <span class="ct">${d.exercises.length} exercise${d.exercises.length === 1 ? '' : 's'}</span>
    </button>`).join('')}</div>
  <div class="row" style="margin-top:16px">
    <button class="btn" data-a="progress">📈 Progress</button>
    <button class="btn" data-a="edit">✏️ Edit workouts</button>
  </div>`;
}
function viewDay() {
  const d = findDay(ui.dayId); if (!d) { ui.view = 'home'; return viewHome(); }
  return `${hdr(d.name, 'home')}
  ${d.exercises.length ? d.exercises.map(e => `
    <button class="pill ${doneToday(e.id) ? 'done' : ''}" data-a="startEx" data-id="${e.id}">
      <span>${esc(e.name)}</span><span class="chk">${doneToday(e.id) ? '✓' : ''}</span></button>`).join('')
    : `<div class="empty">No exercises yet.<br>Add some under <b>Edit workouts</b>.</div>`}
  `;
}
function dotsHtml(a, ex) {
  let s = '';
  for (let i = 0; i <= ex.wc; i++) s += `<i class="${i < a.step ? 'on' : i === a.step ? 'cur' : ''}"></i>`;
  return `<div class="dots">${s}</div>`;
}
function viewWorkout() {
  const a = db.active, f = findEx(a.exId);
  if (!f) { db.active = null; save(); return viewHome(); }
  const ex = f.ex, n = ex.wc, working = a.step === n;
  const head = `<div class="hdr"><button class="ib" data-a="abandon">✕</button><div class="t">${esc(ex.name)}</div><div style="width:44px"></div></div>`;

  if (a.phase === 'result') {
    const r = a.result;
    return `${head}<div class="stage">
      <div class="kind">DONE</div>
      <div class="res ${r.cls}">${esc(r.title)}</div>
      <div class="res-sub">${esc(r.sub)}</div>
      <div class="next-line">${esc(r.next)}</div></div>
      <div class="row"><button class="btn big" style="flex:0 0 auto" data-a="undoSet">Undo</button>
        <button class="btn pri big" data-a="doneResult">Done</button></div>`;
  }
  if (a.phase === 'rest') {
    const nextWorking = a.step + 1 === n;
    const nextLabel = nextWorking ? 'Working set' : (a.step + 1 === 0 ? 'Light' : 'Medium');
    const left = Math.max(0, Math.ceil((a.paused ? a.pausedLeft : a.timerEnd - Date.now()) / 1000));
    const C = 2 * Math.PI * 120;
    return `${head}${dotsHtml(a, ex)}<div class="stage">
      <div class="kind">REST</div>
      <div class="timer"><svg viewBox="0 0 260 260"><circle cx="130" cy="130" r="120" fill="none" stroke="var(--line)" stroke-width="10"/>
        <circle id="ring" cx="130" cy="130" r="120" fill="none" stroke="var(--acc)" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - left / a.restTotal)}"/></svg>
        <div class="tt" id="tt">${fmtTime(left)}</div></div>
      <div class="exname">Next: ${nextLabel} · ${fw(a.weights[a.step + 1])} lb${nextWorking ? '' : ' × ' + ex.wreps}</div></div>
      <div class="row"><button class="btn" data-a="addTime">+30s</button>
        <button class="btn" data-a="pause">${a.paused ? '▶ Resume' : '❚❚ Pause'}</button>
        <button class="btn pri" data-a="skipRest">Skip</button></div>`;
  }
  // phase: set
  const w = a.weights[a.step];
  const label = working ? 'WORKING SET' : (a.step === 0 ? 'LIGHT' : 'MEDIUM');
  const prev = lastEntry(ex.id);
  return `${head}${dotsHtml(a, ex)}<div class="stage">
    <div class="kind ${working ? 'work' : ''}">${label}</div>
    <div class="exname">Set ${a.step + 1} of ${n + 1}${working ? '' : ' · ' + ex.wreps + ' reps'}</div>
    <div class="wbox"><button class="ib" data-a="wMinus">−</button>
      <input id="wIn" type="number" inputmode="decimal" value="${w ? fw(w) : ''}" placeholder="0">
      <button class="ib" data-a="wPlus">+</button></div>
    <div class="unit">lb</div>
    ${working ? '' : `${ex.lt && ex.lt[a.step] ? '<div class="hint-up">Last time you marked this too light. Consider increasing weight.</div>' : ''}
      <button class="btn light ${a.lt && a.lt[a.step] ? 'on' : ''}" data-a="tooLight">${a.lt && a.lt[a.step] ? '✓ Marked too light' : '⬆ Too light — go heavier next time'}</button>`}
    ${working ? `
      <div class="lbl">REPS TO FAILURE</div>
      <div class="wbox"><button class="ib" data-a="rMinus">−</button>
        <input id="rIn" class="r" type="number" inputmode="numeric" value="${a.reps}" placeholder="0">
        <button class="ib" data-a="rPlus">+</button></div>
      <div class="last">${ui.showLast
        ? (prev ? `Last time: ${fw(prev.w)} lb × ${prev.reps}` : 'No previous session')
        : '<button class="link" data-a="showLast">Show last time</button>'}</div>` : ''}
    </div>
    ${working
      ? '<button class="btn pri big" data-a="saveSet">Save set</button>'
      : '<button class="btn pri big" data-a="completeWarm">Complete</button>'}`;
}
const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/* progress */
// Total weight lifted in a session: every warm-up set plus the working set, reps × weight.
// Sessions logged before warm-ups were recorded only have the working set.
// Old sessions never recorded their warm-ups; fill them in from the exercise's current warm-up weights and reps.
function backfillWarmups() {
  let changed = false;
  for (const d of db.days) for (const ex of d.exercises) {
    if (!ex.ww || !ex.ww.length) continue;
    for (const e of hist(ex.id)) {
      if (!e.wu) { e.wu = ex.ww.slice(0, ex.wc).map(w => ({ w, reps: ex.wreps })); changed = true; }
    }
  }
  return changed;
}
const entryVol = e => (e.wu || []).reduce((s, x) => s + x.w * x.reps, 0) + e.w * e.reps;
const fmtN = n => Math.round(n).toLocaleString();
function computeProg(entries) {
  let cum = 0;
  return entries.map((e, i) => {
    let up = false;
    if (i > 0) {
      const p = entries[i - 1];
      if (e.w > p.w) { cum += 1; up = true; }       // a weight increase counts as +1 rep
      else if (e.w < p.w) cum -= 1;
      else cum += e.reps - p.reps;
    }
    return { cum, up, e };
  });
}
function chartSvg(entries, mode) {
  if (!entries.length) return '<div class="empty">No sessions logged yet for this exercise.</div>';
  const pts = computeProg(entries);
  const vals = mode === 'weight' ? entries.map(e => e.w) : mode === 'volume' ? entries.map(entryVol) : pts.map(p => p.cum);
  const W = 340, H = 220, L = mode === 'volume' ? 52 : 38, R = 14, T = 16, B = 28;
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.12; min -= pad; max += pad;
  const n = entries.length;
  const X = i => L + (n === 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const Y = v => T + (H - T - B) * (1 - (v - min) / (max - min));
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = min + (max - min) * k / 4, y = Y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
          <text x="${L - 6}" y="${y + 4}" text-anchor="end" fill="var(--mute)" font-size="11">${mode === 'volume' ? fmtN(v) : fw(Math.round(v * 10) / 10)}</text>`;
  }
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i)},${Y(v)}`).join(' ');
  let dots = '';
  pts.forEach((p, i) => {
    const x = X(i), y = Y(vals[i]);
    dots += p.up
      ? `<circle cx="${x}" cy="${y}" r="7" fill="var(--warn)"/><text x="${x}" y="${y + 4}" text-anchor="middle" font-size="10" fill="#1a1100" font-weight="800">▲</text>`
      : `<circle cx="${x}" cy="${y}" r="4" fill="var(--acc)"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}">${g}
    <path d="${line}" fill="none" stroke="var(--acc)" stroke-width="2.5" stroke-linejoin="round"/>${dots}
    <text x="${L}" y="${H - 8}" fill="var(--mute)" font-size="11">${shortDate(entries[0].t)}</text>
    <text x="${W - R}" y="${H - 8}" text-anchor="end" fill="var(--mute)" font-size="11">${shortDate(entries[n - 1].t)}</text></svg>`;
}
function viewProgress() {
  const all = allEx();
  if (!all.length) return `${hdr('Progress', 'home')}<div class="empty">Add exercises first.</div>`;
  if (!ui.progEx || !findEx(ui.progEx)) ui.progEx = (all.find(x => hist(x.ex.id).length) || all[0]).ex.id;
  const entries = hist(ui.progEx);
  const best = entries.length ? Math.max(...entries.map(e => e.w)) : 0;
  const pts = computeProg(entries);
  const gain = pts.length ? pts[pts.length - 1].cum : 0;
  return `${hdr('Progress', 'home')}
  <select id="progSel">${db.days.map(d => d.exercises.length ? `<optgroup label="${esc(d.name)}">${d.exercises.map(e =>
    `<option value="${e.id}" ${e.id === ui.progEx ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</optgroup>` : '').join('')}</select>
  <div class="seg"><button data-a="mode" data-id="progress" class="${ui.mode === 'progress' ? 'on' : ''}">Reps</button>
    <button data-a="mode" data-id="weight" class="${ui.mode === 'weight' ? 'on' : ''}">Weight</button>
    <button data-a="mode" data-id="volume" class="${ui.mode === 'volume' ? 'on' : ''}">Total lifted</button></div>
  <div class="chart">${chartSvg(entries, ui.mode)}</div>
  <div class="sub" style="margin:8px 2px">${ui.mode === 'progress'
    ? '▲ = weight increase (counts as +1 rep). Line shows cumulative reps gained.'
    : ui.mode === 'volume' ? '▲ = weight increase. Total = every set\'s reps × weight, added up (warm-ups included once recorded).'
    : '▲ = weight increase.'}</div>
  <div class="stats"><div class="stat"><b>${entries.length}</b><span>sessions</span></div>
    <div class="stat"><b>${best ? fw(best) : '–'}</b><span>best lb</span></div>
    ${ui.mode === 'volume'
      ? `<div class="stat"><b>${entries.length ? fmtN(Math.max(...entries.map(entryVol))) : '–'}</b><span>best total lb</span></div>`
      : `<div class="stat"><b>${gain > 0 ? '+' : ''}${gain}</b><span>progress</span></div>`}</div>
  <h2>History</h2>
  ${entries.length ? entries.map((e, i) => ({ e, i, p: pts[i] })).reverse().map(({ e, i, p }) => `
    <div class="hrow"><span class="d">${shortDate(e.t)}</span><span class="v">${fw(e.w)} lb × ${e.reps}<br><span class="sub" style="font-size:13px">${fmtN(entryVol(e))} lb total</span></span>
      ${p.up ? '<span class="tag">▲ WEIGHT UP</span>' : ''}
      <button class="ib ghost" style="width:34px;height:34px;font-size:15px" data-a="delH" data-id="${i}">✕</button></div>`).join('') : '<div class="sub">Nothing yet.</div>'}`;
}
const allEx = () => db.days.flatMap(d => d.exercises.map(e => ({ day: d, ex: e })));

/* editing */
function viewEdit() {
  return `${hdr('Edit workouts', 'home')}
  ${db.days.map((d, i) => `<div class="li"><div class="nm">Day ${i + 1}: ${esc(d.name)}</div>
    <button class="ib" data-a="editDay" data-id="${d.id}">✎</button></div>`).join('')}
  <button class="btn" style="width:100%;margin-top:6px" data-a="addDay">+ Add a day</button>`;
}
function viewEditDay() {
  const d = findDay(ui.editDayId); if (!d) { ui.view = 'edit'; return viewEdit(); }
  return `${hdr('Edit day', 'edit')}
  <div class="field"><label>Day name</label><input type="text" id="dayName" value="${esc(d.name)}"></div>
  <h2>Exercises</h2>
  ${d.exercises.map((e, i) => `<div class="li"><div class="nm">${esc(e.name)}</div>
    <button class="ib" data-a="moveEx" data-id="${e.id}" data-dir="-1" ${i === 0 ? 'disabled style="opacity:.3"' : ''}>↑</button>
    <button class="ib" data-a="moveEx" data-id="${e.id}" data-dir="1" ${i === d.exercises.length - 1 ? 'disabled style="opacity:.3"' : ''}>↓</button>
    <button class="ib" data-a="editEx" data-id="${e.id}">✎</button></div>`).join('')}
  <button class="btn pri" style="width:100%;margin:6px 0 20px" data-a="newEx">+ Add exercise</button>
  <button class="btn danger" style="width:100%" data-a="delDay">Delete this day</button>`;
}
function viewExForm() {
  const f = ui.editExId && ui.editExId !== 'new' ? findEx(ui.editExId) : null;
  const ex = f ? f.ex : { name: '', inc: 5, thr: 12, wc: 3, wreps: 10 };
  return `${hdr(f ? 'Edit exercise' : 'New exercise', 'editDay')}
  <div class="field"><label>Name</label><input type="text" id="fName" value="${esc(ex.name)}" placeholder="e.g. Leg extension"></div>
  <div class="field"><label>Weight increment (lb)</label><input type="number" inputmode="decimal" id="fInc" value="${ex.inc}">
    <span class="hint">How much to add when you earn a weight increase.</span></div>
  <div class="field"><label>Increase weight when reps exceed</label><input type="number" inputmode="numeric" id="fThr" value="${ex.thr}">
    <span class="hint">If your working-set reps are above this, next session goes up by the increment.</span></div>
  <div class="field"><label>Warm-up sets</label><input type="number" inputmode="numeric" id="fWc" value="${ex.wc}">
    <span class="hint">Before the working set. Default 3 (light, medium, medium).</span></div>
  <div class="field"><label>Reps per warm-up set</label><input type="number" inputmode="numeric" id="fWr" value="${ex.wreps}"></div>
  <button class="btn pri" style="width:100%;margin-bottom:12px" data-a="saveEx">Save</button>
  ${f ? '<button class="btn danger" style="width:100%" data-a="delEx">Delete exercise</button>' : ''}`;
}
function viewSettings() {
  const s = db.settings;
  return `${hdr('Settings', 'home')}
  <div class="sw"><span>Sound when rest ends</span><input type="checkbox" data-s="sound" ${s.sound ? 'checked' : ''}></div>
  <div class="sw"><span>Flash when rest ends</span><input type="checkbox" data-s="flash" ${s.flash ? 'checked' : ''}></div>
  <div class="sw"><span>Keep screen on during workout</span><input type="checkbox" data-s="awake" ${s.awake ? 'checked' : ''}></div>
  <div class="field" style="margin-top:6px"><label>Rest timer (seconds)</label><input type="number" inputmode="numeric" id="sRest" value="${s.rest}"></div>
  <h2>Cloud sync</h2>
  <div id="cloudBox">${cloudHtml()}</div>
  <h2>Backup</h2>
  <button class="btn" style="width:100%;margin-bottom:10px" data-a="backup">Copy backup to clipboard</button>
  <div class="field"><label>Restore (paste backup text)</label><textarea id="restoreTxt" rows="3"></textarea></div>
  <button class="btn" style="width:100%" data-a="restore">Restore from pasted backup</button>`;
}

/* ---------- render ---------- */
function render() {
  let h;
  if (db.active) h = viewWorkout();
  else switch (ui.view) {
    case 'day': h = viewDay(); break;
    case 'progress': h = viewProgress(); break;
    case 'edit': h = viewEdit(); break;
    case 'editDay': h = viewEditDay(); break;
    case 'exForm': h = viewExForm(); break;
    case 'settings': h = viewSettings(); break;
    default: h = viewHome();
  }
  $app.innerHTML = h;
  window.scrollTo(0, 0);
}
const go = v => { ui.view = v; render(); };

/* ---------- events ---------- */
const actions = {
  home: () => go('home'), settings: () => go('settings'), progress: () => go('progress'), edit: () => go('edit'),
  openDay: id => { ui.dayId = id; go('day'); },
  startEx,
  abandon: () => { if (confirm('Leave this exercise? Nothing is saved for it.')) leaveWorkout(true); },
  wMinus: () => stepVal('w', -1), wPlus: () => stepVal('w', 1),
  rMinus: () => stepVal('r', -1), rPlus: () => stepVal('r', 1),
  showLast: () => { ui.showLast = true; render(); },
  completeWarm, saveSet,
  tooLight: () => { const a = db.active; a.lt = Object.assign({}, a.lt); a.lt[a.step] = !a.lt[a.step]; save(); render(); },
  skipRest: () => finishRest(false),
  addTime: () => {
    const a = db.active;
    if (a.paused) a.pausedLeft += 30000; else a.timerEnd += 30000;
    a.restTotal += 30; save(); render();
  },
  pause: () => {
    const a = db.active;
    if (a.paused) { a.timerEnd = Date.now() + a.pausedLeft; a.paused = false; }
    else { a.pausedLeft = Math.max(0, a.timerEnd - Date.now()); a.paused = true; }
    save(); render();
  },
  undoSet: () => {
    const a = db.active, ex = findEx(a.exId).ex;
    hist(ex.id).pop(); a.phase = 'set'; a.result = null; save(); toast('Set removed'); render();
  },
  doneResult: () => leaveWorkout(true),
  mode: id => { ui.mode = id; render(); },
  delH: i => { const h = hist(ui.progEx); if (confirm('Delete this entry?')) { h.splice(+i, 1); save(); render(); } },
  editDay: id => { ui.editDayId = id; go('editDay'); },
  addDay: () => { const d = { id: uid(), name: 'New day', exercises: [] }; db.days.push(d); save(); ui.editDayId = d.id; go('editDay'); },
  delDay: () => {
    const d = findDay(ui.editDayId);
    if (d && confirm(`Delete "${d.name}" and its exercises? History is kept.`)) {
      db.days = db.days.filter(x => x.id !== d.id); if (db.lastDayId === d.id) db.lastDayId = null; save(); go('edit');
    }
  },
  newEx: () => { saveDayName(); ui.editExId = 'new'; go('exForm'); },
  editEx: id => { saveDayName(); ui.editExId = id; go('exForm'); },
  moveEx: (id, el) => {
    saveDayName();
    const d = findDay(ui.editDayId), i = d.exercises.findIndex(e => e.id === id), j = i + +el.dataset.dir;
    if (j < 0 || j >= d.exercises.length) return;
    [d.exercises[i], d.exercises[j]] = [d.exercises[j], d.exercises[i]]; save(); render();
  },
  editDayBack: () => go('editDay'),
  saveEx: () => {
    const name = document.getElementById('fName').value.trim();
    if (!name) { toast('Give it a name'); return; }
    const v = {
      name, inc: Math.max(0.5, num(document.getElementById('fInc').value) || 5),
      thr: Math.max(1, Math.round(num(document.getElementById('fThr').value)) || 12),
      wc: Math.max(0, Math.min(8, Math.round(num(document.getElementById('fWc').value)))),
      wreps: Math.max(1, Math.round(num(document.getElementById('fWr').value)) || 10)
    };
    if (ui.editExId === 'new') findDay(ui.editDayId).exercises.push(Object.assign({ id: uid(), ww: [] }, v));
    else Object.assign(findEx(ui.editExId).ex, v);
    save(); go('editDay');
  },
  delEx: () => {
    const f = findEx(ui.editExId);
    if (f && confirm(`Delete "${f.ex.name}"? Its history will be removed too.`)) {
      f.day.exercises = f.day.exercises.filter(e => e.id !== f.ex.id); delete db.history[f.ex.id]; save(); go('editDay');
    }
  },
  cloudIn: () => cloudAuth(false), cloudUp: () => cloudAuth(true),
  cloudNow: () => cloudSync(),
  cloudOut: () => { if (confirm('Sign out? Data stays on this phone but stops syncing.')) fauth.signOut(); },
  backup: async () => {
    const txt = JSON.stringify(db);
    try { await navigator.clipboard.writeText(txt); toast('Backup copied'); } catch (e) { prompt('Copy this backup:', txt); }
  },
  restore: () => {
    const t = document.getElementById('restoreTxt').value.trim();
    try {
      const d = JSON.parse(t);
      if (!d.days || !d.history) throw 0;
      if (!confirm('Replace everything with this backup?')) return;
      db = Object.assign(defaultDB(), d, { active: null }); save(); toast('Restored'); go('home');
    } catch (e) { toast('That does not look like a backup'); }
  }
};
function stepVal(kind, dir) {
  const a = db.active, ex = findEx(a.exId).ex;
  if (kind === 'w') a.weights[a.step] = Math.max(0, Math.round((num(a.weights[a.step]) + dir * ex.inc) * 100) / 100);
  else a.reps = String(Math.max(0, Math.round(num(a.reps)) + dir));
  save(); render();
}
function saveDayName() {
  const el = document.getElementById('dayName');
  if (el && el.value.trim()) { const d = findDay(ui.editDayId); if (d) { d.name = el.value.trim(); save(); } }
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.disabled) return;
  const a = el.dataset.a;
  if (a === 'edit' && ui.view === 'editDay') saveDayName();
  const fn = actions[a]; if (fn) fn(el.dataset.id, el);
});
// header "back" buttons use data-a=<viewname>; map exForm/editDay back targets
actions.editDay = (id) => { if (id) ui.editDayId = id; saveDayName(); go('editDay'); };
document.addEventListener('input', e => {
  const t = e.target, a = db.active;
  if (t.id === 'wIn' && a) { a.weights[a.step] = num(t.value); save(); }
  if (t.id === 'rIn' && a) { a.reps = t.value; save(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'progSel') { ui.progEx = t.value; render(); }
  if (t.dataset && t.dataset.s) { db.settings[t.dataset.s] = t.checked; save(); if (t.dataset.s === 'awake' && !t.checked) unwake(); }
  if (t.id === 'sRest') { db.settings.rest = Math.max(10, Math.round(num(t.value)) || 120); save(); }
  if (t.id === 'dayName') saveDayName();
});

/* ---------- timer tick ---------- */
setInterval(() => {
  const a = db.active; if (!a || a.phase !== 'rest' || a.paused) return;
  const left = Math.ceil((a.timerEnd - Date.now()) / 1000);
  if (left <= 0) { finishRest(true); return; }
  const tt = document.getElementById('tt'), ring = document.getElementById('ring');
  if (tt) tt.textContent = fmtTime(left);
  if (ring) { const C = 2 * Math.PI * 120; ring.setAttribute('stroke-dashoffset', C * (1 - left / a.restTotal)); }
}, 250);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  cloudSync();
  if (db.active) { wake(); const a = db.active; if (a.phase === 'rest' && !a.paused && a.timerEnd <= Date.now()) finishRest(true); else render(); }
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (backfillWarmups()) save();
window.addEventListener('online', () => cloudSync());
cloudInit();
render();
