# Changelog

All notable changes to opencode-team are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
