# BUILD_STATUS

## Current slice
**All four slices complete** on branch `build/v1`, not merged to `main`, which needs Richard's explicit OK. Slice 4 (attention and priority) is done and the live Claude Code test passed (3 runs).

## Completed behavior
- SQLite data model (tasks, deps, activity log, idempotency ledger) with numbered migrations in `migrations/`, applied on open and via `npm run migrate`.
- Shared domain rules in `src/core/board.ts`: create (opId-idempotent), validated edit with revision checks (stale edits rejected only when they touch fields changed since that revision), status-transition rules (Waiting needs a reason; Done needs user confirmation or completion conditions + evidence; hooks can never change status), archive/restore, field-level undo, activity log, export.
- Local service `src/server/service.ts`: binds 127.0.0.1 only; Host-header check (DNS rebinding), Origin guard + JSON-only mutations, `x-kanban-client` required for non-browser writes.
- React UI (`src/ui`): board with 6 columns, project filter, search, cards (next action, deadline, waiting reason, freshness, pin), detail panel with all fields, checklist, findings, links, dependencies, activity history with Undo, archive view, create dialog, keyboard navigation, select-based status change (alternative to drag-and-drop), empty/error states.
- stdio MCP adapter `src/mcp/server.ts` (official SDK `@modelcontextprotocol/sdk` 1.32.2): `find_tasks`, `get_task`, `create_task`, `edit_task`; forwards to the service over loopback HTTP.
- Demo board isolated: `KANBAN_MODE=demo` uses a separate data dir/port and the DB is stamped with its mode; opening it with the other mode fails; demo seeding refuses real mode.

- **Slice 2:** `sessions` / `session_tasks` tables (migration 002). Sessions are agent activity, separate from task status. MCP tools `get_session_context`, `link_session` (several tasks + explicit current task; switching updates it), `record_checkpoint` (atomic summary/next action/findings/links/checklist/status, findings attributed per session and append-only). A checkpoint with no current task and several (or zero) linked tasks fails with `ambiguous_target` + candidates instead of guessing.
- Session id discovery: explicit `sessionId`, `KANBAN_SESSION_ID`, or the runtime pid map written by the SessionStart hook (`<data>/runtime/claude-pid/<claude-pid>.json`, looked up by walking the adapter's parent processes).
- Project-scoped installer `npm run kanban -- install --project DIR` merges `.mcp.json`, `.claude/settings.json` hooks and a marked `CLAUDE.md` block (backups in `.claude/kanban-backups/`); `uninstall` removes exactly those entries. Global `~/.claude/settings.json` is never touched.

- **Slice 3:** lifecycle hook `src/hooks/hook.ts` (exec-form command hooks, schema checked against code.claude.com/docs/en/hooks for Claude Code 2.1.310):
  - `SessionStart` (startup|resume|clear|compact): registers the session, writes the pid map, drains the outbox, injects session id + current task / repo candidates as `additionalContext`.
  - `PostToolUse` (Edit|Write|MultiEdit|NotebookEdit): local-only dirty marker (no network, no model call).
  - `Stop`: drains outbox, sends a sync heartbeat (not meaningful progress), and if files changed since the last confirmed checkpoint returns `additionalContext` asking Claude to `record_checkpoint` if the work was meaningful. Once per batch; `stop_hook_active` respected; never changes status.
  - `SessionEnd`: best-effort session end (queued if offline); no status change.
- Durable outbox `src/core/outbox.ts`: fsync + atomic rename files with op IDs; deleted only after acknowledgement; rejected ops move to `failed/` and are surfaced in `/api/health` + UI with Retry; the service drains on start-up, every 10 s and on demand. MCP `record_checkpoint` / `create_task` return `acknowledged: false, queued: true` when offline — never a fake success.
- `kanban note T-n "text"` CLI for manual notes outside instrumented sessions (queues when offline).

- **Slice 4:** these features are implemented in `src/core/review.ts`, `src/core/dates.ts` and `src/server/attention-plugin.ts`, and run by the background review:
  - **Deadlines:** dates are explicit, firm or flexible, and have a time zone. `resolve_date` turns relative wording ("Friday", "tomorrow 3pm") into an ISO date in the configured time zone. It returns a question for ambiguous wording, such as "next Friday", today's weekday, or "soon".
  - **Dependency readiness:** tasks waiting only on dependencies move to Ready once those dependencies are Done, with the reason logged.
  - **Background review:** the review is deterministic, with no model calls. It runs every `reviewIntervalMinutes` and once at start-up to catch up. It flags overdue and soon-due deadlines, due follow-ups, neglected in-progress work (heartbeats don't count as progress), pending reviews, blocked work and pin conflicts. Repeats are consolidated in an `alerts` table (migration 003), and only you can snooze an alert. Each run is recorded in `review_runs`.
  - **Next work:** `get_next_work`, `/api/next` and the "Pick up next" view rank tasks by an explainable rule tuple: pins in your order, then firm deadline windows, then work that unblocks important commitments, then priority, then work already in progress. Every item shows its reasons. Blocked work is listed separately. With too little context, the view says so instead of inventing a ranking.
  - **Views:** `get_attention` and the "Needs your attention" view. "Changed since last visit" is also added.
  - Full README covering setup, MCP, project-scoped hook install and uninstall, the live test, and a demo walkthrough.

## Acceptance scenarios (brief §Acceptance Scenarios)

| # | Scenario | Status | Evidence |
|---|---|---|---|
| 1 | Persistent round trip | VERIFIED (automated) | `01`: MCP create → real Chrome UI edit → service restart → MCP read |
| 2 | Session continuity | VERIFIED (automated) | `02`: a second MCP stdio session after a restart gets the task, latest finding, conditions and next action |
| 3 | Automatic checkpoint | VERIFIED (live) + fixture | Live: Claude checkpointed T-1 without being asked, in 3/3 runs. Fixture `03`: Stop nudge fires once after edits and not after a checkpoint. The live nudge path never fired, because Claude checkpointed on its own first; live Stop ran and correctly did nothing |
| 4 | Task switching | VERIFIED (live) + automated | Live: after "switch to the README task" on `--resume`, checkpoints went to T-2 and T-1 was unchanged (3/3). `02`: ambiguity returns candidates |
| 5 | Retry after outage | VERIFIED (automated) | `03`: the checkpoint queues while the service is down, survives the process exiting, and is applied exactly once after restart |
| 6 | Concurrent updates | VERIFIED (automated) | `03`: a stale conflicting edit is rejected with the current revision; a retried opId doesn't duplicate |
| 7 | Priority control | VERIFIED (automated) | `04`: pins persist and come first; explanations name the deadline and dependency; conflicts are flagged |
| 8 | Waiting and freshness | VERIFIED (automated) | `04`: due follow-up and neglected work surface; heartbeat isn't progress; blocked work isn't recommended |
| 9 | Safe completion | VERIFIED (live) + automated | Live: Stop and SessionEnd never set Done. In the run without CLAUDE.md, Claude set Done on T-2 with completion evidence, which the rules allow. `03` [fixture]: hooks can't set Done; Done needs conditions plus evidence |
| 10 | Correction and undo | VERIFIED (automated) | `04` (API) + `05` (UI undo button): undo keeps later edits |
| 11 | Keyboard and UI states | VERIFIED (automated) | `05`: real Chrome covers keyboard create, move, reorder, empty and error states, and demo isolation |

## Live Claude Code test
- `scripts/live-claude-test.sh` uses `claude` 2.1.310 with the claude.ai subscription login, `ANTHROPIC_API_KEY` unset and `CONTROL_HOOK_DISABLE=1`. Each run uses a throwaway project, data dir and board on port 4319/4320, and runs 2 `claude -p` turns.
- Run 1 and run 2 (full install) PASS. Run 3 (`LIVE_NO_CLAUDE_MD=1`, so tool descriptions and hook context only) PASS.
- In every run all hooks fired (session-start ×2, post-tool-use ×2, stop ×2, session-end ×2). Logs: `/tmp/kanban-live-run1.log`, `/tmp/kanban-live-run2-full.log`, `/tmp/kanban-live-run3-nomd.log`.

## Technical decisions
- **Node 24 native TypeScript** (type stripping) for service, MCP adapter, hooks and tests: no build step, fast hook start-up. Vite builds only the React UI.
- **`node:sqlite`** (built in) instead of a native addon: no compile step; WAL mode.
- **Task IDs `T-n`** are short so Claude and the user can reference them.
- **Activity changes are field-level diffs** (list fields diffed by item id) so undo reverts only what still holds the undone value.
- **Stale-edit policy**: a stale `expectedRevision` is rejected with the current revision only if it touches a field changed since; non-overlapping edits merge.
- Default port 4317 (demo 4318); data dir `~/.local/share/personal-ai-kanban/{real,demo}`, overridable with `KANBAN_DATA_DIR` / `--data-dir`.

## Commands actually run (slice 1)
- `npx tsc -p .` → no errors.
- `npx vite build` → built `dist/ui`.
- `node --test test/01-persistent-roundtrip.test.ts` → 2 pass, 0 fail (real headless Chrome edits the card in the UI; service restarted; MCP stdio client reads the change).
- `node --test test/00-service-guard.test.ts` → 1 pass, 0 fail.

## Commands actually run (slice 2)
- `npx tsc -p .` → no errors.
- `node --test test/02-session-continuity.test.ts` → 3 pass, 0 fail (two real MCP stdio sessions across a service restart; task switching; ambiguity; installer merge/uninstall round trip).

## Commands actually run (slice 3)
- `npx tsc -p .` → no errors. `npm test` → 10 tests, 10 pass, 0 fail.
- Hook checks in `test/03-hooks-recovery.test.ts` are **fixture-based** (real hook processes fed JSON payloads shaped per the hooks reference); they are not a live Claude Code run.

## Commands actually run (slice 4)
- `npx tsc -p .` → no errors. `npx vite build` → OK.
- `npm test` → **16 tests, 16 pass, 0 fail** (about 12.6 s). This covers the real temp SQLite, the real MCP stdio transport and real headless Chrome.
- `bash scripts/live-claude-test.sh` ×3 → PASS (see above).

## Known limitations / unverified
- **The live Stop-hook nudge is only fixture-verified.** In the live runs Claude checkpointed before the nudge was needed.
- `resolve_date` time offsets use the zone's offset on that date. Times inside a DST transition hour are not handled specially.
- Background review runs only while the service runs; there is no OS-level scheduler. Missed intervals are caught up at start-up.
- Drag and drop works, but the automated tests drive status changes through the keyboard and select, not drag gestures.
- Work outside instrumented Claude sessions needs `kanban note` or a UI edit.

## Next actions
1. Richard reviews `build/v1` and decides whether to merge it into `main`.
2. Install into a real project: `npm run kanban -- install --project <repo>`.
3. Optional: an OS service unit (systemd user unit) so the board and review run at login.
