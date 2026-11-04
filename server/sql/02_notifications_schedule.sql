-- Coach, Step 2 fix: point the 15-minute schedule at the function's real name (smooth-responder).
-- SQL Editor -> new tab -> paste all -> Run.
select cron.unschedule(jobid) from cron.job where jobname = 'coach-tick';
select cron.schedule(
  'coach-tick',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://ibgdvsdahuiclvkkqbtx.supabase.co/functions/v1/smooth-responder',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
