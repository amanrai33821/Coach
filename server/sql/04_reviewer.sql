-- Coach, Step 5: reviewer storage

-- Standing instructions and rules the reviewer reads at the start of every run.
-- Changing a row here changes the next review; the reviewer never needs redeploying.
create table if not exists public.coach_config (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.coach_config enable row level security;
drop policy if exists owner_read on public.coach_config;
create policy owner_read on public.coach_config for select using (user_id = auth.uid());

-- The living skills ledger
create table if not exists public.skills_ledger (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  skill          text not null,
  why            text,
  ladder         text check (ladder in ('claude_code', 'chat', 'design')),
  status         text not null default 'not_tried' check (status in ('proposed', 'not_tried', 'practising', 'habit', 'rejected')),
  evidence_count int not null default 0,
  source         text,
  added_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, skill)
);
alter table public.skills_ledger enable row level security;
drop policy if exists owner_all on public.skills_ledger;
create policy owner_all on public.skills_ledger for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Reports can be re-written for the same day (a re-run replaces the earlier one)
alter table public.reports add column if not exists connection_id uuid references public.connections(id) on delete set null;
