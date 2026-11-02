import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, FOCUS_START, FOCUS_END } from './config.js';

const VERSION = '0.1.0';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $toast = document.getElementById('toast');

const NOTIFY_TYPES = [
  ['report_ready', 'Morning report ready (8:00)'],
  ['focus_start', 'Focus block starts (9:00)'],
  ['noon_checkin', 'Noon check-in (12:00)'],
  ['timer_forgotten', 'Timer still running after the block'],
  ['task_events', 'Task started, done or swapped'],
  ['night_log', 'Night log reminder'],
  ['weekly_report', 'Weekly report ready (Sunday)'],
];
const DEFAULT_PREFS = Object.fromEntries(NOTIFY_TYPES.map(([k]) => [k, true]));

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
const atTime = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d; };
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`; };
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const isStandalone = () => window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
let toastTimer;
function toast(msg) { $toast.textContent = msg; $toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => ($toast.hidden = true), 2600); }

// ---------- setup checks ----------
if (SUPABASE_URL.startsWith('PASTE') || SUPABASE_ANON_KEY.startsWith('PASTE')) {
  $app.innerHTML = `<div class="pad center"><h1>Not connected yet</h1><p class="muted">Add your Supabase Project URL and anon key to <code>config.js</code>.</p></div>`;
  throw new Error('config missing');
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);

let user = null;
let tab = 'today';
let tick = null;

async function logEvent(kind, payload = {}) {
  if (!user) return;
  await sb.from('events').insert({ user_id: user.id, source: 'app', kind, payload });
}

// ---------- auth ----------
function renderAuth(mode = 'signin', msg = '') {
  $tabs.hidden = true;
  $app.innerHTML = `
    <h1>Coach</h1>
    <p class="muted">Three touches a day. No excuses.</p>
    ${isIOS() && !isStandalone() ? installCard() : ''}
    <form id="auth" class="card stack">
      <div><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
      <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" minlength="8" required></div>
      <button class="primary block" type="submit">${mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      <p class="small muted center" style="margin:0">${mode === 'signin'
        ? 'First time? <a href="#" id="switch">Create your account</a>'
        : 'Already have one? <a href="#" id="switch">Sign in</a>'}</p>
      ${msg ? `<p class="small center">${esc(msg)}</p>` : ''}
    </form>`;
  document.getElementById('switch').onclick = (e) => { e.preventDefault(); renderAuth(mode === 'signin' ? 'signup' : 'signin'); };
  document.getElementById('auth').onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('pw').value;
    const btn = e.submitter; btn.disabled = true;
    const { data, error } = mode === 'signin'
      ? await sb.auth.signInWithPassword({ email, password })
      : await sb.auth.signUp({ email, password });
    btn.disabled = false;
    if (error) return renderAuth(mode, error.message);
    if (mode === 'signup' && !data.session) return renderAuth('signin', 'Check your email and tap the confirmation link, then come back here and sign in.');
  };
}

function installCard() {
  return `<div class="card"><strong>Install it first</strong>
    <p class="small muted" style="margin:6px 0 0">In Safari, tap the Share button, then <b>Add to Home Screen</b>. Open Coach from the new icon. Notifications only work from the installed app.</p></div>`;
}

// ---------- today ----------
async function loadToday() {
  const d = today();
  const [tasks, sessions, checkins] = await Promise.all([
    sb.from('tasks').select('*').eq('day', d).order('sort').order('created_at'),
    sb.from('focus_sessions').select('*').eq('day', d).order('started_at'),
    sb.from('checkins').select('*').eq('day', d),
  ]);
  return { tasks: tasks.data || [], sessions: sessions.data || [], checkins: checkins.data || [] };
}

async function renderToday() {
  const { tasks, sessions, checkins } = await loadToday();
  const live = sessions.find((s) => !s.ended_at);
  const doneMs = sessions.filter((s) => s.ended_at).reduce((a, s) => a + (new Date(s.ended_at) - new Date(s.started_at)), 0);
  const now = new Date();
  const start = atTime(FOCUS_START), end = atTime(FOCUS_END);
  const weekend = [0, 6].includes(now.getDay());
  const has = (k) => checkins.some((c) => c.kind === k);
  const active = tasks.filter((t) => t.status !== 'swapped');
  const done = active.filter((t) => t.status === 'done').length;

  let focusLabel;
  if (live) focusLabel = 'Focus block running';
  else if (weekend) focusLabel = 'Weekend: no focus block';
  else if (now < start) focusLabel = `Focus block starts at ${fmtTime(start)}`;
  else if (now < end) focusLabel = sessions.length ? 'Paused. The block is still on.' : 'You should be in your focus block now';
  else focusLabel = 'Focus block over';

  $app.innerHTML = `
    <h1>${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
    <p class="muted" style="margin-top:0">${active.length ? `${done} of ${active.length} tasks done` : 'No tasks yet'}</p>

    <section class="card focus ${live ? 'live' : ''}">
      <div class="small muted">${esc(focusLabel)}</div>
      <div class="clock" id="clock">${fmtDur(doneMs + (live ? now - new Date(live.started_at) : 0))}</div>
      <button class="${live ? 'ghost' : 'primary'}" id="focusBtn">${live ? 'Stop' : 'Start focus'}</button>
    </section>

    <h2>Today's tasks</h2>
    <div id="tasks">${active.length ? active.map(taskHtml).join('') : `<div class="card muted small">Claude sets your tasks each morning. Until the reviewer is built, they arrive from our chat.</div>`}</div>
    <button class="ghost block small" id="addTask">Add a task</button>

    <h2>Check-ins</h2>
    <div class="card stack">
      <div class="row"><div class="grow"><strong>Noon check-in</strong><div class="small muted">Close the focus block: what got done?</div></div>
        ${has('noon') ? '<span class="badge">Done</span>' : `<button class="small" id="noonBtn" ${now < end && !weekend ? 'disabled' : ''}>Check in</button>`}</div>
      <div class="row"><div class="grow"><strong>Night log</strong><div class="small muted">The rest of the day, and your self-rating</div></div>
        ${has('night') ? '<span class="badge">Done</span>' : '<button class="small" id="nightBtn">Log</button>'}</div>
    </div>`;

  // focus timer
  clearInterval(tick);
  if (live) tick = setInterval(() => {
    const el = document.getElementById('clock');
    if (el) el.textContent = fmtDur(doneMs + (Date.now() - new Date(live.started_at)));
  }, 1000);
  document.getElementById('focusBtn').onclick = async () => {
    if (live) {
      await sb.from('focus_sessions').update({ ended_at: new Date().toISOString() }).eq('id', live.id);
      await logEvent('focus_stop'); toast('Focus stopped');
    } else {
      await sb.from('focus_sessions').insert({ day: today() });
      await logEvent('focus_start'); toast('Focus started. Phone down.');
    }
    renderToday();
  };

  // tasks
  document.querySelectorAll('[data-check]').forEach((b) => (b.onclick = async () => {
    const t = tasks.find((x) => x.id === b.dataset.check);
    const next = t.status === 'done' ? 'pending' : 'done';
    await sb.from('tasks').update({ status: next, completed_at: next === 'done' ? new Date().toISOString() : null }).eq('id', t.id);
    await logEvent(next === 'done' ? 'task_done' : 'task_undone', { task_id: t.id });
    renderToday();
  }));
  document.querySelectorAll('[data-swap]').forEach((b) => (b.onclick = () => swapDialog(tasks.find((x) => x.id === b.dataset.swap), tasks)));
  document.getElementById('addTask').onclick = () => addTaskDialog(active.length);
  document.getElementById('noonBtn')?.addEventListener('click', () => noonDialog(active));
  document.getElementById('nightBtn')?.addEventListener('click', nightDialog);
}

function taskHtml(t) {
  const meta = [t.time_box_min ? `${t.time_box_min} min` : '', t.done_criteria ? `Done when: ${t.done_criteria}` : ''].filter(Boolean).join(' · ');
  return `<div class="card task ${t.status === 'done' ? 'done' : ''}">
    <div class="row">
      <button class="check" data-check="${t.id}" aria-label="Mark ${esc(t.title)} ${t.status === 'done' ? 'not done' : 'done'}"></button>
      <div class="grow"><div class="title">${esc(t.title)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
        ${t.swapped_from ? '<div class="meta">Swapped in</div>' : ''}</div>
      ${t.status !== 'done' ? `<button class="small ghost" data-swap="${t.id}">Swap</button>` : ''}
    </div></div>`;
}

function openDialog(html, onSubmit) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<form method="dialog" class="stack">${html}
    <div class="row"><button type="button" class="ghost grow" data-cancel>Cancel</button><button class="primary grow" type="submit">Save</button></div></form>`;
  document.body.appendChild(dlg);
  dlg.querySelector('[data-cancel]').onclick = () => dlg.close();
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const err = await onSubmit(fd);
    if (err) return toast(err);
    dlg.close(); renderToday();
  };
  dlg.showModal();
}

function addTaskDialog(count) {
  openDialog(`<h2 style="margin-top:0">New task</h2>
    <div><label>Task</label><input name="title" required></div>
    <div><label>Done when…</label><input name="done_criteria" placeholder="A concrete, checkable result" required></div>
    <div><label>Time box (minutes)</label><input name="time_box_min" type="number" min="10" max="180" value="45"></div>`,
  async (f) => {
    const { error } = await sb.from('tasks').insert({ day: today(), title: f.title, done_criteria: f.done_criteria, time_box_min: Number(f.time_box_min) || null, source: 'user', sort: count });
    if (error) return error.message;
    await logEvent('task_added');
  });
}

function swapDialog(task, all) {
  const swapsToday = all.filter((t) => t.swapped_from).length;
  openDialog(`<h2 style="margin-top:0">Swap task</h2>
    ${swapsToday >= 1 ? '<p class="small" style="color:var(--bad)">You already swapped once today. A second swap counts as a skip.</p>' : ''}
    <p class="small muted">Replacing: <b>${esc(task.title)}</b>. The new task must apply AI to the work that bumped this one.</p>
    <div><label>What work commitment bumped it?</label><input name="reason" required></div>
    <div><label>Replacement task (using AI on that work)</label><input name="title" required></div>
    <div><label>Done when…</label><input name="done_criteria" required></div>`,
  async (f) => {
    const { error: e1 } = await sb.from('tasks').update({ status: swapsToday >= 1 ? 'skipped' : 'swapped', swap_reason: f.reason }).eq('id', task.id);
    if (e1) return e1.message;
    const { error: e2 } = await sb.from('tasks').insert({ day: today(), title: f.title, done_criteria: f.done_criteria, swapped_from: task.id, swap_reason: f.reason, source: 'user', sort: task.sort });
    if (e2) return e2.message;
    await logEvent('task_swapped', { from: task.id, reason: f.reason, counted_as_skip: swapsToday >= 1 });
  });
}

function noonDialog(tasks) {
  openDialog(`<h2 style="margin-top:0">Noon check-in</h2>
    <p class="small muted">Mark tasks done on the Today screen first. Then be honest here.</p>
    <div><label>What did you actually produce in the block?</label><textarea name="produced" required></textarea></div>
    <div><label>Where did time leak? (phone, meetings, drifting…)</label><textarea name="leaks"></textarea></div>`,
  async (f) => {
    const { error } = await sb.from('checkins').insert({ day: today(), kind: 'noon', content: { ...f, tasks_done: tasks.filter((t) => t.status === 'done').length, tasks_total: tasks.length } });
    if (error) return error.message;
    await logEvent('noon_checkin');
  });
}

function nightDialog() {
  openDialog(`<h2 style="margin-top:0">Night log</h2>
    <div><label>What else did you do today that matters? (work, AI, learning)</label><textarea name="log" required></textarea></div>
    <div><label>Where did you use AI at work today, and what did it change?</label><textarea name="ai_at_work"></textarea></div>
    <div><label>Rate your day honestly, 1 to 10</label><input name="self_rating" type="number" min="1" max="10" required></div>`,
  async (f) => {
    const { error } = await sb.from('checkins').insert({ day: today(), kind: 'night', content: { log: f.log, ai_at_work: f.ai_at_work }, self_rating: Number(f.self_rating) });
    if (error) return error.message;
    await logEvent('night_log');
  });
}

// ---------- report ----------
async function renderReport() {
  clearInterval(tick);
  const { data } = await sb.from('reports').select('*').order('day', { ascending: false }).order('created_at', { ascending: false }).limit(1);
  const r = data?.[0];
  if (!r) {
    $app.innerHTML = `<h1>Report</h1><div class="card"><p style="margin:0"><strong>No report yet.</strong></p>
      <p class="small muted">Your first scored report arrives once the morning reviewer is built in Phase 2. Until then, every check-in you log becomes evidence for it.</p></div>`;
    return;
  }
  const s = r.scores || {};
  let audio = '', pdf = '';
  if (r.audio_path) { const { data: u } = await sb.storage.from('reports').createSignedUrl(r.audio_path, 3600); if (u) audio = `<audio controls src="${u.signedUrl}" style="width:100%"></audio>`; }
  if (r.pdf_path) { const { data: u } = await sb.storage.from('reports').createSignedUrl(r.pdf_path, 3600); if (u) pdf = `<a class="btn" href="${u.signedUrl}" target="_blank" rel="noopener">Open PDF</a>`; }
  $app.innerHTML = `<h1>${r.kind === 'daily' ? 'Daily' : r.kind === 'weekly' ? 'Weekly' : 'Monthly'} report</h1>
    <p class="muted" style="margin-top:0">${new Date(r.day).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p>
    <div class="card"><div class="row"><div class="score">${esc(s.overall ?? '–')}</div><div class="grow"><strong>${esc(s.grade ?? '')}</strong></div></div></div>
    ${audio}${pdf ? `<div style="margin:10px 0">${pdf}</div>` : ''}
    <div class="card report">${mdToHtml(r.body_md)}</div>`;
}

// Minimal markdown: headings, bold, quotes, lists, paragraphs
function mdToHtml(md) {
  return esc(md).split(/\n{2,}/).map((block) => {
    const b = block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (/^### /.test(b)) return `<h3>${b.slice(4)}</h3>`;
    if (/^## /.test(b)) return `<h3>${b.slice(3)}</h3>`;
    if (/^&gt; /.test(b)) return `<blockquote>${b.replace(/^&gt; /gm, '')}</blockquote>`;
    if (/^(\d+\.|-) /.test(b)) return `<ul>${b.split('\n').map((l) => `<li>${l.replace(/^(\d+\.|-) /, '')}</li>`).join('')}</ul>`;
    return `<p>${b.replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

// ---------- settings ----------
async function renderSettings() {
  clearInterval(tick);
  const { data } = await sb.from('notification_prefs').select('prefs').maybeSingle();
  const prefs = { ...DEFAULT_PREFS, ...(data?.prefs || {}) };
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const permText = { granted: 'On', denied: 'Blocked in iPhone Settings', default: 'Not enabled yet', unsupported: isIOS() && !isStandalone() ? 'Install the app to enable' : 'Not supported here' }[perm];

  $app.innerHTML = `<h1>Settings</h1>
    <h2>Notifications</h2>
    <div class="card stack">
      <div class="row"><div class="grow"><strong>Status</strong><div class="small muted">${esc(permText)}</div></div>
        ${perm === 'default' ? '<button class="primary small" id="enable">Enable</button>' : ''}
        ${perm === 'granted' ? '<button class="small" id="test">Send test</button>' : ''}</div>
    </div>
    <div class="card">${NOTIFY_TYPES.map(([k, label]) => `<label class="switch"><span>${esc(label)}</span><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}></label>`).join('')}</div>
    <p class="small muted">During 9 to 12, only the noon check-in will make a sound. The rest arrive silently.</p>

    <h2>Account</h2>
    <div class="card row"><div class="grow small">${esc(user.email)}</div><button class="small ghost" id="signout">Sign out</button></div>
    ${isIOS() && !isStandalone() ? installCard() : ''}
    <p class="small muted center">Coach ${VERSION}</p>`;

  document.getElementById('enable')?.addEventListener('click', async () => {
    const res = await Notification.requestPermission();
    await logEvent('notifications_permission', { result: res });
    toast(res === 'granted' ? 'Notifications on' : 'Not allowed');
    renderSettings();
  });
  document.getElementById('test')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Coach', { body: 'Test notification. If you can read this, reminders will reach you.', icon: 'icons/icon-192.png', tag: 'test' });
  });
  document.querySelectorAll('[data-pref]').forEach((el) => (el.onchange = async () => {
    prefs[el.dataset.pref] = el.checked;
    await sb.from('notification_prefs').upsert({ user_id: user.id, prefs, updated_at: new Date().toISOString() });
    toast('Saved');
  }));
  document.getElementById('signout').onclick = () => sb.auth.signOut();
}

// ---------- routing ----------
function show(t) {
  tab = t;
  $tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  ({ today: renderToday, report: renderReport, settings: renderSettings })[t]().catch((e) => { console.error(e); toast('Something went wrong. Pull to refresh.'); });
}
$tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => show(b.dataset.tab)));
document.addEventListener('visibilitychange', () => { if (!document.hidden && user && tab === 'today') renderToday(); });

sb.auth.onAuthStateChange((_event, session) => {
  const next = session?.user ?? null;
  if (next?.id === user?.id && next) return;
  user = next;
  if (user) { $tabs.hidden = false; show('today'); } else { clearInterval(tick); renderAuth(); }
});
