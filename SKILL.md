---
name: opencode-teamwork
description: "Antigravity-style multi-agent orchestration plugin for OpenCode with a code-owned run engine. Use when the user wants to install, configure, or operate opencode-teamwork — including the 10 team/* agents (crafter, sentinel, worker, proof-worker, verifier, orchestrator, proposer, falsifier, synthesizer, scout), the 6 topologies (small-focused, long-proof, iterative-coding, distributed-coding, document-review, massive-proof-swarm), the 7 slash commands (/teamwork, /teamwork-craft, /team-orchestrate, /team-propose, /team-falsify, /team-synthesize, /team-review), the installer (`bunx opencode-teamwork@latest install`), the run engine tools (teamwork_plan, teamwork_dispatch, teamwork_verify, teamwork_status, teamwork_resume), the hash-chained event log, git worktree isolation, schema-validated artifacts, budget enforcement, and per-role model selection."
version: 0.3.0
author: Aditya Singh
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [opencode, antigravity, teamwork, multi-agent, orchestration, plugin, npm, agent-roles, pattern-library, slash-commands, dag, worktree, cost-tracking, typed-artifacts, event-log, verification]
    homepage: https://github.com/aditya0si/OpenCode-Team
---

# opencode-teamwork — Antigravity-style multi-agent orchestration for OpenCode

A community replica of Google Antigravity's `/teamwork-preview`, packaged as an
OpenCode plugin. 10 agents, 6 topologies, 7 slash commands.

**The rule that shapes everything: the LLM proposes, the runtime disposes.**
Agents plan and implement; dispatch order, retries, the budget, terminal states
and the record of what happened are owned by code (`src/engine.ts`,
`src/events.ts`). A verifier PASS only counts when the report carries the exit
code of a command that actually ran.

This skill is a hub. The body covers the mental model. For per-agent behavior and
per-topology adjustments, read the files inside the installed plugin at
`node_modules/opencode-teamwork/dist/cli/templates/`.

## The mental model

Teamwork is a loop, not a pipeline. The v2 loop is:

```
crafter (Phase 1: interactive spec elicitation)
    ↓
command.execute.before        ← flags parsed in code, run id minted
    ↓
sentinel (Phase 2: coordinator — calls the engine, does not decide order)
    ↓
teamwork_plan                 ← validate DAG, create run, write specs, worktrees
    ↓
teamwork_dispatch             ← "what runs NOW?" (topological + budget + cap)
    ↓
worker[0..N] → patch.diff + summary.md   (one git worktree each)
    ↓
verifier[0..N] → verification_report.json (cmd + exitCode + stdoutSha256)
    ↓
teamwork_verify               ← engine rules: COMPLETED | retry | dead-letter
    ↓
final.md + the run directory
```

Everything the sentinel needs to know after a compaction comes from
`events.jsonl` (append-only, hash-chained) via `teamwork_status`, never from the
model's memory. `state.json` is a derived snapshot.

The v1 loop (`/team-orchestrate`) is the simpler propose → falsify → synthesize →
verify cycle, without the DAG engine or worktrees. Both ship.

## The 10 agents

| Agent | Role | Mode | Can edit |
|---|---|---|---|
| `team/crafter` | Phase-1 wizard. Runs the elicitation flow. Produces `prompt_draft.md`. | primary | ask |
| `team/sentinel` | Run coordinator. Calls the engine, dispatches workers + verifiers, merges. | primary | yes |
| `team/worker` | Generic implementer. Own worktree, scoped spec, returns diff + summary. | subagent | yes |
| `team/proof-worker` | Math/proof specialist. Lean/Coq/Isabelle. | subagent | yes |
| `team/verifier` | Forcing function. Runs the verification plan, returns a structured report. | subagent | **no** |
| `team/orchestrator` | v1 loop coordinator. | primary | yes |
| `team/proposer` | v1 candidate generator. | subagent | ask |
| `team/falsifier` | v1 adversarial critic. | subagent | **no** |
| `team/synthesizer` | v1 merge step. | subagent | ask |
| `team/scout` | Read-only context gatherer. | subagent | **no** |

Read-only roles are enforced twice: `permission.edit: deny` is injected as a real
OpenCode config key, and a runtime guard refuses write-tool calls from those
sessions. Leaf agents also get `task: deny`, so a worker cannot fan out its own
swarm — only the sentinel and the v1 orchestrator may invoke subagents.

## The 6 topologies

| Topology | Shape | Trigger |
|---|---|---|
| `small-focused` | 1 builder + 1 reviewer loop | Single self-contained fix |
| `iterative-coding` | 1 proposer → 1 falsifier (no synthesis) | Tight agent-test-refine loop |
| `distributed-coding` | N workers in parallel + verifiers | Decomposable engineering task |
| `long-proof` | 1 strategist + 3-5 searchers + formal checker | Math/TCS proof, Lean/Coq |
| `massive-proof-swarm` | meta-coord + 100+ searchers | Open conjecture, opt-in only |
| `document-review` | 1 chair + 3 critics + 1 aggregator | Paper / RFC / audit review |

The names above are generated from `src/policy.ts`, and a test asserts every one
resolves to a pattern file on disk. The orchestrating agents' prompts carry the
absolute paths of those files, so no agent has to guess where the definition
lives. Force one with `/teamwork --topology <name> "..."` — the flag is parsed in
code and an unknown name is reported, not silently accepted.

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

Raw conversation is never shared. Agents communicate through typed artifacts on
disk, and the engine validates them against the Zod schemas in `src/artifacts.ts`
before accepting them:

| File | Producer | Consumer | Validated |
|---|---|---|---|
| `events.jsonl` | engine | everything | hash chain verified on read |
| `state.json` | engine (derived) | sentinel (on resume) | written from the log, never hand-edited |
| `request.md` | plugin (`command.execute.before`) | sentinel | raw request + parsed flags |
| `plan.dag.json` | sentinel via `teamwork_plan` | engine, workers | `PlanDagSchema` |
| `spec-<taskId>.json` | engine | worker | `SpecSchema` |
| `patch.diff` | worker | verifier | git diff (the file *is* the artifact) |
| `summary.md` | worker | verifier (as a hint only) | markdown |
| `verification_report.json` | verifier | engine via `teamwork_verify` | `VerificationReportSchema` + evidence rules |
| `final.md` | sentinel | user | markdown |

A report is rejected if a `programmatic`/`adversarial` check has no `cmd` or no
`exitCode`, if a check claims `passed: false` while its command exited 0 (or the
reverse), or if a PASS contains no executed check at all. Fabricated PASSes were
the original architecture's weakest point; the exit code is what closes it.

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
