// Coach: scheduled notifications ("tick").
// Called every 15 minutes by the database's scheduler (pg_cron).
// Sends the fixed running-parameter alerts, starts the 9:00 focus block,
// and sends "Report ready" (or "Reviewer did not run") at your delivery time.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';

const TZ = 'Asia/Kolkata';
const WORKDAYS = [1, 2, 3, 4, 5]; // Monday to Friday

// Settings come from Supabase: Edge Functions -> Secrets. Checked on every call,
// so a missing or mistyped secret gives a clear message instead of a crash.
const env = (k: string) => (Deno.env.get(k) ?? '').trim();
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
// deno-lint-ignore no-explicit-any
let db: any;
let ready = false;
function setup(): string | null {
  if (ready) return null;
  const missing = REQUIRED.filter((k) => !env(k));
  if (missing.length) return `Missing secrets: ${missing.join(', ')}`;
  try {
    webpush.setVapidDetails('mailto:coach@example.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  } catch (e) {
    return `VAPID keys are not valid (check for extra characters): ${String(e).slice(0, 200)}`;
  }
  db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  ready = true;
  return null;
}

type Push = { title: string; body: string; tag: string; url?: string };

// Local date, weekday and the 15-minute slot ("HH:MM") in your time zone.
export function localNow(d = new Date(), tz = TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const minute = Math.floor(Number(p.minute) / 15) * 15; // snap to the slot
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    slot: `${p.hour}:${String(minute).padStart(2, '0')}`,
    weekday: wd,
    dayOfMonth: Number(p.day),
  };
}

async function sendOnce(userId: string, key: string, msg: Push) {
  // The log's primary key makes every alert fire at most once, even if the scheduler repeats.
  const { error } = await db.from('notification_log').insert({ user_id: userId, key });
  if (error) return 'already sent';
  const { data: subs } = await db.from('push_subscriptions').select('id, endpoint, keys').eq('user_id', userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // phone unsubscribed
      else console.error('push failed', code, String(e));
    }
  }
  return `sent to ${sent}`;
}

async function skipDays(userId: string): Promise<string[]> {
  const { data } = await db.from('coach_config').select('value').eq('user_id', userId).eq('key', 'skip_days').maybeSingle();
  try { const v = JSON.parse(data?.value ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

async function tickUser(userId: string, prefs: Record<string, any>, now: ReturnType<typeof localNow>) {
  const out: Record<string, string> = {};
  const skipped = await skipDays(userId);

  // One-off reminders that are due (sent by any run at or after their time)
  const { data: due } = await db.from('reminders').select('id, title, body, url').eq('user_id', userId).is('sent_at', null).lte('at', new Date().toISOString());
  for (const r of due ?? []) {
    out[`reminder_${r.id.slice(0, 8)}`] = await sendOnce(userId, `reminder:${r.id}`, { title: r.title, body: r.body, tag: 'reminder', url: r.url ?? './' });
    await db.from('reminders').update({ sent_at: new Date().toISOString() }).eq('id', r.id);
  }
  const { date, slot, weekday } = now;
  const workday = WORKDAYS.includes(weekday);

  if (workday) {
    if (slot === '08:45') {
      out.heads_up = await sendOnce(userId, `${date}:heads_up`, {
        title: 'Focus block in 15 minutes', body: 'Open your first task now. Phone goes away at 9.', tag: 'focus',
      });
    }
    if (slot === '09:00') {
      const { data: sessions } = await db.from('focus_sessions').select('id').eq('user_id', userId).eq('day', date);
      if (!sessions?.length) {
        await db.from('focus_sessions').insert({ user_id: userId, day: date, auto_started: true });
      }
      out.focus_start = await sendOnce(userId, `${date}:focus_start`, {
        title: 'Focus block started', body: 'The timer is running until 12:00. Phone down.', tag: 'focus',
      });
    }
    if (slot === '12:00') {
      out.noon = await sendOnce(userId, `${date}:noon`, {
        title: 'Noon check-in', body: 'Close the block: what did you actually produce?', tag: 'noon',
      });
    }
    // A timer still running after the block: reminders at 12:15 and 12:30, automatic stop at 1:00 PM.
    if (slot === '12:15' || slot === '12:30') {
      const { data: open } = await db.from('focus_sessions').select('id').eq('user_id', userId).eq('day', date).is('ended_at', null);
      if (open?.length) {
        out.timer = slot === '12:15'
          ? await sendOnce(userId, `${date}:timer_1215`, { title: 'Timer still running', body: 'Stop it with your noon check-in.', tag: 'noon' })
          : await sendOnce(userId, `${date}:timer_1230`, { title: 'Timer still running: second reminder', body: 'It stops automatically at 1:00 PM. Do your noon check-in now.', tag: 'noon' });
      }
    }
    if (slot === '21:45' && !skipped.includes(date)) {
      const { data: night } = await db.from('checkins').select('id').eq('user_id', userId).eq('day', date).eq('kind', 'night');
      if (!night?.length) {
        out.night = await sendOnce(userId, `${date}:night`, {
          title: 'Night log', body: 'Two minutes: log the day and rate it. Skipping caps the day at 40.', tag: 'night',
        });
      }
    }
  }

  if (slot === '13:00') {
    const stopAt = new Date(Date.parse(`${date}T13:00:00+05:30`)).toISOString();
    const { data: stopped } = await db.from('focus_sessions').update({ ended_at: stopAt, auto_stopped: true })
      .eq('user_id', userId).is('ended_at', null).lte('started_at', stopAt).select('id, day');
    if (stopped?.length) {
      await db.from('events').insert({ user_id: userId, source: 'app', kind: 'focus_auto_stopped', payload: { sessions: stopped.length, at: '13:00' } });
      if (stopped.some((x: any) => x.day === date)) {
        out.auto_stop = await sendOnce(userId, `${date}:timer_autostop`, {
          title: 'Timer stopped at 1:00 PM', body: 'You never stopped it. This counts against Execution. Do your noon check-in now.', tag: 'noon',
        });
      }
    }
  }

  // Report ready, at your delivery time
  const reports = { time: '08:00', daily: true, weekly: true, monthly: true, ...(prefs.reports ?? {}) };
  const [rh, rm] = String(reports.time).split(':').map(Number);
  const reportSlot = `${String(rh).padStart(2, '0')}:${String(Math.floor(rm / 15) * 15).padStart(2, '0')}`;
  if (slot === reportSlot) {
    const since = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: fresh } = await db.from('reports').select('id, kind').eq('user_id', userId).gte('created_at', since);
    const wanted = (fresh ?? []).filter((r: any) => reports[r.kind as 'daily' | 'weekly' | 'monthly'] !== false);
    if (wanted.length) {
      const kinds = [...new Set(wanted.map((r: any) => r.kind))];
      out.report = await sendOnce(userId, `${date}:report_ready`, {
        title: kinds.length > 1 ? 'Your reports are ready' : `Your ${kinds[0]} report is ready`,
        body: 'Tap to read it. No excuses today.', tag: 'report', url: './#report',
      });
    } else {
      // Only alarm once a reviewer exists and a daily report was due (it covers the previous workday).
      const { count } = await db.from('reports').select('id', { count: 'exact', head: true }).eq('user_id', userId);
      const yesterday = new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      const dailyDue = reports.daily && [2, 3, 4, 5, 6].includes(weekday) && !skipped.includes(yesterday);
      if ((count ?? 0) > 0 && dailyDue) {
        out.report = await sendOnce(userId, `${date}:reviewer_missing`, {
          title: 'The reviewer did not run', body: 'No report this morning. Open Coach to check the Claude account connection.', tag: 'report', url: './#settings',
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connections API: your Mac (and, from Step 5, the reviewer) call in with their
// own pairing code in the "x-coach-token" header. Only its SHA-256 is stored.
// ---------------------------------------------------------------------------
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const TOOL_INPUT_MAX = 2000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `… [${s.length - n} more characters]` : s);

// Turns lines of a Claude Code transcript (.jsonl) into activity events.
// Your messages are kept in full; Claude's replies are kept in full too
// (the reviewer decides how much to read); tool inputs are clipped.
export function parseTranscript(text: string, fallbackSession = '') {
  const out: { ext_id: string; occurred_at: string; kind: string; session_id: string; project: string | null; payload: Record<string, unknown> }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isMeta || o.isSidechain) continue; // system-inserted lines and subagent chatter
    const uuid = String(o.uuid ?? '');
    if (!uuid) continue;
    const base = {
      occurred_at: o.timestamp ?? new Date().toISOString(),
      session_id: String(o.sessionId ?? fallbackSession),
      project: o.cwd ? String(o.cwd).split('/').filter(Boolean).pop() ?? null : null,
    };
    const content = o.message?.content;
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    blocks.forEach((b, i) => {
      const ext_id = `cc:${uuid}:${i}`;
      if (o.type === 'user') {
        if (b.type !== 'text' || typeof b.text !== 'string') return; // tool results are skipped
        const t = b.text.trim();
        if (!t || t.startsWith('<command-') || t.startsWith('<local-command') || t.startsWith('Caveat:')) return;
        out.push({ ...base, ext_id, kind: 'prompt', payload: { text: t, chars: t.length } });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ ...base, ext_id, kind: 'reply', payload: { text: b.text, chars: b.text.length, model: o.message?.model ?? null } });
      } else if (b.type === 'tool_use') {
        const input = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {});
        out.push({ ...base, ext_id, kind: 'tool', payload: { name: b.name, input: clip(input, TOOL_INPUT_MAX) } });
      }
    });
  }
  return out;
}

async function handleApi(req: Request, token: string): Promise<Response> {
  const { data: conn } = await db.from('connections').select('id, user_id, kind, revoked_at, meta, created_at')
    .eq('token_hash', await sha256hex(token)).maybeSingle();
  if (!conn) return Response.json({ error: 'unknown pairing code' }, { status: 401 });
  if (conn.revoked_at) return Response.json({ error: 'this connection was disconnected in the app' }, { status: 401 });

  const action = req.headers.get('x-coach-action') ?? 'hello';
  const touch = (meta?: Record<string, unknown>) =>
    db.from('connections').update({ last_seen_at: new Date().toISOString(), ...(meta ? { meta: { ...conn.meta, ...meta } } : {}) }).eq('id', conn.id);

  if (action === 'hello') {
    const body = await req.json().catch(() => ({}));
    const meta: Record<string, unknown> = {};
    for (const k of ['device', 'os', 'version', 'queued', 'account']) if (body?.[k] != null) meta[k] = String(body[k]).slice(0, 120);
    await touch(meta);
    return Response.json({ ok: true, kind: conn.kind });
  }

  if (action === 'transcript' && conn.kind === 'mac') {
    const text = await req.text();
    const rows = parseTranscript(text, req.headers.get('x-coach-session') ?? '').map((r) => ({
      ...r, user_id: conn.user_id, source: 'claude_code', connection_id: conn.id,
    }));
    let stored = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const { error, count } = await db.from('events')
        .upsert(rows.slice(i, i + 500), { onConflict: 'user_id,ext_id', ignoreDuplicates: true, count: 'exact' });
      if (error) { console.error(error); return Response.json({ error: error.message }, { status: 500 }); }
      stored += count ?? 0;
    }
    await touch({ last_upload_events: rows.length });
    return Response.json({ ok: true, parsed: rows.length, stored });
  }

  if (conn.kind === 'claude') {
    const body = await req.json().catch(() => ({}));
    if (action === 'instructions') {
      // A personal override wins; otherwise everyone gets the shared default.
      const { data: own } = await db.from('coach_config').select('value').eq('user_id', conn.user_id).eq('key', 'reviewer_instructions').maybeSingle();
      const { data: shared } = own ? { data: null } : await db.from('coach_defaults').select('value').eq('key', 'reviewer_instructions').maybeSingle();
      await touch();
      const text = own?.value ?? shared?.value;
      if (!text) return Response.json({ error: 'no reviewer instructions stored yet' }, { status: 500 });
      return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    }
    if (action === 'context') {
      await touch();
      return Response.json(await buildContext(conn, body?.review_day));
    }
    if (action === 'event') {
      const { data } = await db.from('events').select('id, occurred_at, kind, session_id, project, payload')
        .eq('user_id', conn.user_id).eq('id', Number(body?.id)).maybeSingle();
      return data ? Response.json(data) : Response.json({ error: 'no such event' }, { status: 404 });
    }
    if (action === 'report') {
      await touch();
      return await saveReport(conn, body);
    }
  }

  return Response.json({ error: `action "${action}" is not available for this connection` }, { status: 400 });
}

// ---------------------------------------------------------------------------
// Reviewer support
// ---------------------------------------------------------------------------
const DAY_MS = 86400000;
const addDays = (ymd: string, n: number) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
const weekdayOf = (ymd: string) => new Date(ymd + 'T00:00:00Z').getUTCDay();
const isWorkday = (ymd: string) => WORKDAYS.includes(weekdayOf(ymd));
// Local (IST) day -> UTC window
const windowOf = (ymd: string) => ({
  start_utc: new Date(Date.parse(ymd + 'T00:00:00+05:30')).toISOString(),
  end_utc: new Date(Date.parse(ymd + 'T00:00:00+05:30') + DAY_MS).toISOString(),
});
const SHORT_REPLY = 2000;
const shorten = (t: string) => (t.length > SHORT_REPLY ? `${t.slice(0, 1400)}\n… [${t.length - 1700} characters left out; fetch the full text with action "event"] …\n${t.slice(-300)}` : t);

async function buildContext(conn: any, requested?: string) {
  const uid = conn.user_id;
  const now = localNow();
  const today = now.date;
  const [{ data: prefsRow }, { count: priorReports }] = await Promise.all([
    db.from('notification_prefs').select('prefs').eq('user_id', uid).maybeSingle(),
    db.from('reports').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('connection_id', conn.id),
  ]);
  const prefs = { daily: true, weekly: true, monthly: true, ...(prefsRow?.prefs?.reports ?? {}) };
  const isFirstRun = (priorReports ?? 0) === 0;

  // Which day to review
  let reviewDay = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : addDays(today, -1);
  if (!requested && isFirstRun) { while (!isWorkday(reviewDay)) reviewDay = addDays(reviewDay, -1); }

  const due: string[] = [];
  const has = async (day: string, kind: string) => {
    const { count } = await db.from('reports').select('id', { count: 'exact', head: true }).eq('user_id', uid).eq('day', day).eq('kind', kind);
    return (count ?? 0) > 0;
  };
  const skipped = await skipDays(uid);
  if (prefs.daily !== false && isWorkday(reviewDay) && (requested || isFirstRun || (!skipped.includes(reviewDay) && !(await has(reviewDay, 'daily'))))) due.push('daily');
  const friday = addDays(today, -2);
  if (now.weekday === 0 && prefs.weekly !== false && !(await has(friday, 'weekly'))) due.push('weekly');
  const lastOfMonth = addDays(today, -1);
  if (now.dayOfMonth === 1 && prefs.monthly !== false && !(await has(lastOfMonth, 'monthly'))) due.push('monthly');

  const win = windowOf(reviewDay);
  const [tasks, sessions, checkins, ccEvents, appEvents, history, ledger, macConn] = await Promise.all([
    db.from('tasks').select('title, done_criteria, time_box_min, status, swapped_from, swap_reason, source, completed_at, created_at').eq('user_id', uid).eq('day', reviewDay).order('sort'),
    db.from('focus_sessions').select('started_at, ended_at, auto_started, auto_stopped').eq('user_id', uid).eq('day', reviewDay).order('started_at'),
    db.from('checkins').select('kind, content, self_rating, created_at').eq('user_id', uid).eq('day', reviewDay),
    db.from('events').select('id, occurred_at, kind, session_id, project, payload').eq('user_id', uid).eq('source', 'claude_code')
      .gte('occurred_at', win.start_utc).lt('occurred_at', win.end_utc).order('occurred_at').limit(5000),
    db.from('events').select('occurred_at, kind, payload').eq('user_id', uid).eq('source', 'app')
      .gte('occurred_at', win.start_utc).lt('occurred_at', win.end_utc).order('occurred_at'),
    db.from('reports').select('day, kind, scores, created_at').eq('user_id', uid).order('day', { ascending: false }).limit(10),
    db.from('skills_ledger').select('skill, why, ladder, status, evidence_count').eq('user_id', uid).neq('status', 'rejected'),
    db.from('connections').select('created_at, last_seen_at, meta').eq('user_id', uid).eq('kind', 'mac').is('revoked_at', null).order('last_seen_at', { ascending: false, nullsFirst: false }).limit(1),
  ]);

  // Claude Code activity grouped by session
  const bySession: Record<string, any> = {};
  for (const e of ccEvents.data ?? []) {
    const k = e.session_id || 'unknown';
    const g = (bySession[k] ??= { session_id: k, project: e.project, first: e.occurred_at, last: e.occurred_at, prompts: [], replies: [], tools: {} as Record<string, number> });
    g.last = e.occurred_at;
    if (e.kind === 'prompt') g.prompts.push({ id: e.id, at: e.occurred_at, text: e.payload?.text });
    else if (e.kind === 'reply') g.replies.push({ id: e.id, at: e.occurred_at, text: shorten(String(e.payload?.text ?? '')) });
    else if (e.kind === 'tool') { const n = String(e.payload?.name ?? 'tool'); g.tools[n] = (g.tools[n] ?? 0) + 1; }
  }
  const sessionsList = Object.values(bySession);
  const mac = macConn.data?.[0] ?? null;

  const ctx: Record<string, unknown> = {
    today, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.weekday], review_day: reviewDay,
    review_weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(reviewDay)],
    due, window: win, timezone: TZ, is_first_run: isFirstRun, skipped_days: skipped,
    calibration: Date.now() - Date.parse(conn.created_at ?? new Date().toISOString()) < 14 * DAY_MS,
    connections: { mac: mac?.last_seen_at ? { linked: true, last_seen_at: mac.last_seen_at, device: mac.meta?.device ?? null, uploads_waiting: Number(mac.meta?.queued ?? 0) } : { linked: false, note: mac ? 'setup started but the Mac never checked in' : 'not linked' } },
    prefs,
    tasks: tasks.data ?? [], focus_sessions: sessions.data ?? [], checkins: checkins.data ?? [],
    claude_code: {
      sessions: sessionsList.length,
      prompts: sessionsList.reduce((n, g) => n + g.prompts.length, 0),
      by_session: sessionsList,
    },
    app_events: appEvents.data ?? [],
    history: history.data ?? [], ledger: ledger.data ?? [],
  };

  if (due.includes('weekly')) {
    const monday = addDays(friday, -4);
    const [{ data: dailies }, { data: outcome }] = await Promise.all([
      db.from('reports').select('day, scores, body_md').eq('user_id', uid).eq('kind', 'daily').gte('day', monday).lte('day', friday).order('day'),
      db.from('checkins').select('day, content, created_at').eq('user_id', uid).eq('kind', 'weekly_outcome').gte('day', monday).lte('day', today),
    ]);
    ctx.week = { monday, friday, daily_reports: dailies ?? [], outcome_entry: outcome ?? [] };
  }
  if (due.includes('monthly')) {
    const first = today.slice(0, 8) === lastOfMonth.slice(0, 8) ? today : lastOfMonth.slice(0, 8) + '01';
    const { data: month } = await db.from('reports').select('day, kind, scores').eq('user_id', uid).gte('day', first).lte('day', lastOfMonth).order('day');
    ctx.month = { from: first, to: lastOfMonth, reports: month ?? [] };
  }
  return ctx;
}

// PDF: plain, readable, one or two pages. Standard fonts only handle basic Latin, so text is simplified.
const pdfSafe = (t: string) => t
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
  .replace(/·/g, '-').replace(/→/g, '->').replace(/…/g, '...').replace(/−/g, '-')
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');

export async function makePdf(day: string, kind: string, scores: any, body: string) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const W = 595, H = 842, M = 56;
  const ink = rgb(0.1, 0.1, 0.12), quiet = rgb(0.38, 0.4, 0.45), accent = rgb(1, 0.42, 0.24);
  let page = doc.addPage([W, H]);
  let y = H - M;
  // Wraps text into the column; indent shifts it right (for quotes).
  const line = (text: string, f = font, size = 11, color = ink, gap = 5, indent = 0) => {
    const words = pdfSafe(text).split(/\s+/).filter(Boolean);
    const maxW = W - 2 * M - indent;
    let cur = '';
    const flush = () => {
      if (y < M + size) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(cur, { x: M + indent, y, size, font: f, color }); y -= size + gap; cur = '';
    };
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (f.widthOfTextAtSize(next, size) > maxW && cur) { flush(); cur = w; } else cur = next;
    }
    if (cur) flush();
  };
  const title = kind === 'daily' ? 'Daily report' : kind === 'weekly' ? 'Weekly report' : 'Monthly report';
  const nice = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  line('COACH', bold, 9, accent, 10);
  line(`${title}: ${nice}`, bold, 17, ink, 12);
  const overall = scores?.overall ?? scores?.weekly_score;
  if (overall != null) line(`${overall}  ${scores?.grade ?? ''}${scores?.provisional ? '   (provisional)' : ''}`, bold, 28, ink, 14);
  const dims = scores?.dimensions;
  if (dims) {
    const names: Record<string, string> = { execution: 'Execution (35%)', ai_work: 'AI applied to real work (20%)', prompting: 'Prompting skill (20%)', independence: 'Independence (25%)' };
    for (const k of Object.keys(names)) if (dims[k]) line(`${names[k]}: ${dims[k].score}. ${dims[k].why ?? ''}`, font, 9.5, quiet, 3);
    y -= 12;
  }
  for (const para of body.split(/\n{2,}/)) {
    const lines = para.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lines.length) continue;
    for (const ln of lines) {
      const head = ln.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      if (head) {
        line(head[1].replace(/[:.]$/, ''), bold, 11, ink, 4);
        if (head[2]) line(head[2].replace(/\*\*/g, ''), font, 11, ink, 5);
      } else if (ln.trimStart().startsWith('>')) {
        line(ln.replace(/^\s*>\s?/, '').replace(/\*\*/g, ''), italic, 10.5, quiet, 5, 14);
      } else {
        line(ln.replace(/\*\*/g, ''), font, 11, ink, 5);
      }
    }
    y -= 10;
  }
  return await doc.save();
}

async function saveReport(conn: any, b: any) {
  const kinds = ['daily', 'weekly', 'monthly'];
  if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.day)) || !kinds.includes(b.kind) || typeof b.body_md !== 'string' || !b.body_md.trim())
    return Response.json({ error: 'report needs day (YYYY-MM-DD), kind (daily|weekly|monthly), body_md and scores' }, { status: 400 });
  const scores = b.scores && typeof b.scores === 'object' ? b.scores : {};
  const uid = conn.user_id;

  let pdf_path: string | null = `${uid}/${b.day}-${b.kind}.pdf`;
  try {
    const bytes = await makePdf(b.day, b.kind, scores, b.body_md);
    const { error } = await db.storage.from('reports').upload(pdf_path, bytes, { contentType: 'application/pdf', upsert: true });
    if (error) { console.error('pdf upload', error); pdf_path = null; }
  } catch (e) { console.error('pdf', e); pdf_path = null; }

  const { data: rep, error } = await db.from('reports')
    .upsert({ user_id: uid, day: b.day, kind: b.kind, scores, body_md: b.body_md, pdf_path, connection_id: conn.id, created_at: new Date().toISOString() }, { onConflict: 'user_id,day,kind' })
    .select('id').single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Today's tasks, from the daily report, on workdays only
  let tasksSet = 0;
  const today = localNow().date;
  if (b.kind === 'daily' && Array.isArray(b.tasks) && b.tasks.length && isWorkday(today)) {
    await db.from('tasks').delete().eq('user_id', uid).eq('day', today).eq('source', 'claude').eq('status', 'pending');
    const rows = b.tasks.slice(0, 3).filter((t: any) => t?.title).map((t: any, i: number) => ({
      user_id: uid, day: today, title: String(t.title).slice(0, 200), done_criteria: t.done_criteria ? String(t.done_criteria).slice(0, 300) : null,
      time_box_min: Number(t.time_box_min) || null, source: 'claude', sort: i,
    }));
    const { error: te } = await db.from('tasks').insert(rows);
    if (te) console.error('tasks', te); else tasksSet = rows.length;
  }
  return Response.json({ ok: true, report_id: rep.id, pdf_path, tasks_set: tasksSet, tasks_day: tasksSet ? today : null });
}

Deno.serve(async (req) => {
  const problem = setup();
  if (problem) { console.error(problem); return Response.json({ error: problem }, { status: 500 }); }
  const token = req.headers.get('x-coach-token');
  if (token) {
    try { return await handleApi(req, token); } catch (e) { console.error(e); return Response.json({ error: String(e) }, { status: 500 }); }
  }
  if (req.headers.get('x-cron-secret') !== env('CRON_SECRET')) return Response.json({ error: 'wrong or missing x-cron-secret' }, { status: 403 });
  const url = new URL(req.url);
  // ?at=2026-11-03T03:30:00Z lets a test pretend it is another time
  const at = url.searchParams.get('at');
  const now = localNow(at ? new Date(at) : new Date());

  const { data: users, error } = await db.from('push_subscriptions').select('user_id');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const ids = [...new Set<string>((users ?? []).map((u: any) => String(u.user_id)))];

  // ?test=1 sends one notification to everyone, right now
  if (url.searchParams.get('test')) {
    const res: Record<string, string> = {};
    for (const id of ids) res[id] = await sendOnce(id, `test:${Date.now()}`, { title: 'Coach', body: 'Server notifications work.', tag: 'test' });
    return Response.json({ now, res });
  }

  const results: Record<string, unknown> = {};
  for (const id of ids) {
    const { data: p } = await db.from('notification_prefs').select('prefs').eq('user_id', id).maybeSingle();
    results[id] = await tickUser(id, p?.prefs ?? {}, now);
  }
  return Response.json({ now, results });
});
