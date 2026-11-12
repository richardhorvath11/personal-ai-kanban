# Personal AI Kanban

A local, single-user kanban board that Claude Code keeps current while you work. Claude reads it to resume work and writes checkpoints after meaningful progress. A deterministic background review surfaces deadlines, due follow-ups, neglected work and pending reviews. You stay in control of commitments and priority.

- **Local only.** The service binds to `127.0.0.1`. Browser-facing writes are origin-guarded. It makes no cloud calls and calls no paid model API.
- **One source of truth.** One Node service owns the SQLite database and the domain rules. The React UI, the MCP adapter (stdio), the hooks and the background review all go through it.
- **Honest sync.** Updates generated while the board is down go to a durable local outbox and are applied once when it returns. Nothing is reported as synced before the service acknowledges it.

The product brief is [CLAUDE_BUILD_BRIEF.md](CLAUDE_BUILD_BRIEF.md). [BUILD_STATUS.md](BUILD_STATUS.md) records what was built and verified.

## Requirements

- Node.js **≥ 22.18** (tested on 24.22). The project uses Node's built-in TypeScript type stripping and `node:sqlite`, so there is no native addon or compile step.
- Claude Code CLI (tested on **2.1.310**) for the integration.
- Optional: Chrome or Chromium for the browser tests and screenshots. Set `CHROME_PATH` if it is not at `/usr/bin/google-chrome`.

## Quick start

```bash
npm install
npm start                 # builds the UI, then serves http://127.0.0.1:4317
```

Open <http://127.0.0.1:4317>. Your real board starts empty.

| Command | What it does |
|---|---|
| `npm start` | Build the UI and start the service on port 4317 (real data) |
| `npm run serve` | Start the service without rebuilding the UI |
| `npm run dev` / `npm run dev:ui` | Service with `--watch`; Vite dev UI on :5173 (set `KANBAN_DEV_ORIGINS=http://127.0.0.1:5173`) |
| `npm run demo` | **Demo board** on port 4318 with sample data, in a separate database |
| `npm run migrate` | Apply pending migrations (they also run automatically on start) |
| `npm run export -- out.json` | Export every table plus resolved tasks as JSON |
| `npm run kanban -- note T-3 "did X" --next "do Y"` | Manual note for work done outside Claude (queued if the board is down) |
| `npm test` | Integration tests: real temp SQLite, real MCP stdio transport, real headless browser |
| `npm run typecheck` | `tsc --noEmit` |

### Configuration

| Setting | Default | Override |
|---|---|---|
| Data directory | `~/.local/share/personal-ai-kanban/real` (demo: `…/demo`) | `KANBAN_DATA_DIR` or `--data-dir` |
| Port | 4317 (demo 4318) | `KANBAN_PORT` or `--port` |
| Time zone, review interval, freshness thresholds | `settings.json` in the data dir (created on first run) | edit the file and restart |

`settings.json` holds `timezone`, `reviewIntervalMinutes` (5), `staleDays` (3), `deadlineSoonDays` (3) and `reviewPendingDays` (2). The data directory also contains `kanban.db`, `outbox/` (pending, failed and dismissed updates) and `runtime/` (hook health and a pid-to-session map). Nothing in it holds credentials or transcripts.

**Demo isolation.** Each database is stamped with its mode the first time it opens. A real service refuses a demo database and the reverse. Demo seeding is rejected on the real board.

## Connect Claude Code (project-scoped)

Install the integration into each repository where you want Claude to use the board:

```bash
npm run kanban -- install --project /path/to/your/repo [--url http://127.0.0.1:4317] [--data-dir DIR]
```

The installer merges the following into that project and never edits `~/.claude/settings.json`:

1. **`.mcp.json`**: adds a `kanban` stdio server (`node <this repo>/src/mcp/server.ts`). Other servers stay as they are.
2. **`.claude/settings.json`**: adds command hooks in exec form (`command` plus `args`) next to any hooks already there:
   - `SessionStart` (startup|resume|clear|compact): registers the session, loads context, drains the outbox.
   - `PostToolUse` (Edit|Write|MultiEdit|NotebookEdit): writes a local "files changed" marker. No network call and no model call.
   - `Stop`: drains the outbox and sends a sync heartbeat. If files changed since the last confirmed checkpoint, it asks Claude once to record a checkpoint, and only if the work was meaningful.
   - `SessionEnd`: best-effort session end.
3. **`CLAUDE.md`**: adds a marked instruction block that tells Claude when to load context, link tasks, checkpoint, and never treat a finished response as Done.

The installer saves a copy of each file it changes in `.claude/kanban-backups/` and lists what it added in `.claude/kanban-install.json`. Opening `claude` interactively in that project asks you to approve the `kanban` MCP server the first time.

Remove the integration:

```bash
npm run kanban -- uninstall --project /path/to/your/repo
```

This removes exactly the `kanban` server, our hook handlers and the marked block. Turn the hooks off without uninstalling by setting `KANBAN_HOOK_DISABLE=1`. Turn off every hook for one run with `claude --settings '{"disableAllHooks": true}'`.

To register only the MCP server without hooks, use `claude mcp add --scope project kanban -e KANBAN_URL=http://127.0.0.1:4317 -- node /path/to/personal-ai-kanban/src/mcp/server.ts`, or run the installer with `--no-hooks`.

### MCP tools

| Tool | Purpose |
|---|---|
| `find_tasks` | Filter by project, status and text. Returns compact results |
| `get_task` | Summary, next action, completion conditions, findings, dependencies, recent activity and revision |
| `create_task` | Durable create. The `opId` makes retries safe. Queued locally if the board is down |
| `edit_task` | Validated field changes with `expectedRevision`. Rejects a stale edit that conflicts with newer changes and returns the current revision |
| `record_checkpoint` | Atomic progress record: summary, next action, findings, links, checklist and a justified status change. Queued (`acknowledged: false`) if the board is down |
| `link_session` / `get_session_context` | Link the session and repo to tasks, with an explicit current task; resume context |
| `get_next_work` / `get_attention` | Explainable recommendations, blocked work, pin conflicts, due follow-ups, neglected work |
| `resolve_date` | Turns "Friday" or "tomorrow 3pm" into an explicit date in your time zone, or returns the question to ask when the wording is ambiguous |

Rules the service enforces:

- Moving to **Waiting** requires a reason.
- **Done** requires your confirmation in the UI, or recorded completion conditions plus `completionEvidence` from Claude.
- Hooks can never change task status.
- A checkpoint with no current task and several candidate tasks is rejected with the candidates (`ambiguous_target`). The service never guesses from titles or the repo name.

## Using the board

- **Board:** six columns (Inbox, Ready, In progress, Waiting, Review, Done) with a project filter and search. Cards show the next action, deadline, waiting reason, pin and freshness.
- **Moving cards:** drag and drop, the Status select in the detail panel, or the keyboard. Arrow keys move focus, `Shift+←/→` changes status, `Alt+↑/↓` reorders, `Enter` opens a card, `Esc` closes it, `n` creates a task, `/` searches and `1`–`5` switch views.
- **Detail panel:** every field, plus checklist, findings, links and dependencies. The activity history has an **Undo** on each entry. Undo works field by field: it reverts a field only if the field still holds the value that entry set, so later edits are kept.
- **Pick up next:** pins first, in your order. After that, firm deadlines, work that unblocks important commitments, then priority, with the reasons shown. Blocked work is listed separately. A pin that conflicts with a commitment is flagged and never silently overridden.
- **Needs your attention:** overdue and soon-due deadlines, due follow-ups (a reminder to check; nothing is sent to anyone), neglected in-progress work, pending reviews and blocked items. Repeats are consolidated and can be snoozed.
- **Changed since last visit:** a summary of the activity log since you last opened that view.
- **Sync bar:** pending and failed queued updates, the last error, active Claude sessions and the last checkpoint, with **Retry now**.

Background review runs every `reviewIntervalMinutes` while the service is running and once at start-up to catch up. Nothing runs while the service is stopped.

## Demonstration walkthrough

1. `npm run demo`, then open <http://127.0.0.1:4318>. The demo board is marked **DEMO DATA** and reuses the brief's example: the export API blocks the frontend needed for Friday's demo, and the test investigation sits in Inbox.
2. **Pick up next** shows: *Finish "Export API…": it unblocks "Export button in frontend" needed for Friday's demo.*
3. Pin another Ready card in its detail panel. It moves first, and the frontend task shows a pin conflict.
4. Change a field, then undo an earlier entry from the activity history. Only the fields that weren't changed again are reverted.
5. Stop the service, call `record_checkpoint` from Claude (or run `npm run kanban -- note …`), and start the service again. The queued update is applied once.

## Live Claude Code test

`scripts/live-claude-test.sh` runs the real `claude` CLI with your subscription login. It unsets `ANTHROPIC_API_KEY` and sets `CONTROL_HOOK_DISABLE=1`. It creates a throwaway git project and data dir, starts a separate board on port 4319, installs the integration, seeds two tasks, and runs two bounded `claude -p` turns: a real coding request, then "switch to the README task" with `--resume`. Neither prompt asks Claude to update the board. `scripts/live-claude-verdict.mjs` then checks the board:

```bash
bash scripts/live-claude-test.sh                  # full integration
LIVE_NO_CLAUDE_MD=1 LIVE_PORT=4320 bash scripts/live-claude-test.sh   # without the CLAUDE.md block
```

Manual version: start the board, `npm run kanban -- install --project <repo>`, open `claude` in that repo, approve the `kanban` server, and describe some work without mentioning the board. Then check that the card's activity shows a `claude` checkpoint, that "switch to <other task>" moves later checkpoints to that card, and that ending the session leaves the status unchanged.

## Architecture

```
src/core/      board.ts (domain rules, idempotency, revisions, undo) · sessions.ts · review.ts (attention + next work)
               dates.ts · outbox.ts / deliver.ts (durable queue) · db.ts (migrations) · config.ts · client.ts
src/server/    service.ts (HTTP, loopback, origin guard, static UI) + plugins: sessions, sync, attention, demo
src/mcp/       server.ts: stdio MCP adapter (official @modelcontextprotocol/sdk), forwards to the service
src/hooks/     hook.ts: Claude Code lifecycle hook (bounded, offline-tolerant)
src/cli/       kanban.ts: migrate | export | note | install | uninstall
src/ui/        React + Vite UI
migrations/    001_tasks.sql, 002_sessions.sql, 003_alerts.sql
test/          integration tests (node:test)
```

## Not in this release

Team accounts, billing, cloud hosting, desktop packaging, mobile apps, Jira, Slack or email connectors, autonomous code execution started from the board, and multi-agent orchestration. Work outside instrumented Claude sessions needs a manual note (`kanban note`) or a UI edit.
