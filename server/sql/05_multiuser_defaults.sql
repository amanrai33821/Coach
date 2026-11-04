-- Coach: defaults shared by every user, and automatic setup for new sign-ups.

-- Shared defaults (the reviewer instructions). Clients cannot read or change this table.
create table if not exists public.coach_defaults (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.coach_defaults enable row level security;

-- Move the current instructions into the shared defaults. A per-user row in
-- coach_config still overrides the default, if one is ever needed.
insert into public.coach_defaults (key, value)
select 'reviewer_instructions', value from public.coach_config where key = 'reviewer_instructions' order by updated_at desc limit 1
on conflict (key) do update set value = excluded.value, updated_at = now();
delete from public.coach_config where key = 'reviewer_instructions';

-- Starting skills ledger for anyone who signs up
create or replace function public.coach_seed_user(uid uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.skills_ledger (user_id, skill, why, ladder, status, source)
  select uid, s.skill, s.why, s.ladder, 'not_tried', 'starting list'
  from (values
    ('Context files (CLAUDE.md)', 'Stop re-typing the same project context every session', 'claude_code'),
    ('Plan mode before building', 'Fewer wrong builds and less rework', 'claude_code'),
    ('Skills', 'Turn a repeated task into one command', 'claude_code'),
    ('Subagents', 'Split big jobs and keep the main thread focused', 'claude_code'),
    ('Connectors', 'Let Claude work with your real tools and data', 'chat'),
    ('Scheduled tasks', 'Recurring work that runs without you', 'chat'),
    ('Evals and acceptance tests', 'Define done before asking, then check the output against it', 'design')
  ) as s(skill, why, ladder)
  on conflict (user_id, skill) do nothing;
$$;
revoke all on function public.coach_seed_user(uuid) from public, anon, authenticated;

create or replace function public.coach_on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.coach_seed_user(new.id);
  return new;
end $$;

drop trigger if exists coach_on_new_user on auth.users;
create trigger coach_on_new_user after insert on auth.users
  for each row execute function public.coach_on_new_user();

-- Make sure everyone who already exists is seeded too
select public.coach_seed_user(id) from auth.users;
select (select count(*) from public.coach_defaults) as defaults, (select count(*) from public.coach_config where key = 'reviewer_instructions') as per_user_overrides;
