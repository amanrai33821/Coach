-- Coach, Step 2: scheduled notifications
-- Run ONCE in Supabase: SQL Editor -> New query -> paste all -> Run.
-- Do this only AFTER the "tick" Edge Function is deployed (see the setup guide).

-- 1. A log so each alert is sent at most once
create table if not exists public.notification_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  key     text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.notification_log enable row level security;
drop policy if exists owner_read on public.notification_log;
create policy owner_read on public.notification_log for select using (user_id = auth.uid());

