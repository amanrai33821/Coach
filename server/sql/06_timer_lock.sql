-- Coach: the focus timer cannot be started after 1:00 PM (India time).
-- Enforced in the database, so no app version or mistaken tap can create a late session.
create or replace function public.coach_focus_window() returns trigger
language plpgsql as $$
begin
  if (now() at time zone 'Asia/Kolkata')::time >= time '13:00' then
    raise exception 'The focus timer is closed after 1:00 PM. It opens again at 9:00 tomorrow.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists coach_focus_window on public.focus_sessions;
create trigger coach_focus_window before insert on public.focus_sessions
  for each row execute function public.coach_focus_window();
select 'ok' as done;
