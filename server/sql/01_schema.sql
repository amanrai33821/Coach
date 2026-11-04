-- Coach app: database setup
-- Run once in Supabase: SQL Editor -> New query -> paste all of this -> Run.
-- Safe to re-run: it only creates what is missing.

-- ---------- Tables ----------

-- Daily tasks (set by Claude, or by you on a swap)
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day           date not null,
  title         text not null,
  done_criteria text,
  time_box_min  int,
  status        text not null default 'pending'
                check (status in ('pending','done','skipped','swapped')),
  swapped_from  uuid references public.tasks(id) on delete set null,
  swap_reason   text,
  source        text not null default 'claude' check (source in ('claude','user')),
  sort          int not null default 0,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index if not exists tasks_user_day on public.tasks(user_id, day);

-- The 9-12 focus block (and any other timed sessions)
create table if not exists public.focus_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day          date not null,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  auto_started boolean not null default false
);
create index if not exists focus_user_day on public.focus_sessions(user_id, day);

-- The three touches: morning review, noon check-in, night log
create table if not exists public.checkins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day         date not null,
  kind        text not null check (kind in ('morning','noon','night','weekly_outcome')),
  content     jsonb not null default '{}'::jsonb,
  self_rating int check (self_rating between 1 and 10),
  created_at  timestamptz not null default now(),
  unique (user_id, day, kind)
);

-- Activity events: Claude Code hooks (from your Mac) and app actions
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  source      text not null check (source in ('claude_code','claude_chat','app')),
  kind        text not null,
  session_id  text,
  project     text,
  payload     jsonb not null default '{}'::jsonb
);
create index if not exists events_user_time on public.events(user_id, occurred_at);

-- Reports written by the review agent
create table if not exists public.reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  day        date not null,
  kind       text not null check (kind in ('daily','weekly','monthly')),
  scores     jsonb not null default '{}'::jsonb,
  body_md    text not null,
  pdf_path   text,
  audio_path text,
  created_at timestamptz not null default now(),
  unique (user_id, day, kind)
);

-- Where to send push notifications
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  keys       jsonb not null,
  created_at timestamptz not null default now()
);

-- Which notifications are on or off
create table if not exists public.notification_prefs (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  prefs      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Security: each row is visible only to its owner ----------

do $$
declare t text;
begin
  foreach t in array array['tasks','focus_sessions','checkins','events','reports','push_subscriptions','notification_prefs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format(
      'create policy owner_all on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- Private storage for report PDFs and audio ----------

insert into storage.buckets (id, name, public)
values ('reports', 'reports', false)
on conflict (id) do nothing;

drop policy if exists reports_owner_read on storage.objects;
create policy reports_owner_read on storage.objects for select
  using (bucket_id = 'reports' and (storage.foldername(name))[1] = auth.uid()::text);
