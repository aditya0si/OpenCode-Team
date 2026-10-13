# Project baseline and integration constraints

Status: research/design, 2026-10-11. No product code changed. Source inspection is not runtime certification.

## Snapshot mismatch

Local C:/Users/oliad/Desktop/opencodeteam is v0.2.1 at 70c1dba, with pre-existing changes in README.md, SKILL.md and src/cli/index.ts. Public main scratch snapshot is v0.3.0 at 281821afc578f0c83fd94c8a2675b9da37281120. Do not pull/reset over the local changes. Decide branch/worktree strategy explicitly before implementation.

## Public v0.3 inspected implementation

Sources: scratch compare-repos/OpenCode-Team/src/index.ts and package.json, inspected directly. Public source: https://github.com/aditya0si/OpenCode-Team/blob/281821afc578f0c83fd94c8a2675b9da37281120/src/index.ts

- Plugin registers structured agent config, TEAMWORK_TOOLS, session-role tracking and tool/permission hooks (index.ts:137-203).
- Command hook writes request/run metadata and tracks run by session (205-244).
- Compaction hook reconstructs task context from event records (246-285).
- Package exports engine, events, policy, worktree and artifacts. Verify script includes typecheck, tests, build, smoke, E2E and integration; publishing calls verify.
- These are real code surfaces, not only v0.2 prompts. However, this phase has not audited engine/event/runner internals or rerun v0.3 tests. Reuse is conditional.

## Reuse decision matrix (proposal)

| Existing component | Potential reuse | Required investigation |
|---|---|---|
| Events | Run transitions and traceability | Concurrent writes, truncation, recovery, candidate write access; a hash chain alone is not authenticated proof |
| Artifacts/schemas | Claim/evidence schemas | Strict validation, version migrations, unknown fields and bounded sizes |
| Policy/budget | Limits and escalation | Hard admission control vs estimated accounting; runner and model limits separated |
| Role guard | Reviewer read-only tool permissions | Unknown session handling, alternate tools, shell bypass, child sessions, plugin ordering; whether the project's guard is a plugin hook, a permission rule, or a policy statement, and what happens when a statement is dropped (fail-open per [13]) |
| Worktrees | Workspace separation | Dirty/untracked state capture, Windows behavior, symlink handling, cleanup/rescue |
| Engine | Bounded review state machine | Remove builder-centric assumptions; durable terminal outcomes |
| Installer | Install/remove reviewer | Preserve unrelated settings/plugins and existing user overrides |
| Agent prompts | Acceptance planner/reconciler | Evidence instructions, injection handling, non-leading questions; prompts are not security policy |

## Official integration source

https://docs.opencode.ai/docs/plugins/ (inspected by the primary-research workstream on 2026-10-11; parent direct extraction attempt was blocked by the search-only backend) documents plugin context, event hooks, custom tools, tool.execute.before/after, session.idle and compaction. It does not establish exactly-once events or that idle means task completion. See primary research [12].

Additional documented facts, re-fetched 2026-10-12 (footer "Last updated: Oct 11, 2026"):
- Load order: global config, project config, global plugin directory, project plugin directory. "All hooks run in sequence," so a later plugin's hook is not documented as overriding an earlier deny.
- The `shell.env` hook can inject environment variables into all shell execution, including AI tools. Runner environment sanitization must account for other installed plugins that use this hook.
- `experimental.session.compacting` is labeled experimental; the compaction-hook dependency is therefore less stable than `tool.execute.before`.
- The published `.env` example checks `input.tool === "read"` and `includes(".env")` only. It is an illustration, not a complete secrets-read guard, as noted in 01-primary-research.md [12].
- Policies (`experimental.policies`) are a separate mechanism. Invalid statements are dropped with a server-log warning; if no statement matches, the action is allowed. Source: [13] in 01-primary-research.md.

## MVP integration proposal

Explicit user-triggered audit first, optional idle notifications later. Proposed command names in concept are product-design labels, NOT validated OpenCode commands. Adapter obtains user-approved task and candidate scope, stores session/run association, launches bounded review context, and publishes a report. A separate core owns verdict semantics; model text cannot set terminal completion directly.

Do not claim mandatory interception of every completion response. Host-specific enforcement requires a separately approved compatibility spike.

## Compatibility acceptance probes before building

1. Pin actual supported host/plugin versions and use their types, not guessed event signatures.
2. Register a test command/tool, obtain correct parent session/diff/messages, and publish a report.
3. Confirm verifier runs do not recursively trigger audits; duplicates are deduplicated.
4. Test cancellation, disconnect, SDK error, nested sessions and compaction.
5. Test permission boundaries with alternate tool names and shell access; missing guards must block execution rather than degrade silently.
6. Verify installation/reinstallation/uninstallation preserve existing plugins, providers and model overrides.
7. Verify Windows and Linux snapshot/runner behavior separately; do not infer parity from TypeScript compilation.

## Security limits

OpenCode role permissions are application capability checks, not an OS sandbox. Git worktrees share host resources and are not containment. Executing package scripts can run arbitrary code. Candidate material must not control the approval policy or evidence store. Stronger execution guarantees depend on the approved runner; unsupported controls are reported as blocked.
