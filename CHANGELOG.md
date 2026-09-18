# Changelog

All notable changes to opencode-teamwork are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-09-19

**The run loop moved into code.** Until now the "DAG engine", worktree
isolation, cost tracking and checkpoint/resume were instructions in a prompt:
`src/worktree.ts`, `src/cost.ts`, `src/state.ts` and `src/artifacts.ts` were
imported by nothing, so none of those guarantees were enforced by the runtime.

### Added
- **`src/engine.ts`** — a real scheduler: plan validation (cycles, dangling
  dependencies, duplicate ids, unknown topologies), topological dispatch waves,
  a concurrency cap, attempt accounting, per-round model escalation, dead-letter
  after `maxRounds`, and budget enforcement that refuses dispatch at the cap.
- **`src/events.ts`** — append-only `events.jsonl` with a sha256 hash chain.
  `state.json` is now a *derived* snapshot; `deriveSession()` replays a run and
  `verifyChain()` refuses a tampered log.
- **Engine tools**: `teamwork_plan`, `teamwork_dispatch`, `teamwork_verify`,
  `teamwork_status`, `teamwork_resume`.
- **`src/guard.ts`** — runtime role enforcement. Read-only roles
  (verifier, falsifier, scout) cannot call write tools even if a host build
  ignores part of the permission block.
- **`src/policy.ts`** — one source of truth for topology names, model ladders,
  required checks and budget. A test asserts every topology resolves to a
  pattern file.
- **Verification evidence**: checks now carry `cmd`, `exitCode`, `stdoutSha256`
  and `durationMs`. A PASS with no executed check, or with a check that
  contradicts its exit code, is rejected and does not count as a round.
- **Command flags parsed in code** — `--topology`, `--budget`, `--concurrency`,
  `--session`, with an unknown topology reported instead of accepted.
- **Long runs survive compaction**: the `experimental.session.compacting` hook
  re-injects the plan, task states and budget from the event log.
- **Tests**: 26 unit tests (`bun test`), a real end-to-end run against a git
  repository (`bun run e2e`), and a built-bundle integration test that drives the
  actual hook shapes OpenCode sends (`bun run integration`). CI runs all three on
  Linux, macOS and Windows, plus a `npm pack` → clean-install check.
- `docs/self-improvement.md` — the design for improving the *policy* (not the
  models) from the event log, with the guard metrics and failure modes.

### Fixed
- **Agent frontmatter was inert.** The plugin passed each agent file's whole
  markdown — frontmatter included — as the `prompt` string, so `mode` defaulted
  to `all`, `permission: edit: deny` on the verifier did nothing, `temperature`
  was ignored, and `hidden` is not a config key at all. Frontmatter is now
  parsed and injected as real `AgentConfig` keys.
- **The plugin clobbered per-role models.** `config.agent[name] = { prompt }`
  replaced whatever the installer had written, discarding the model map. Config
  is now spread-merged, and a test asserts the user's model survives.
- **Three incompatible topology vocabularies.** The pattern files said
  `long-proof` / `distributed-coding` / `document-review` while the sentinel
  prompt and `state.ts` said `proof` / `large-swarm` / `doc-review` — four of
  five names in the routing table matched no file.
- **Pattern files never reached the model.** `getAllPatterns()` had no call
  sites and no prompt referenced `patterns/`. Orchestrating agents now get a
  generated index with absolute paths.
- **A template language OpenCode cannot expand.** `{{if eq .sessionId ""}}` in
  the `/teamwork` command was passed to the model as literal text (only
  `$ARGUMENTS`, `$1..$N`, `` !`cmd` `` and `@file` are supported), and
  `$ARGUMENTS` appeared twice, duplicating every request.
- **Shell injection surface in the worktree manager.** Git was invoked by
  building command strings from model-produced names. All git calls now use
  argv arrays with `shell: false`, and agent/session names are validated.
- **`cleanupSession` never cleaned up.** It ran `git worktree remove` against
  the worktrees' *parent* directory (never a worktree), swallowed the failure,
  then deleted directories git still had registered. It now removes real
  worktrees, deletes the session's branches, prunes, and verifies.
- **`dist/` layout did not match `package.json` exports.** `build:support`
  emitted `dist/src/*.js` while `exports` pointed at `dist/*.js`.
- **`SKILL.md` now ships.** It was in the repo but not in `files`.
- Leaf agents get `task: deny`; only the sentinel and v1 orchestrator can spawn
  subagents, so a worker can no longer fan out its own swarm.

### Changed
- `src/state.ts` is a compatibility shim over the event log;
  `saveSessionState()` now throws with guidance rather than accepting a
  model-authored snapshot.
- `bun run verify` is the single gate: typecheck → unit → build → smoke → e2e →
  integration. `prepublishOnly` runs it.

## [0.2.1] — 2026-08-28

CLI UX fix.

### Fixed
- **CLI now asks before writing.** `opencode-teamwork install` and
  `uninstall` previously wrote to `~/.config/opencode/opencode.json`
  without confirmation. Both now show a diff preview of what will
  change, then prompt `Write this config? (Y/n)` (install, default
  Y) or `Remove opencode-teamwork? (y/N)` (uninstall, default N).
- **New `--yes` / `-y` flag** for CI / scripts. Skips all prompts;
  piped stdin also auto-proceeds.
- **New `--dry-run` flag** (alias `--print`): prints the would-be
  config indented and prefixed with `# Would write to`, then exits
  without touching disk.
- **`--reset` now warns before overwriting** instead of silently
  clobbering.
- **Every prompt honors `q` / `quit` / `exit`** to abort cleanly
  with `Aborted. No changes made.` No more `process.exit(1)` on
  invalid input — re-prompt instead.
- The preset picker now shows `q. quit` as an explicit row.
- Per-role model picker accepts `q` to abort mid-way.
- Help text (`--help`) updated with all new flags.

### Added
- `scripts/interactive-test.ts` — verifies the `--yes` and
  `--dry-run` flows.
- Smoke test expanded to 6 sections covering the gate, diff
  preview, `--dry-run`, and `--yes`.

## [0.2.0] — 2026-08-28

v2 release. Full Antigravity Teamwork architecture replica.

### Added (v2 architecture)
- 4 new agents: `team/crafter` (Phase-1 9-step wizard),
  `team/sentinel` (DAG coordinator), `team/worker` (generic
  implementer), `team/proof-worker` (Lean/Coq specialist).
- 2 new patterns: `small-focused` (1 builder + 1 reviewer loop),
  `massive-proof-swarm` (100+ searchers, opt-in only).
- 2 new commands: `/teamwork-craft` (Phase-1 wizard),
  `/team-orchestrate` (v1 legacy loop).
- DAG engine: `src/artifacts.ts` exports Zod schemas for
  `PlanDag`, `Spec`, `VerificationReport`, plus 4 helper types.
- Git worktree manager: `src/worktree.ts` — one worktree per
  agent, base branch, full lifecycle.
- Cost tracker: `src/cost.ts` — per-agent spend, session budget,
  alert at 80% of cap.
- Session state machine: `src/state.ts` — checkpointed on every
  transition, resumable after interruption.
- Typed artifact bus: `spec.json`, `plan.dag.json`, `patch.diff`,
  `summary.md`, `verification_report.json`, `feedback_for_worker.md`,
  `costs.json`, `state.json`, `prompt_draft.md`, `final.md`.
- v1 loop preserved as `/team-orchestrate` for users who don't
  need the full v2 stack.

### Changed
- `installer` now writes all 10 agent roles (was 6).
- Smoke test expanded to check 10 roles.
- `SKILL.md` rewritten for v2 (10 agents, 6 patterns, 7 commands).

## [0.1.0] — 2026-08-28

First public release. v1 architecture.

### Added
- 6 agents: `team/orchestrator` (primary), `team/proposer`,
  `team/falsifier`, `team/synthesizer`, `team/verifier`, `team/scout`
  (hidden subagents).
- 4 patterns: `long-proof`, `iterative-coding`, `distributed-coding`,
  `document-review`.
- 5 slash commands: `/teamwork`, `/team-propose`, `/team-falsify`,
  `/team-synthesize`, `/team-review`.
- Installer CLI: `opencode-teamwork install` with 5 presets
  (anthropic, team, google, openai, free) plus a `custom` per-role
  picker.
- `uninstall` and `doctor` subcommands.
- Pitfall registry across rounds.
- Output under `.teamwork-runs/<run-id>/` with per-phase subfolders.
- `SKILL.md` for the agent SKILL loader.
