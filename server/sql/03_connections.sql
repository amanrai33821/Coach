-- Coach, Steps 3 and 4: connections (your Mac and your Claude account)
-- SQL Editor -> new tab -> paste all -> Run. Safe to re-run.

-- Each linked device or account gets its own pairing code.
-- Only a fingerprint (hash) of the code is stored, never the code itself.
create table if not exists public.connections (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('mac', 'claude')),
  label        text,
  token_hash   text not null unique,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists connections_user on public.connections(user_id, kind);
alter table public.connections enable row level security;
drop policy if exists owner_all on public.connections;
create policy owner_all on public.connections for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Lets uploads from your Mac be sent twice without creating duplicates
alter table public.events add column if not exists ext_id text;
alter table public.events add column if not exists connection_id uuid references public.connections(id) on delete set null;
create unique index if not exists events_user_ext on public.events(user_id, ext_id);
