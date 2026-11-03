#!/bin/bash
# Coach Mac connector: sends your Claude Code activity to your Coach database.
#   Install:    curl -fsSL https://amanrai33821.github.io/Coach/mac/install.sh | bash -s -- <PAIRING_CODE>
#   Uninstall:  curl -fsSL https://amanrai33821.github.io/Coach/mac/install.sh | bash -s -- --uninstall
# What it does:
#   - adds a small hook to Claude Code that runs when Claude finishes a reply or a session ends
#   - the hook saves the new lines of that conversation to ~/.coach/queue (works offline)
#   - an uploader sends the queue to your database, and retries every 30 minutes
# It touches nothing else. Your ~/.claude/settings.json is backed up before it is changed.
set -euo pipefail

ENDPOINT="${COACH_ENDPOINT_OVERRIDE:-https://ibgdvsdahuiclvkkqbtx.supabase.co/functions/v1/smooth-responder}"
COACH_DIR="$HOME/.coach"
SETTINGS="$HOME/.claude/settings.json"
PLIST="$HOME/Library/LaunchAgents/com.coach.flush.plist"
VERSION="1.0.0"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '\n\033[31mCoach setup stopped:\033[0m %s\n' "$*" >&2; exit 1; }

edit_settings() { # $1 = add | remove
  mkdir -p "$HOME/.claude"
  [ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.coach-backup"
  /usr/bin/env python3 - "$SETTINGS" "$COACH_DIR/hook.sh" "$1" <<'PY'
import json, os, sys
path, hook, mode = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path) as f:
        data = json.load(f)
hooks = data.setdefault("hooks", {})
for event in ("Stop", "SessionEnd"):
    groups = [g for g in hooks.get(event, [])
              if not any(".coach/hook.sh" in str(h.get("command", "")) for h in g.get("hooks", []))]
    if mode == "add":
        groups.append({"hooks": [{"type": "command", "command": hook, "timeout": 10}]})
    if groups:
        hooks[event] = groups
    else:
        hooks.pop(event, None)
if not hooks:
    data.pop("hooks", None)
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)
PY
}

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing the Coach connector"
  if [ -f "$SETTINGS" ]; then edit_settings remove; ok "Removed the Claude Code hook"; fi
  if [ "$(uname)" = "Darwin" ] && [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; ok "Removed the background uploader"
  fi
  rm -rf "$COACH_DIR"; ok "Removed ~/.coach"
  say "Done. To also stop the database accepting this Mac, tap Disconnect in the Coach app."
  exit 0
fi

TOKEN="${1:-}"
[[ "$TOKEN" =~ ^coach_mac_[A-Za-z0-9_-]{20,}$ ]] || fail "this needs the pairing code from the Coach app. Copy the whole command from Settings → Link Mac and try again."
command -v curl >/dev/null || fail "curl is missing, which is unusual on a Mac."
/usr/bin/env python3 -c 'import json' 2>/dev/null || fail "Python 3 is needed once, to edit Claude Code's settings safely. Run:  xcode-select --install  then run the Coach command again."

say "Setting up the Coach connector"

mkdir -p "$COACH_DIR/queue" "$COACH_DIR/offsets"
chmod 700 "$COACH_DIR"
umask 077
cat > "$COACH_DIR/config" <<EOF
COACH_ENDPOINT="$ENDPOINT"
COACH_TOKEN="$TOKEN"
COACH_VERSION="$VERSION"
EOF
ok "Saved your pairing code to ~/.coach (only your user can read it)"

# --- The hook: Claude Code runs this after each reply and when a session ends.
# It only copies the new lines of the conversation into the queue, then returns.
cat > "$COACH_DIR/hook.sh" <<'HOOK'
#!/bin/bash
# Coach hook. Never blocks Claude Code: any problem here is ignored.
COACH_DIR="$HOME/.coach"
input=$(cat 2>/dev/null) || exit 0
tp=$(printf '%s' "$input" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
tp="${tp/#\~/$HOME}"
[ -n "$tp" ] && [ -f "$tp" ] || exit 0
[ -n "$sid" ] || sid=$(basename "$tp" .jsonl)
sid=$(printf '%s' "$sid" | tr -cd 'A-Za-z0-9_-')
off_file="$COACH_DIR/offsets/$sid"
prev=$(cat "$off_file" 2>/dev/null || echo 0)
total=$(wc -l < "$tp" | tr -d ' ')
if [ "${total:-0}" -gt "${prev:-0}" ] 2>/dev/null; then
  stamp="$(date +%Y%m%d%H%M%S)_$$"
  tail -n +"$((prev + 1))" "$tp" | head -n "$((total - prev))" \
    | split -l 800 - "$COACH_DIR/queue/${stamp}_${sid}_" 2>/dev/null
  echo "$total" > "$off_file"
fi
( "$COACH_DIR/flush.sh" >/dev/null 2>&1 & ) 2>/dev/null
exit 0
HOOK

# --- The uploader: sends queued files, oldest first; stops at the first failure
# and leaves the rest for the next try. Also says hello so the app shows "last seen".
cat > "$COACH_DIR/flush.sh" <<'FLUSH'
#!/bin/bash
COACH_DIR="$HOME/.coach"
. "$COACH_DIR/config" 2>/dev/null || exit 0
lock="$COACH_DIR/.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # a stale lock older than 10 minutes is removed
  if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null; mkdir "$lock" 2>/dev/null || exit 0; else exit 0; fi
fi
trap 'rmdir "$lock" 2>/dev/null' EXIT
for f in $(ls "$COACH_DIR/queue" 2>/dev/null | sort); do
  path="$COACH_DIR/queue/$f"
  [ -s "$path" ] || { rm -f "$path"; continue; }
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 60 -X POST "$COACH_ENDPOINT" \
    -H "x-coach-token: $COACH_TOKEN" -H "x-coach-action: transcript" \
    -H "Content-Type: text/plain" --data-binary @"$path")
  if [ "$code" = "200" ]; then rm -f "$path"; else
    echo "$(date '+%F %T') upload of $f failed: HTTP $code" >> "$COACH_DIR/upload.log"; break
  fi
done
queued=$(ls "$COACH_DIR/queue" 2>/dev/null | wc -l | tr -d ' ')
device=$(scutil --get ComputerName 2>/dev/null || hostname)
curl -s -o /dev/null -m 20 -X POST "$COACH_ENDPOINT" -H "x-coach-token: $COACH_TOKEN" -H "x-coach-action: hello" \
  -H "Content-Type: application/json" \
  --data "{\"device\":\"${device//\"/}\",\"os\":\"$(uname -sr)\",\"version\":\"$COACH_VERSION\",\"queued\":\"$queued\"}" || true
FLUSH
chmod 700 "$COACH_DIR/hook.sh" "$COACH_DIR/flush.sh"
ok "Installed the hook and the uploader"

edit_settings add
ok "Connected the hook to Claude Code (backup: ~/.claude/settings.json.coach-backup)"

# Upload the last 2 days of Claude Code sessions once, so your first report has data.
backfilled=0
if [ -d "$HOME/.claude/projects" ]; then
  while IFS= read -r tp; do
    sid=$(basename "$tp" .jsonl | tr -cd 'A-Za-z0-9_-')
    total=$(wc -l < "$tp" | tr -d ' ')
    [ "${total:-0}" -gt 0 ] || continue
    split -l 800 "$tp" "$COACH_DIR/queue/00000000000000_${sid}_" 2>/dev/null || true
    echo "$total" > "$COACH_DIR/offsets/$sid"
    backfilled=$((backfilled + 1))
  done < <(find "$HOME/.claude/projects" -name '*.jsonl' -mtime -2 2>/dev/null)
fi
ok "Queued $backfilled recent Claude Code session(s) for upload"

if [ "$(uname)" = "Darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.coach.flush</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$COACH_DIR/flush.sh</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST" 2>/dev/null || true
  ok "Started the background uploader (every 30 minutes, and at login)"
fi

say "Uploading now…"
"$COACH_DIR/flush.sh" >/dev/null 2>&1 || true
left=$(ls "$COACH_DIR/queue" 2>/dev/null | wc -l | tr -d ' ')
if [ "$left" = "0" ]; then ok "Everything uploaded"; else
  printf '  ! %s file(s) still waiting; they will retry automatically. Details: ~/.coach/upload.log\n' "$left"
fi
echo
say "Done. Your Mac is linked. Check the Coach app: Settings → Connections should tick itself off."
