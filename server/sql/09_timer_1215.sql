-- Coach: the focus timer cannot be started after 12:15 PM (India time). Replaces the 1:00 PM lock.
create or replace function public.coach_focus_window() returns trigger
language plpgsql as $$
begin
  if (now() at time zone 'Asia/Kolkata')::time >= time '12:15' then
    raise exception 'The focus timer is closed after 12:15. It opens again at 9:00 tomorrow.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;
select 'ok' as done;
