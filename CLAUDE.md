# Coach

Personal accountability app: a home-screen web app (this repo, served by GitHub Pages), a Supabase backend, a Mac connector for Claude Code, and a morning reviewer that runs in a Claude chat.

## Names and addresses (exact casing matters)

- GitHub repository: `amanrai33821/Coach` (capital C).
- App address: `https://amanrai33821.github.io/Coach/` (capital C). GitHub Pages paths are case-sensitive; never write `/coach/`.
- Mac installer: `https://amanrai33821.github.io/Coach/mac/install.sh`
- Supabase project ref: `ibgdvsdahuiclvkkqbtx` (project name "Coach"). API endpoint: `https://ibgdvsdahuiclvkkqbtx.supabase.co/functions/v1/smooth-responder`. The function's name is `smooth-responder` (Supabase picked it); scheduled jobs point at that name.

## Files

- `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.json`, `icons/`: the app. Bump `VERSION` in app.js and `CACHE` in sw.js on every release.
- `config.js`: public Supabase URL, publishable key and the public push key. Never put secret keys here.
- `mac/install.sh`: the Claude Code connector (hooks, offline queue, uploader).
