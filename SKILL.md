---
name: opencode-teamwork
description: "Antigravity-style multi-agent orchestration plugin for OpenCode. Use when the user wants to install, configure, or operate opencode-teamwork — including the 10 team/* agents (crafter, sentinel, worker, proof-worker, verifier, orchestrator, proposer, falsifier, synthesizer, scout), the 6 patterns (small-focused, long-proof, iterative-coding, distributed-coding, document-review, massive-proof-swarm), the 7 slash commands (/teamwork, /teamwork-craft, /team-orchestrate, /team-propose, /team-falsify, /team-synthesize, /team-review), the installer (`bunx opencode-teamwork@latest install`), DAG engine, git worktree isolation, typed artifact bus, cost tracking, and per-role model selection."
version: 0.2.0
author: Aditya Singh
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [opencode, antigravity, teamwork, multi-agent, orchestration, plugin, npm, agent-roles, pattern-library, slash-commands, dag, worktree, cost-tracking, typed-artifacts]
    homepage: https://github.com/aditya0si/OpenCode-Team
---

# opencode-teamwork — Antigravity-style multi-agent orchestration for OpenCode

A community replica of Google Antigravity's `/teamwork-preview`,
packaged as an opencode plugin. 10 agents, 6 patterns, 7 slash
commands, full DAG engine with git worktree isolation, typed
artifact bus, and cost tracking. Install with one command, mix and
match models per role, point it at your hardest problem.

This skill is a hub. The body covers the high-level mental model. For
per-agent behavior, per-pattern adjustments, and per-command output,
load the relevant agent file or pattern file — they live inside the
installed plugin at `node_modules/opencode-teamwork/dist/cli/templates/`.

## The mental model

Teamwork is a loop, not a pipeline. The v2 (DAG-based) loop is:

```
crafter (Phase 1: 9-step elicitation wizard)
    ↓
sentinel (Phase 2: dispatcher / coordinator)
    ↓
plan.dag.json (build the task dependency graph)
    ↓
worktree-per-agent (one isolated git worktree each)
    ↓
worker[0..N] → patch.diff + summary.md
    ↓
verifier[0..N] → verification_report.json
    ↓
FAIL → feedback_for_worker.md → back to worker (loop)
PASS → merge to base branch
```

The v1 (legacy) loop is a simpler propose-falsify-synthesize-verify
cycle for users who don't need the DAG engine or worktree isolation.
Both loops ship; the user picks via `/teamwork` (v2) or
`/team-orchestrate` (v1).

## The 10 agents

| Agent | Role | Hidden | Mode |
|---|---|---|---|
| `team/crafter` | Phase-1 wizard. Runs the 9-step elicitation flow. Produces `prompt_draft.md`. | no | primary |
| `team/sentinel` | Phase-2 coordinator. Loads spec, builds DAG, dispatches workers + verifiers, iterates, merges. | no | primary |
| `team/worker` | Generic implementer. Own worktree, scoped spec, returns diff. | yes | subagent |
| `team/proof-worker` | Math/proof specialist. Lean/Coq/Isabelle. | yes | subagent |
| `team/verifier` | Forcing function. Runs the verification plan. Returns structured PASS/FAIL report. | yes | subagent |
| `team/orchestrator` | v1 loop coordinator. | no | primary |
| `team/proposer` | v1 candidate generator. | yes | subagent |
| `team/falsifier` | v1 adversarial critic. | yes | subagent |
| `team/synthesizer` | v1 merge step. | yes | subagent |
| `team/scout` | Read-only context gatherer. | yes | subagent |

Hidden subagents don't appear in `@` autocomplete. They're invoked
by the Sentinel / Orchestrator via the `task` tool. You can still
@-mention them manually.

## The 6 patterns

| Pattern | Topology | Trigger |
|---|---|---|
| `small-focused` | 1 builder + 1 reviewer loop | Single self-contained fix |
| `iterative-coding` | 1 proposer → 1 falsifier (no synthesis) | Tight agent-test-refine loop |
| `distributed-coding` | N workers in parallel + verifiers | Decomposable engineering task |
| `long-proof` | 1 strategist + 3-5 searchers + formal checker | Math/TCS proof, Lean/Coq |
| `massive-proof-swarm` | meta-coord + 100+ searchers | Open conjecture, opt-in only |
| `document-review` | 1 chair + 3 critics + 1 aggregator | Paper / RFC / audit review |

The Sentinel picks from the spec. Force one with
`/teamwork --topology <name> "..."`. If you don't, the Sentinel infers
from the spec and asks one question if it can't tell.

## The 7 slash commands

| Command | Does |
|---|---|
| `/teamwork [args]` | Full v2 DAG-based run. Use for "do this hard thing for me." |
| `/teamwork-craft [args]` | Phase-1 wizard. Produces `prompt_draft.md`. |
| `/team-orchestrate [args]` | v1 loop (propose/falsify/synthesize/verify). No DAG. |
| `/team-propose [args]` | Just the propose step. |
| `/team-falsify [args]` | Just the falsify step on existing candidates. |
| `/team-synthesize [args]` | Just the synthesis step. |
| `/team-review [args]` | Just the verify step. |

## The artifact bus

Raw conversation is never shared. Agents communicate through typed
artifacts on disk. Every artifact has a Zod schema in
`src/artifacts.ts`:

| File | Producer | Consumer | Schema |
|---|---|---|---|
| `prompt_draft.md` | crafter | sentinel | markdown (structure in crafter prompt) |
| `plan.dag.json` | sentinel | workers | `PlanDagSchema` |
| `state.json` | sentinel | sentinel (on resume) | `SessionState` |
| `costs.json` | every agent | sentinel | `CostState` |
| `spec.json` | sentinel | worker | `SpecSchema` |
| `patch.diff` | worker | verifier | (git diff) |
| `summary.md` | worker | sentinel | markdown |
| `verification_report.json` | verifier | sentinel | `VerificationReportSchema` |
| `feedback_for_worker.md` | verifier | worker (next round) | markdown |
| `final.md` | sentinel | user | markdown |

## Per-role model selection

The installer ships 5 presets: `anthropic`, `team`, `google`,
`openai`, `free`. The `team` preset mixes Opus (sentinel, crafter,
orchestrator, proof-worker, synthesizer) with Sonnet (the rest).
The `google` preset matches what Teamwork's actual research used
(Flash + Pro 3.1, 71% on TCSBench).

Custom per-role with the `custom` picker at install time, or edit
your `opencode.json` by hand later. There is no technical reason all
10 agents have to be the same model.

## Install

```bash
bunx opencode-teamwork@latest install
# or with a preset
bunx opencode-teamwork@latest install --preset team
```

The installer:
1. Resolves `~/.config/opencode/opencode.json` (or `$OPENCODE_CONFIG_DIR/opencode.json`).
2. Asks which preset (or `custom` for per-role).
3. Writes the config, deep-merging with any existing settings.
4. Adds the plugin to the `plugin` array.
5. Tells you to run `opencode` and try `/teamwork "..."`.

## Uninstall

```bash
bunx opencode-teamwork@latest uninstall
```

Removes the plugin entry and all `team/*` agents from your
opencode.json. Does not `npm uninstall` the package.

## Doctor

```bash
bunx opencode-teamwork@latest doctor
```

Checks that the plugin is listed, all 10 roles are configured.

## Reference files

After install, the templates are at:

```
~/.npm/_npx/<hash>/node_modules/opencode-teamwork/dist/cli/templates/
├── crafter.md           sentinel.md        worker.md
├── proof-worker.md      verifier.md        orchestrator.md
├── proposer.md          falsifier.md       synthesizer.md    scout.md
├── commands/
│   ├── teamwork.md      teamwork-craft.md  team-orchestrate.md
│   ├── team-propose.md  team-falsify.md
│   ├── team-synthesize.md  team-review.md
└── patterns/
    ├── small-focused.md     long-proof.md        iterative-coding.md
    ├── distributed-coding.md  document-review.md  massive-proof-swarm.md
```

Or in the source repo: `src/cli/templates/`.

## Why this exists

Google's `/teamwork-preview` is closed and only runs on Antigravity.
This is the opencode-shaped replica. The patterns, the falsifier
loop, the pitfall registry, the DAG engine, the worktree isolation,
and the typed artifact bus come straight from the Teamwork paper +
the open-source reference architecture. The agent split is the
minimum that lets the loop work without collapsing into "one model
with multiple prompts."

The intent: make multi-agent orchestration usable by anyone running
opencode, on any model, on any provider, without an Antigravity
account.
