# Coach server

Everything that runs on Supabase (project ref `ibgdvsdahuiclvkkqbtx`, name "Coach", region eu-west-1).

- `function/index.ts`: the single Edge Function, deployed as **smooth-responder** (JWT verification off).
  - Called every 15 minutes by pg_cron (`x-cron-secret` header): alerts, 9:00 auto-start, 12:15/12:30 reminders, 1:00 PM auto-stop, 9:45 PM night log, report ready / reviewer missing, one-off reminders.
  - Called with `x-coach-token` (a pairing code; only its SHA-256 is stored in `connections`): the Mac connector (`hello`, `transcript`) and the reviewer (`hello`, `instructions`, `context`, `event`, `report`).
- `reviewer_instructions.md`: the reviewer's standing instructions and full rubric. The live copy is the row `coach_defaults.key = 'reviewer_instructions'`; update that row after editing this file.
- `sql/`: the database setup, in the order it was applied. `02_notifications_schedule.sql` has `<CRON_SECRET>` as a placeholder.

Secrets (in Supabase, Edge Functions > Secrets; never commit them): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `CRON_SECRET`.

Deploy (needs a Supabase personal access token in SUPABASE_ACCESS_TOKEN):

    mkdir -p supabase/functions/smooth-responder && cp server/function/index.ts supabase/functions/smooth-responder/index.ts
    npx supabase functions deploy smooth-responder --project-ref ibgdvsdahuiclvkkqbtx --use-api --no-verify-jwt
