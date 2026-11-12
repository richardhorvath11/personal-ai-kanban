# BUILD_STATUS

## Current slice
Slice 2 — Session continuity: **complete**. Next: Slice 3 (automatic maintenance and recovery).

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

## Known limitations / unverified
- Hooks, outbox, background review and attention views not built yet (slices 3–4).

## Next actions
1. Slice 3: hook script (SessionStart/PostToolUse/Stop/SessionEnd), durable outbox with op IDs, drain on recovery, sync health in `/api/health` + UI, conflict handling tests.
