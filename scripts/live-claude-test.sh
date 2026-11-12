#!/usr/bin/env bash
# LIVE Claude Code integration test (uses your logged-in `claude` CLI subscription; never an API key).
# Creates a throwaway project + data dir, starts a separate board on port ${LIVE_PORT:-4319},
# installs the project-scoped integration, runs two bounded `claude -p` turns, and checks the board.
# Scenarios: Automatic checkpoint, Task switching, Safe completion.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="${CLAUDE_BIN:-$(command -v claude || echo "$HOME/.local/bin/claude")}"
PORT="${LIVE_PORT:-4319}"
URL="http://127.0.0.1:$PORT"
WORK="$(mktemp -d /tmp/kanban-live-XXXXXX)"
PROJ="$WORK/acme-export"; DATA="$WORK/data"; OUT="$WORK/out"
mkdir -p "$PROJ" "$DATA" "$OUT"
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CONTROL_HOOK_DISABLE=1   # keep any global (non-kanban) hooks from recording this run
TURN_TIMEOUT="${TURN_TIMEOUT:-300}"
log() { echo "[live] $*"; }

log "claude: $CLAUDE ($("$CLAUDE" --version 2>&1))"
log "work dir: $WORK"

node "$ROOT/src/server/main.ts" --port "$PORT" --data-dir "$DATA" > "$OUT/service.log" 2>&1 &
SVC_PID=$!
cleanup() { kill "$SVC_PID" 2>/dev/null; }   # exact PID only
trap cleanup EXIT
for _ in $(seq 1 50); do curl -sf "$URL/api/health" >/dev/null && break; sleep 0.2; done
log "board pid $SVC_PID at $URL"

cd "$PROJ"
git init -q && git config user.email engineer@local && git config user.name Engineer
cat > export.js <<'JS'
// Data export helpers
module.exports = {};
JS
echo "# acme-export" > README.md
git add -A && git commit -qm init

# LIVE_NO_CLAUDE_MD=1 installs without the CLAUDE.md instructions block, to exercise the Stop-hook nudge path.
node "$ROOT/src/cli/kanban.ts" install --project "$PROJ" --url "$URL" --data-dir "$DATA" ${LIVE_NO_CLAUDE_MD:+--no-claude-md} > "$OUT/install.log"
log "installed integration (${LIVE_NO_CLAUDE_MD:+without CLAUDE.md block; }hooks: $(node -pe 'Object.keys(require(process.argv[1]).hooks).join(",")' "$PROJ/.claude/settings.json"))"
H='-H content-type:application/json -H x-kanban-client:cli'
T1=$(curl -sf $H -X POST "$URL/api/tasks" -d '{"opId":"live-t1","title":"CSV export helper","project":"acme-export","status":"ready","completionConditions":["toCsv(rows) in export.js handles quoting","User accepts the output"],"nextAction":"Implement toCsv in export.js"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
T2=$(curl -sf $H -X POST "$URL/api/tasks" -d '{"opId":"live-t2","title":"README usage section","project":"acme-export","status":"ready","completionConditions":["README documents toCsv usage"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).task.id')
log "seeded $T1 (CSV export helper) and $T2 (README usage section)"

COMMON=(--mcp-config "$PROJ/.mcp.json" --strict-mcp-config --permission-mode acceptEdits --allowedTools "mcp__kanban__*,Read,Edit,Write,Glob,Grep" --output-format json)

# Turn 1: real work, no request to update the board.
P1="I'm working on the CSV export helper. Add a toCsv(rows) function to export.js that takes an array of objects and returns CSV text with a header row, quoting fields that contain commas, quotes or newlines. Export it. Keep it short."
log "turn 1 (automatic checkpoint) …"
timeout "$TURN_TIMEOUT" "$CLAUDE" -p "$P1" "${COMMON[@]}" > "$OUT/turn1.json" 2> "$OUT/turn1.err"; RC1=$?
SID=$(node -pe 'try{JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).session_id||""}catch{""}' "$OUT/turn1.json")
log "turn 1 exit $RC1, session $SID"
curl -sf "$URL/api/tasks/$T1?recent=50" > "$OUT/t1-after-turn1.json"
curl -sf "$URL/api/tasks/$T2?recent=50" > "$OUT/t2-after-turn1.json"

# Turn 2: switch task in the same session (resume), still no request to update the board.
P2="Thanks. Now switch to the README usage section task: add a short Usage section to README.md showing how to call toCsv."
log "turn 2 (task switching) …"
if [ -n "$SID" ]; then
  timeout "$TURN_TIMEOUT" "$CLAUDE" -p "$P2" --resume "$SID" "${COMMON[@]}" > "$OUT/turn2.json" 2> "$OUT/turn2.err"; RC2=$?
else RC2=99; fi
log "turn 2 exit $RC2"
sleep 1
curl -sf "$URL/api/tasks/$T1?recent=50" > "$OUT/t1-final.json"
curl -sf "$URL/api/tasks/$T2?recent=50" > "$OUT/t2-final.json"
curl -sf "$URL/api/health" > "$OUT/health.json"
cp "$DATA/runtime/hook-events.jsonl" "$OUT/hook-events.jsonl" 2>/dev/null

node "$ROOT/scripts/live-claude-verdict.mjs" "$OUT" "$T1" "$T2" "$SID" "$RC1" "$RC2" | tee "$OUT/verdict.txt"
log "artifacts in $OUT"
