# BUILD_STATUS

## Current slice
Slice 1 — Persistent board and MCP: **complete**. Next: Slice 2 (session continuity).

## Completed behavior
- SQLite data model (tasks, deps, activity log, idempotency ledger) with numbered migrations in `migrations/`, applied on open and via `npm run migrate`.
- Shared domain rules in `src/core/board.ts`: create (opId-idempotent), validated edit with revision checks (stale edits rejected only when they touch fields changed since that revision), status-transition rules (Waiting needs a reason; Done needs user confirmation or completion conditions + evidence; hooks can never change status), archive/restore, field-level undo, activity log, export.
- Local service `src/server/service.ts`: binds 127.0.0.1 only; Host-header check (DNS rebinding), Origin guard + JSON-only mutations, `x-kanban-client` required for non-browser writes.
- React UI (`src/ui`): board with 6 columns, project filter, search, cards (next action, deadline, waiting reason, freshness, pin), detail panel with all fields, checklist, findings, links, dependencies, activity history with Undo, archive view, create dialog, keyboard navigation, select-based status change (alternative to drag-and-drop), empty/error states.
- stdio MCP adapter `src/mcp/server.ts` (official SDK `@modelcontextprotocol/sdk` 1.32.2): `find_tasks`, `get_task`, `create_task`, `edit_task`; forwards to the service over loopback HTTP.
- Demo board isolated: `KANBAN_MODE=demo` uses a separate data dir/port and the DB is stamped with its mode; opening it with the other mode fails; demo seeding refuses real mode.

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

## Known limitations / unverified
- Session continuity, hooks, outbox, background review and attention views not built yet (slices 2–4).

## Next actions
1. Slice 2: sessions table, `link_session` / `record_checkpoint` / `get_session_context` MCP tools, project-scoped installer, CLAUDE.md instructions, test that one session's checkpoint is retrieved by another.
