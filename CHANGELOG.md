# Changelog

All notable changes to opencode-team are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-08-28

CLI UX fix.

### Fixed
- **CLI now asks before writing.** `opencode-team install` and
  `uninstall` previously wrote to `~/.config/opencode/opencode.json`
  without confirmation. Both now show a diff preview of what will
  change, then prompt `Write this config? (Y/n)` (install, default
  Y) or `Remove opencode-team? (y/N)` (uninstall, default N).
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
- Installer CLI: `opencode-team install` with 5 presets
  (anthropic, team, google, openai, free) plus a `custom` per-role
  picker.
- `uninstall` and `doctor` subcommands.
- Pitfall registry across rounds.
- Output under `.teamwork-runs/<run-id>/` with per-phase subfolders.
- `SKILL.md` for the agent SKILL loader.
