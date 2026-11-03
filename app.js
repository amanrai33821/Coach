import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, FOCUS_START, FOCUS_END, VAPID_PUBLIC_KEY } from './config.js';

const VERSION = '0.4.0';
const $app = document.getElementById('app');
const $tabs = document.getElementById('tabs');
const $toast = document.getElementById('toast');

// Fixed by design. Changing one takes a code change, on purpose.
const RUNNING = [
  ['Workdays', 'Monday to Friday. Weekends are off.'],
  ['Focus block', '9:00 AM to 12:00 PM. The timer starts itself.'],
  ['Focus heads-up alert', '8:45 AM'],
  ['Focus start alert', '9:00 AM'],
  ['Noon check-in', '12:00 PM. Submitting it stops the timer.'],
  ['Timer still running alert', '12:15 PM, if you forgot to check in'],
  ['Night log reminder', '9:45 PM'],
];
const DEFAULT_PREFS = {
  task_events: true,
  reports: { time: '08:00', daily: true, weekly: true, monthly: true },
  claude_account: '',
};
const loadPrefs = async () => {
  const { data } = await sb.from('notification_prefs').select('prefs').maybeSingle();
  const p = data?.prefs || {};
  return { ...DEFAULT_PREFS, ...p, reports: { ...DEFAULT_PREFS.reports, ...(p.reports || {}) } };
};
const savePrefs = (prefs) => sb.from('notification_prefs').upsert({ user_id: user.id, prefs, updated_at: new Date().toISOString() });

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

// ---------- notifications ----------
const b64ToBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
// Saves this phone as a notification destination. Safe to call on every open.
async function ensurePushSubscription() {
  if (!user || !('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({ user_id: user.id, endpoint: j.endpoint, keys: j.keys }, { onConflict: 'endpoint' });
    if (error) { console.error(error); return false; }
    return true;
  } catch (e) { console.error('push subscribe failed', e); return false; }
}
let taskEventsOn = true;
async function notifyLocal(body) {
  if (!taskEventsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  try { const reg = await navigator.serviceWorker.ready; await reg.showNotification('Coach', { body, icon: 'icons/icon-192.png', tag: 'task' }); } catch {}
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
  if (live) focusLabel = live.auto_started ? 'Focus block running · started automatically' : 'Focus block running';
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
      <div class="row"><div class="grow"><strong>Noon check-in</strong><div class="small muted">Closes the block: stops the timer, records what got done</div></div>
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
      await logEvent('focus_stop'); toast('Focus stopped'); notifyLocal('Focus stopped.');
    } else {
      await sb.from('focus_sessions').insert({ day: today() });
      await logEvent('focus_start'); toast('Focus started. Phone down.'); notifyLocal('Focus started. Phone down.');
    }
    renderToday();
  };

  // tasks
  document.querySelectorAll('[data-check]').forEach((b) => (b.onclick = async () => {
    const t = tasks.find((x) => x.id === b.dataset.check);
    const next = t.status === 'done' ? 'pending' : 'done';
    await sb.from('tasks').update({ status: next, completed_at: next === 'done' ? new Date().toISOString() : null }).eq('id', t.id);
    await logEvent(next === 'done' ? 'task_done' : 'task_undone', { task_id: t.id });
    if (next === 'done') notifyLocal(`Done: ${t.title}`);
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

function openDialog(html, onSubmit, after = renderToday) {
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
    dlg.close(); after();
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
    notifyLocal(swapsToday >= 1 ? `Second swap today: "${task.title}" counts as skipped.` : `Swapped in: ${f.title}`);
  });
}

function noonDialog(tasks) {
  openDialog(`<h2 style="margin-top:0">Noon check-in</h2>
    <p class="small muted">This closes your focus block: it stops the timer and records what the block produced. Mark tasks done on the Today screen first. Then be honest here.</p>
    <div><label>What did you actually produce in the block?</label><textarea name="produced" required></textarea></div>
    <div><label>Where did time leak? (phone, meetings, drifting…)</label><textarea name="leaks"></textarea></div>`,
  async (f) => {
    const { error } = await sb.from('checkins').insert({ day: today(), kind: 'noon', content: { ...f, tasks_done: tasks.filter((t) => t.status === 'done').length, tasks_total: tasks.length } });
    if (error) return error.message;
    // Closing the block stops any running timer
    await sb.from('focus_sessions').update({ ended_at: new Date().toISOString() }).eq('day', today()).is('ended_at', null);
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
const APP_URL = 'https://amanrai33821.github.io/coach/';
const INSTALL_URL = APP_URL + 'mac/install.sh';
const when = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// A pairing code is shown once; the database keeps only its SHA-256 fingerprint.
async function newPairingCode(kind) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const code = `coach_${kind}_` + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  const token_hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { code, token_hash };
}
async function loadConnections() {
  const { data } = await sb.from('connections').select('*').is('revoked_at', null).order('created_at', { ascending: false });
  const live = data || [];
  return { mac: live.find((c) => c.kind === 'mac') || null, claude: live.find((c) => c.kind === 'claude') || null };
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = old), 1800); }
}

// A guided sheet: numbered steps, Copy buttons, and a last step that ticks itself off.
function linkMacSheet(code, connId) {
  const cmd = `curl -fsSL ${INSTALL_URL} | bash -s -- ${code}`;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="stack">
    <h2 style="margin-top:0">Link your Mac</h2>
    <p class="small muted">Sends your Claude Code activity to Coach. Takes about a minute. Do these on the Mac where you use Claude Code.</p>
    <ol class="steps">
      <li><strong>Open Terminal.</strong><div class="small muted">Press Command + Space, type <b>Terminal</b>, press Return.</div></li>
      <li><strong>Copy this command.</strong>
        <div class="code" id="cmd">${esc(cmd)}</div>
        <button class="small" id="copyCmd">Copy</button>
        <div class="small muted">On your iPhone? With the same Apple ID, Copy here and paste on your Mac (Universal Clipboard). Or open <b>${esc(APP_URL)}</b> on your Mac, sign in, and use this screen there.</div></li>
      <li><strong>Paste it into Terminal and press Return.</strong><div class="small muted">It prints a few ticks and ends with "Done". It changes nothing except adding Coach to Claude Code, and backs up your settings first.</div></li>
      <li><strong>Waiting for your Mac to check in…</strong><div class="small" id="macStatus"><span class="muted">This ticks itself off when your Mac connects.</span></div></li>
    </ol>
    <p class="small muted" style="margin:0">This code is shown only once. If you lose it, close this and tap Link Mac again.</p>
    <button class="primary block" id="sheetDone">Close</button>
  </div>`;
  document.body.appendChild(dlg);
  const status = dlg.querySelector('#macStatus');
  const last = dlg.querySelectorAll('.steps li')[3];
  dlg.querySelector('#copyCmd').onclick = (e) => copyText(cmd, e.currentTarget);
  let timer = setInterval(async () => {
    const { data } = await sb.from('connections').select('last_seen_at, meta').eq('id', connId).maybeSingle();
    if (data?.last_seen_at) {
      clearInterval(timer); timer = null;
      last.classList.add('done');
      last.querySelector('strong').textContent = 'Your Mac is linked.';
      status.innerHTML = `<span style="color:var(--good)">✓ ${esc(data.meta?.device || 'Mac')} checked in at ${esc(fmtTime(data.last_seen_at))}.</span>`;
      dlg.querySelector('#sheetDone').textContent = 'Done';
      logEvent('mac_linked');
    }
  }, 3000);
  const close = () => { if (timer) clearInterval(timer); dlg.close(); };
  dlg.querySelector('#sheetDone').onclick = close;
  dlg.addEventListener('close', () => { if (timer) clearInterval(timer); dlg.remove(); renderSettings(); });
  dlg.showModal();
}

async function renderSettings() {
  clearInterval(tick);
  const [prefs, conns] = await Promise.all([loadPrefs(), loadConnections()]);
  const mac = conns.mac;
  let macText, macBtn, macDot;
  if (mac?.last_seen_at) {
    const waiting = Number(mac.meta?.queued || 0);
    macText = `Linked · ${mac.meta?.device || 'Mac'} · last seen ${when(mac.last_seen_at)}${waiting ? ` · ${waiting} upload(s) waiting` : ''}`;
    macBtn = '<button class="small ghost" id="macDisconnect">Disconnect</button>'; macDot = 'on';
  } else if (mac) {
    macText = 'Setup not finished: your Mac has not checked in yet.';
    macBtn = '<button class="small primary" id="macLink">Link Mac</button>'; macDot = 'wait';
  } else {
    macText = 'Not linked. Needed to score your Claude Code use.';
    macBtn = '<button class="small primary" id="macLink">Link Mac</button>'; macDot = 'off';
  }
  const name = user.user_metadata?.full_name || '';
  const initials = (name || user.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const permText = { granted: 'On', denied: 'Blocked in iPhone Settings', default: 'Not enabled yet', unsupported: isIOS() && !isStandalone() ? 'Install the app to enable' : 'Not supported here' }[perm];
  const r = prefs.reports;

  $app.innerHTML = `<h1>Settings</h1>

    <div class="card row" style="margin-top:16px">
      <div class="avatar" aria-hidden="true">${esc(initials)}</div>
      <div class="grow"><div style="font-weight:600;font-size:17px">${name ? esc(name) : '<span class="muted">Add your name</span>'}</div>
        <div class="small muted">${esc(user.email)}</div></div>
      <button class="small ghost" id="editName">Edit</button>
    </div>

    <h2>Connections</h2>
    <div class="card stack">
      <div class="row"><span class="dot ${macDot}" aria-hidden="true"></span>
        <div class="grow"><strong>Mac</strong> <span class="small muted">· Claude Code</span><div class="small muted">${esc(macText)}</div></div>${macBtn}</div>
      <div class="row"><span class="dot off" aria-hidden="true"></span>
        <div class="grow"><strong>Claude account</strong> <span class="small muted">· chats and the morning reviewer</span><div class="small muted">Linking opens once the reviewer is built (next step).</div></div>
        <button class="small" disabled>Link</button></div>
    </div>
    <p class="small muted">Linked separately, each with its own private pairing code. Disconnect cuts one off instantly.</p>

    <h2>Running parameters</h2>
    <div class="card">${RUNNING.map(([k, v]) => `<div class="switch"><span>${esc(k)}</span><span class="small muted" style="text-align:right;max-width:58%">${esc(v)}</span></div>`).join('')}</div>
    <p class="small muted">Non-negotiable, so there are no switches. Changing one takes a code change, on purpose.</p>

    <h2>Reports</h2>
    <div class="card">
      <label class="switch"><span>Delivery time</span><input type="time" id="reportTime" value="${esc(r.time)}" min="07:00" max="10:00" step="900" style="width:auto"></label>
      <label class="switch"><span>Daily report</span><input type="checkbox" data-report="daily" ${r.daily ? 'checked' : ''}></label>
      <label class="switch"><span>Weekly report <span class="small muted">· Sundays</span></span><input type="checkbox" data-report="weekly" ${r.weekly ? 'checked' : ''}></label>
      <label class="switch"><span>Monthly report <span class="small muted">· 1st of the month</span></span><input type="checkbox" data-report="monthly" ${r.monthly ? 'checked' : ''}></label>
    </div>
    <p class="small muted">Delivery between 7:00 and 10:00 AM; the reviewer runs at 6:30. Reports start once the Claude account is linked.</p>

    <h2>Notifications</h2>
    <div class="card stack">
      <div class="row"><div class="grow"><strong>Status</strong><div class="small muted">${esc(permText)}</div></div>
        ${perm === 'default' ? '<button class="primary small" id="enable">Enable</button>' : ''}
        ${perm === 'granted' ? '<button class="small" id="test">Send test</button>' : ''}</div>
      <label class="switch"><span>Task started, done or swapped</span><input type="checkbox" id="taskEvents" ${prefs.task_events ? 'checked' : ''}></label>
    </div>
    <p class="small muted">Alerts for the running parameters are always on. During 9 to 12, only the noon check-in makes a sound.</p>

    <button class="ghost block" id="signout" style="margin-top:24px">Sign out</button>
    ${isIOS() && !isStandalone() ? installCard() : ''}
    <p class="small muted center">Coach ${VERSION}</p>`;

  const save = async (msg = 'Saved') => { const { error } = await savePrefs(prefs); toast(error ? error.message : msg); };

  document.getElementById('editName').onclick = () => openDialog(`<h2 style="margin-top:0">Your name</h2>
    <div><label>Name</label><input name="full_name" value="${esc(name)}" autocomplete="name" required></div>`,
  async (f) => {
    const { data, error } = await sb.auth.updateUser({ data: { full_name: f.full_name.trim() } });
    if (error) return error.message;
    user = data.user;
  }, renderSettings);

  document.getElementById('macLink')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    if (mac) await sb.from('connections').update({ revoked_at: new Date().toISOString() }).eq('id', mac.id); // unfinished attempt
    const { code, token_hash } = await newPairingCode('mac');
    const { data, error } = await sb.from('connections').insert({ kind: 'mac', token_hash }).select('id').single();
    if (error) { toast(error.message); return renderSettings(); }
    linkMacSheet(code, data.id);
  });
  document.getElementById('macDisconnect')?.addEventListener('click', async () => {
    if (!confirm('Disconnect your Mac? Coach stops accepting its uploads immediately, and your Claude Code use is no longer scored.')) return;
    await sb.from('connections').update({ revoked_at: new Date().toISOString() }).eq('id', mac.id);
    await logEvent('mac_disconnected');
    const dlg = document.createElement('dialog');
    const un = `curl -fsSL ${INSTALL_URL} | bash -s -- --uninstall`;
    dlg.innerHTML = `<div class="stack"><h2 style="margin-top:0">Mac disconnected</h2>
      <p class="small">Coach no longer accepts anything from that Mac. To also remove the Coach files from it, paste this into its Terminal:</p>
      <div class="code">${esc(un)}</div><button class="small" id="copyUn">Copy</button>
      <button class="primary block" id="unDone">Done</button></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#copyUn').onclick = (ev) => copyText(un, ev.currentTarget);
    dlg.querySelector('#unDone').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.remove(); renderSettings(); });
    dlg.showModal();
  });

  document.getElementById('reportTime').onchange = (e) => {
    const v = e.target.value;
    if (!v || v < '07:00' || v > '10:00') { e.target.value = r.time; return toast('Pick a time between 7:00 and 10:00 AM'); }
    r.time = v; save(`Reports at ${fmtTime(atTime(v))}`);
  };
  document.querySelectorAll('[data-report]').forEach((el) => (el.onchange = () => {
    const k = el.dataset.report;
    if (k === 'daily' && !el.checked && !confirm('Turn off the daily report? It is your main feedback loop, and days without one are not scored.')) { el.checked = true; return; }
    r[k] = el.checked; save();
  }));
  document.getElementById('taskEvents').onchange = (e) => { prefs.task_events = taskEventsOn = e.target.checked; save(); };

  document.getElementById('enable')?.addEventListener('click', async () => {
    const res = await Notification.requestPermission();
    await logEvent('notifications_permission', { result: res });
    const ok = res === 'granted' && (await ensurePushSubscription());
    toast(res !== 'granted' ? 'Not allowed' : ok ? 'Notifications on' : 'Allowed, but this phone could not be registered. Reopen the app.');
    renderSettings();
  });
  document.getElementById('test')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Coach', { body: 'Test notification. If you can read this, reminders will reach you.', icon: 'icons/icon-192.png', tag: 'test' });
  });
  document.getElementById('signout').onclick = () => sb.auth.signOut();
}

// ---------- routing ----------
function show(t) {
  tab = t;
  $tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  ({ today: renderToday, report: renderReport, settings: renderSettings })[t]().catch((e) => { console.error(e); toast('Something went wrong. Pull to refresh.'); });
}
$tabs.querySelectorAll('button').forEach((b) => (b.onclick = () => { history.replaceState(null, '', `#${b.dataset.tab}`); show(b.dataset.tab); }));
const tabFromHash = () => { const h = location.hash.slice(1); return ['today', 'report', 'settings'].includes(h) ? h : 'today'; };
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open' && user) { const h = new URL(e.data.url).hash.slice(1); if (h) { history.replaceState(null, '', `#${h}`); show(tabFromHash()); } }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && user && tab === 'today') renderToday(); });

sb.auth.onAuthStateChange((_event, session) => {
  const next = session?.user ?? null;
  if (next?.id === user?.id && next) return;
  user = next;
  if (user) {
    $tabs.hidden = false; show(tabFromHash());
    ensurePushSubscription();
    loadPrefs().then((p) => { taskEventsOn = p.task_events !== false; }).catch(() => {});
  } else { clearInterval(tick); renderAuth(); }
});
