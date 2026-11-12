Personal AI Kanban — Claude Code build brief

Version: 1.0 · November 11, 2026

This file is a self-contained handoff. The product intent below comes from the user’s conversation. Technical defaults and scope boundaries are proposed implementation choices, not earlier user decisions. Favor a working personal tool and document changes to these defaults.

Kickoff prompt

Paste this into Claude Code from the project directory containing this file:

Read CLAUDE_BUILD_BRIEF.md and any existing repository instructions.
Inspect the repository, then summarize the intended behavior, assumptions,
and implementation plan. Create a short persistent build checklist and
proceed with implementation in the slices described in the brief.
Make reasonable, reversible technical choices and record them. Ask only
when a missing decision materially changes the product or blocks progress.
Continue through implementation and verification; do not stop after planning
or after the first slice. Keep BUILD_STATUS.md current so another session
can resume. At the end, demonstrate what works, report actual test results,
and distinguish simulated integration checks from a live Claude Code test.

1. Product intent

Build a personal kanban board that Claude Code keeps current as the user works. The user supplies work and context naturally: tasks, findings, urgent deadlines, changing priorities, and things to revisit. The system preserves commitments and progress across repositories and Claude sessions.

Core promise: I can work normally with Claude, switch contexts, and return to a trustworthy view of what matters, where each task stands, and what to do next.

The board is durable shared context. Claude both reads it to resume work and writes to it when meaningful progress occurs. A background process surfaces due dates, follow-ups, and stale work. The user retains control of commitments and priority.

Concrete example

User: “I need the export feature ready for Friday’s demo. The API change blocks the frontend. Also, I should investigate those intermittent test failures.”

Expected behavior:

1. Capture an export task with an explicit demo deadline and completion conditions. Model API/frontend dependencies if they are separate actionable tasks; use checklist items for small steps.
2. Capture the test investigation as an inbox item rather than silently making it an urgent commitment.
3. Bind the current coding session to the appropriate task.
4. After meaningful work, record: “API implementation complete. Integration tests passing. Large-export pagination is unresolved. Next: fix pagination, then connect the frontend.”
5. Another session can retrieve that state and continue.
6. A later deadline or dependency change affects the recommendation with a visible explanation.

2. Scope for the first release

Deliver one usable end-to-end application:

• One user’s board, with project labels and filters across repositories.
• Durable task creation, editing, status changes, archiving, and recovery from accidental changes.
• A detail panel containing the current summary, next action, completion conditions, findings, dependencies, and an expandable activity history.
• A functional MCP server for Claude to read and update the same task data as the UI.
• Claude integration instructions plus lifecycle hooks for loading context and checkpoint synchronization.
• A local background review for deadlines, waiting follow-ups, stale activity, and pending reviews.
• An explainable “What should I pick up next?” view and a “Needs your attention” view.
• Visible synchronization health and a retry path for failed updates.

Defer team accounts, billing, cloud hosting, native desktop packaging, mobile apps, Jira/Slack/email connectors, autonomous code execution launched from the board, and multi-agent orchestration infrastructure. Capture these as possible later work without implementing them.

Work outside instrumented Claude sessions requires a manual note in this release. Background checks run while the local service is running and catch up on restart; closing a laptop does not leave an always-on service elsewhere.

3. Technical defaults and operating model

Inspect the existing repository first. Reuse an appropriate existing stack. In an empty repository, default to TypeScript, a React browser UI, a Node service, SQLite, and the current official MCP SDK. Choose maintained dependencies and check their current primary documentation before relying on APIs.

Keep the architecture small:

• One local service owns durable storage and shared domain rules.
• The UI, background review, and MCP adapter use those same rules.
• A stdio MCP adapter may forward requests to that service, allowing several Claude sessions to connect without independently implementing task logic.
• Keep hook-side recovery simple: a durable local outbox with unique operation IDs is sufficient. A remote queue or distributed event system is unnecessary.
• Use ordinary task tables plus an activity log; full event sourcing is unnecessary.
• Bind local endpoints to loopback and guard browser-facing mutations against unexpected origins. Keep credentials and raw transcripts out of task records and logs.
• Core operation should use the user’s existing Claude Code sessions. Do not require a separate paid model API for the initial background review; deterministic rules can evaluate structured context.

Provide documented development/start commands, migrations, a configured data directory, and data export. Keep demo data isolated from real tasks. Do not publish or deploy as part of this task.

4. Board behavior and data

Statuses

|Status     |Meaning                                                |
|-----------|-------------------------------------------------------|
|Inbox      |Captured work that has not been committed or sorted    |
|Ready      |Intended work that can be started                      |
|In progress|Work is underway, possibly paused between sessions     |
|Waiting    |A dependency, person, or external event blocks progress|
|Review     |An output is ready for inspection or acceptance        |
|Done       |The task’s stated completion conditions are satisfied  |

Keep task status separate from agent activity. A task can remain In progress when no Claude process is currently running. A closed session must not automatically mark its task Done or Waiting.

Minimum task information

• Stable ID, title, project/repository association, and status.
• Desired outcome and completion conditions.
• Current concise progress summary and next action.
• Optional checklist, useful findings, artifact/PR links, and dependencies.
• Optional deadline, whether it is firm or flexible, and the user’s time zone.
• Explicit priority/pin and relevant user-supplied priority context.
• Waiting reason and optional follow-up date or condition.
• Last meaningful activity, last synchronization, and a revision for safe updates.

Activity entries record what changed, who or which session supplied it, and when. Preserve user instructions with a short source note where relevant. Full conversation storage, percentage-complete estimates, and elaborate provenance graphs are unnecessary.

Relative deadlines must resolve to an explicit date in the user’s configured time zone. Preserve date-only deadlines as date-only values. Ask when wording is genuinely ambiguous rather than inventing a commitment.

Interaction expectations

• Show a compact board with readable cards and project filtering.
• Support moving cards and editing fields through normal controls, including an alternative to drag-and-drop.
• Make the next action, deadline, waiting reason, and freshness easy to find.
• Provide a concise “changed since last visit” view using the activity log.
• Show meaningful milestones, such as “implementation complete; integration testing pending.”
• Allow corrections and undo. Undo must respect intervening edits instead of blindly replacing an entire card with an old snapshot.

5. Claude integration contract

Design a small, typed MCP interface. Exact tool names are flexible; required capabilities are:

|Capability              |Expected behavior                                                                                   |
|------------------------|----------------------------------------------------------------------------------------------------|
|Find tasks              |Filter/search by project, state, and text; return compact results                                   |
|Read task/context       |Return summary, next action, completion conditions, dependencies, and relevant recent changes       |
|Create task             |Create a durable task with an operation ID that makes retries safe                                  |
|Edit task               |Apply validated field changes and return the resulting revision                                     |
|Record checkpoint       |Atomically record meaningful progress, findings, next action, links, and any justified status change|
|Link session            |Associate session ID and repository/worktree context with task IDs                                  |
|Read attention/next work|Return actionable candidates and understandable reasons                                             |

Session links may include several tasks with an explicit current task. When switching tasks, update that association. Do not guess the target solely from similar titles or the repository directory. When multiple plausible targets remain, request a task selection once.

MCP writes must validate inputs, reject missing targets and invalid transitions, and return useful errors. Retries with the same operation ID must not create duplicate cards or activity. Reject stale conflicting edits with the current revision so the client can refresh and reconcile. Unrelated sessions must not overwrite each other’s findings.

Automatic checkpoint flow

Use two complementary mechanisms:

1. Session instructions tell Claude to retrieve task context when starting or switching work, and to record concise checkpoints after meaningful progress, blockers, or changed findings. It should not need the user to say “update my board” repeatedly.
2. Lifecycle hooks load context and trigger/check synchronization at suitable boundaries. Verify hook events, supported handlers, and output formats against the installed Claude Code version before generating configuration.

A hook event establishes that something happened, not what it means. Claude supplies semantic summaries; hook scripts provide reliable delivery and checking. A Stop event is a response boundary, not proof of task completion. Avoid a new model call after every file edit.

Use bounded hook execution, avoid recursive MCP/hook loops, and do not hold normal coding hostage when the board is offline. Persist already-generated pending updates locally, show the outage, and retry when the service returns. Never report synchronization as successful before acknowledgement. An abrupt process exit can lose changes since the last checkpoint; expose the last confirmed checkpoint honestly.

On resume, retrieve the current task revision before continuing. On a normal session boundary, attempt a checkpoint if there were meaningful changes. Treat session-end handling as best effort rather than the sole save mechanism.

Provide project-scoped setup instructions/configuration that preserve existing hook settings. Do not silently replace the user’s global Claude configuration. Include a disable/uninstall path for the integration.

What may be inferred

• Explicit requests or commitments can become tasks automatically.
• Tentative suggestions can enter Inbox without becoming committed priorities.
• Progress and findings can update automatically when linked to an identified task.
• Claude may move work to Review when an output is ready.
• Done requires task-specific completion conditions supported by recorded results or the user’s confirmation. A research note may be done when delivered; shipping a feature may require acceptance or deployment. Do not impose a universal merge requirement.
• User-set deadlines, pins, and explicit ordering remain authoritative until the user changes them.

6. Priority and follow-up behavior

Use understandable rules initially, with Claude translating conversational context into structured updates. Avoid invented effort estimates, arbitrary urgency scores, or automatic constant reshuffling.

Honor explicit ordering and pins. Among other actionable tasks, consider firm deadlines, stated importance, dependencies that unblock important work, and due follow-ups. Show why a recommendation was made. Flag conflicts between a pin and an approaching commitment; do not silently override the pin.

Keep blocked work visible in attention but exclude it from immediately executable recommendations. When a recorded dependency completes, reevaluate readiness. Time passing alone does not prove an external blocker is resolved. A due follow-up is an action to check, not permission to contact anyone automatically.

Use configurable review intervals and freshness thresholds. Separate meaningful progress from synchronization heartbeats so polling cannot make neglected work appear active. Consolidate repeat alerts and permit snoozing. In-app attention is sufficient for this release.

Example recommendation: “Finish the export API: it unblocks the frontend needed for Friday’s demo.” If there is insufficient context, show that plainly and offer the next ready items without inventing urgency.

7. Build sequence

Proceed through these slices without requesting approval at each boundary. Maintain a short checklist and document assumptions. Ask only for a consequential unresolved product decision or a real external access blocker.

1. Persistent board and MCP: Implement the data model, migrations, shared task operations, usable board/detail view, and real MCP read/write tools. Prove that a task created through MCP appears in the UI and that a UI change is returned through MCP after a restart.
2. Session continuity: Add task/session association, context loading, checkpoints, and installation/setup documentation. Demonstrate one session’s checkpoint being retrieved by another.
3. Automatic maintenance and recovery: Add lifecycle integration, durable pending updates, bounded retry, idempotency, conflict handling, and visible synchronization health. Verify that failure does not silently lose an acknowledged update.
4. Attention and priority: Add deadlines, dependency/follow-up review, explicit ordering, explanations, and the attention/next-work views. Finish usability and setup documentation.

After each slice, run relevant checks and update BUILD_STATUS.md with what works, actual validation, unresolved problems, and the next concrete action. Continue until the release criteria below are met or a genuine blocker prevents further work.

8. Acceptance scenarios

Use meaningful integration tests for the stateful and failure-prone behavior. Prefer a small set of complete scenarios over tests that mirror implementation details. Use a real temporary database and actual MCP transport where applicable.

|Scenario             |Observable pass condition                                                                                                               |
|---------------------|----------------------------------------------------------------------------------------------------------------------------------------|
|Persistent round trip|Create through an MCP client, view/edit in UI, restart service, read the preserved changes through MCP                                  |
|Resume work          |A second session retrieves the correct task, latest finding, completion conditions, and next action                                     |
|Automatic checkpoint |A configured Claude session updates the linked card after meaningful work without a separate user request to update the board           |
|Task switching       |Switching active task directs subsequent checkpoints to the correct card                                                                |
|Safe completion      |Finishing a response or stopping a session does not by itself mark a task Done                                                          |
|Retry after outage   |A generated checkpoint queues while service is unavailable, survives the hook process exit, and applies once after recovery             |
|Concurrent updates   |A stale conflicting edit cannot silently overwrite newer state; retrying an acknowledged operation creates no duplicate                 |
|Priority control     |A user pin persists; recommendations explain deadlines/dependencies and flag conflicting commitments                                    |
|Waiting and freshness|Due follow-ups and neglected tasks surface; polling does not count as meaningful progress; blocked work is not recommended as executable|
|Correction and undo  |A mistaken change can be corrected or undone without erasing intervening changes                                                        |
|Local usability      |Core workflows work with a keyboard, empty/error states are understandable, and demo data cannot contaminate real tasks                 |

Record fixture-based hook checks separately from a live Claude Code integration test. If the current environment cannot run Claude Code or lacks required access, finish all independent work and deliver an exact short live test procedure. Clearly mark that integration as unverified. Do not claim the full automatic workflow works based only on a simulated payload or an HTTP unit test.

9. Delivery and session continuity

Deliver the working application, migrations, focused tests, README setup/run instructions, MCP registration instructions, hook setup/removal instructions, and a concise demonstration walkthrough. Use current verified commands rather than guessing CLI flags or hook schemas.

Maintain BUILD_STATUS.md with:

• Current slice and completed behavior.
• Technical decisions and why they were chosen.
• Commands actually run and their outcomes.
• Known limitations and unverified external integration steps.
• Exact next actions for a resumed session.

Final report: explain what works, how to start it, which acceptance scenarios were actually verified, and any remaining blockers. Do not hide missing functionality behind a successful frontend build.

If a new Claude session is needed, paste:

Read CLAUDE_BUILD_BRIEF.md, BUILD_STATUS.md, and the repository instructions.
Inspect the current code and working tree to confirm the recorded state.
Resume from the next unfinished slice. Preserve existing work, update the
status file as you proceed, and continue through the remaining acceptance
scenarios. Clearly distinguish verified behavior from assumptions.

Reference material to verify during implementation

• Claude Code MCP: https://code.claude.com/docs/en/mcp
• Claude Code hooks: https://code.claude.com/docs/en/hooks
• Claude Code project instructions: https://code.claude.com/docs/en/memory
• MCP documentation and SDK discovery: https://modelcontextprotocol.io/docs

These references are implementation inputs. Check their current contents and the installed versions before choosing commands or integration APIs.