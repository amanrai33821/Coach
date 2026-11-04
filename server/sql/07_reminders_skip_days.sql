-- Coach: one-off reminders, and days excluded from scoring.
create table if not exists public.reminders (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null,
  title   text not null,
  body    text not null,
  url     text,
  sent_at timestamptz
);
alter table public.reminders enable row level security;
drop policy if exists owner_read on public.reminders;
create policy owner_read on public.reminders for select using (user_id = auth.uid());

