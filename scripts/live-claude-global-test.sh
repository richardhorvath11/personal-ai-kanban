#!/usr/bin/env bash
# LIVE test of the GLOBAL (user-scope) install with the real `claude` CLI and your subscription login (never an API key).
# It temporarily installs into your REAL ~/.claude/settings.json, ~/.claude/CLAUDE.md and ~/.claude.json, so it:
#   1. refuses to run while any other `claude` process is running,
#   2. copies those three files to a backup dir first,
#   3. points the install at a separate throwaway board (port ${LIVE_PORT:-4321}, temp data dir),
#   4. runs two bounded `claude -p` turns from a fresh git project that has NO kanban/Claude files,
#   5. always runs `kanban uninstall --global` on exit and diffs the files against the backups.
# settings.json and CLAUDE.md must end byte-identical; if not, they are restored from the backup and the run FAILs.
# ~/.claude.json is also written by Claude Code itself during any session, so for it the script requires the
# mcpServers section to be identical and lists every other top-level key that changed.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
PORT="${LIVE_PORT:-4321}"
URL="http://127.0.0.1:$PORT"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CJ="$( [ -n "${CLAUDE_CONFIG_DIR:-}" ] && echo "$CLAUDE_CONFIG_DIR/.claude.json" || echo "$HOME/.claude.json")"
WORK="$(mktemp -d /tmp/kanban-live-global-XXXXXX)"
PROJ="$WORK/acme-export-wt"; DATA="$WORK/data"; OUT="$WORK/out"; BK="$WORK/backup"
mkdir -p "$PROJ" "$DATA" "$OUT" "$BK"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CONTROL_HOOK_DISABLE=1   # keep the other global (Control) hooks from recording this run
TURN_TIMEOUT="${TURN_TIMEOUT:-300}"
log() { echo "[live-global] $*"; }

if pgrep -x claude >/dev/null; then log "ABORT: another claude process is running (pids: $(pgrep -x claude | tr '\n' ' ')); not touching global config."; exit 2; fi
for f in "$CFG/settings.json" "$CFG/CLAUDE.md" "$CJ"; do
  if [ -e "$f" ]; then cp -p "$f" "$BK/$(basename "$f")"; else touch "$BK/$(basename "$f").absent"; fi
done
log "backed up global files to $BK"

node "$ROOT/src/server/main.ts" --port "$PORT" --data-dir "$DATA" > "$OUT/service.log" 2>&1 &
SVC_PID=$!
VERDICT_RC=1
cleanup() {
  node "$ROOT/src/cli/kanban.ts" uninstall --global > "$OUT/uninstall.log" 2>&1; log "uninstall: $(tr '\n' ' ' < "$OUT/uninstall.log")"
  kill "$SVC_PID" 2>/dev/null   # exact PID only
  local bad=0
  for f in "$CFG/settings.json" "$CFG/CLAUDE.md"; do
    b="$BK/$(basename "$f")"
    if [ -e "$b.absent" ]; then
      if [ -e "$f" ]; then log "FAIL $f exists but did not before"; rm -f "$f"; bad=1; else log "PASS $f absent before and after"; fi
    elif cmp -s "$b" "$f"; then log "PASS $f byte-identical to backup (sha256 $(sha256sum < "$f" | cut -c1-16))"
    else log "FAIL $f differs from backup; restoring it"; diff "$b" "$f" | head -20; cp -p "$b" "$f"; bad=1; fi
  done
  if cmp -s "$BK/$(basename "$CJ")" "$CJ"; then log "PASS $CJ byte-identical to backup"
  else
    node -e '
      const [a, b] = process.argv.slice(1).map((f) => JSON.parse(require("fs").readFileSync(f, "utf8")));
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      const mcpSame = JSON.stringify(a.mcpServers) === JSON.stringify(b.mcpServers);
      console.log(`[live-global] ${mcpSame ? "PASS" : "FAIL"} ~/.claude.json mcpServers identical to backup; keys Claude Code itself changed during the run: ${keys.join(", ") || "none"}`);
      process.exit(mcpSame ? 0 : 1);' "$BK/$(basename "$CJ")" "$CJ" || bad=1
  fi
  [ "$bad" = 0 ] || VERDICT_RC=1
  log "artifacts in $OUT"
  exit "$VERDICT_RC"
}
trap cleanup EXIT
for _ in $(seq 1 50); do curl -sf "$URL/api/health" >/dev/null && break; sleep 0.2; done
log "claude: $CLAUDE ($("$CLAUDE" --version 2>&1)); board pid $SVC_PID at $URL"

node "$ROOT/src/cli/kanban.ts" install --global --url "$URL" --data-dir "$DATA" > "$OUT/install.log" 2>&1 || { cat "$OUT/install.log"; exit 1; }
log "installed globally: $(grep -c updated "$OUT/install.log") file(s) updated"
(cd "$WORK" && "$CLAUDE" mcp get kanban > "$OUT/mcp-get.txt" 2>&1); log "claude mcp get kanban: $(grep -E 'Scope|Status' "$OUT/mcp-get.txt" | tr '\n' ' ')"

cd "$PROJ"
git init -q && git config user.email engineer@local && git config user.name Engineer
git remote add origin https://github.com/example/acme-export.git   # label comes from the remote, not the folder name
cat > export.js <<'JS'
// Data export helpers
module.exports = {};
JS
echo "# acme-export" > README.md
git add -A && git commit -qm init
log "project $PROJ has: $(ls -A | tr '\n' ' ')(no .mcp.json, no .claude, no CLAUDE.md)"
H='-H content-type:application/json -H x-kanban-client:cli'
T1=$(curl -sf $H -X POST "$URL/api/tasks" -d '{"opId":"liveg-t1","title":"CSV export helper","project":"acme-export","status":"ready","completionConditions":["toCsv(rows) in export.js handles quoting","User accepts the output"],"nextAction":"Implement toCsv in export.js"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
T2=$(curl -sf $H -X POST "$URL/api/tasks" -d '{"opId":"liveg-t2","title":"README usage section","project":"acme-export","status":"ready","completionConditions":["README documents toCsv usage"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
log "seeded $T1 and $T2 (project acme-export)"

# No --mcp-config / --strict-mcp-config: the kanban server must come from user scope.
COMMON=(--permission-mode acceptEdits --allowedTools "mcp__kanban__*,Read,Edit,Write,Glob,Grep" --output-format json)
P1="I'm working on the CSV export helper. Add a toCsv(rows) function to export.js that takes an array of objects and returns CSV text with a header row, quoting fields that contain commas, quotes or newlines. Export it. Keep it short."
log "turn 1 …"
timeout "$TURN_TIMEOUT" "$CLAUDE" -p "$P1" "${COMMON[@]}" > "$OUT/turn1.json" 2> "$OUT/turn1.err"; RC1=$?
SID=$(node -pe 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).session_id||""}catch{""}' "$OUT/turn1.json")
log "turn 1 exit $RC1, session $SID"
curl -sf "$URL/api/tasks/$T1?recent=50" > "$OUT/t1-after-turn1.json"
curl -sf "$URL/api/tasks/$T2?recent=50" > "$OUT/t2-after-turn1.json"
P2="Thanks. Now switch to the README usage section task: add a short Usage section to README.md showing how to call toCsv."
log "turn 2 …"
if [ -n "$SID" ]; then timeout "$TURN_TIMEOUT" "$CLAUDE" -p "$P2" --resume "$SID" "${COMMON[@]}" > "$OUT/turn2.json" 2> "$OUT/turn2.err"; RC2=$?; else RC2=99; fi
log "turn 2 exit $RC2"
sleep 1
curl -sf "$URL/api/tasks/$T1?recent=50" > "$OUT/t1-final.json"
curl -sf "$URL/api/tasks/$T2?recent=50" > "$OUT/t2-final.json"
curl -sf "$URL/api/sessions/$SID/context" > "$OUT/session-context.json"
cp "$DATA/runtime/hook-events.jsonl" "$OUT/hook-events.jsonl" 2>/dev/null
LABEL=$(node -pe 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).repo}catch{""}' "$OUT/session-context.json")
if [ "$LABEL" = "acme-export" ]; then echo "PASS  Project label from session cwd: session registered for repo \"$LABEL\" (folder is acme-export-wt)"; else echo "FAIL  Project label: got \"$LABEL\""; fi | tee "$OUT/label.txt"
node "$ROOT/scripts/live-claude-verdict.mjs" "$OUT" "$T1" "$T2" "$SID" "$RC1" "$RC2" | tee "$OUT/verdict.txt"
VERDICT_RC=${PIPESTATUS[0]}
grep -q '^PASS' "$OUT/label.txt" || VERDICT_RC=1
cd "$WORK"
