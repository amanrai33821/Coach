-- Coach: marks focus sessions the server stopped at 1:00 PM
alter table public.focus_sessions add column if not exists auto_stopped boolean not null default false;
