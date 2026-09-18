# opencode-teamwork

> Antigravity-style multi-agent orchestration for OpenCode. 10 agents, 6 topologies, 7 slash commands — and a **run engine owned by code**: append-only event log, topological dispatch, hashed verification evidence, budget enforcement.

[![npm version](https://img.shields.io/npm/v/opencode-teamwork.svg)](https://www.npmjs.com/package/opencode-teamwork)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenCode plugin](https://img.shields.io/badge/opencode-plugin-blueviolet)](https://opencode.ai)

A community replica of Google Antigravity's `/teamwork-preview`, packaged as an
OpenCode plugin.

```
/teamwork "your hardest problem"
```

The design rule is one line: **the LLM proposes, the runtime disposes.**
Agents plan and implement. Dispatch order, retries, the budget, terminal states
and the record of what happened belong to code, so a run survives a compaction,
a model swap, or a restart — and a PASS means "a command ran and exited 0",
not "a model felt good about it".

## Quick install

```bash
bunx opencode-teamwork@latest install
# or
npx opencode-teamwork@latest install
```

Then run `opencode` and try:

```
/teamwork-craft                                       # Phase 1: interactive spec wizard
/teamwork "your hardest problem"                      # plan → dispatch → verify
/teamwork --topology small-focused "rename x"         # flags are parsed in code
/teamwork --topology long-proof --budget 30 "prove X"
/teamwork --topology distributed-coding --concurrency 4 "migrate auth to JWT"
```

## What is enforced in code

Every claim below is backed by a test. `bun run verify` runs all of them.

| Guarantee | Mechanism | Test |
|---|---|---|
| Dispatch follows the DAG | `Engine.dispatchable()` returns only tasks whose dependencies are COMPLETED, within the concurrency cap | `bun test` — topological order + cap |
| Cycles and dangling deps can't start a run | `validatePlan()` rejects them before the first event is written | `bun test` — plan validation |
| The verifier cannot edit code | `permission.edit: deny` injected as a real config key **and** a runtime guard that refuses write tools for read-only sessions | `plugin-integration` — "verifier edit refused" |
| A PASS must be evidence | the engine refuses a report with no executed check, or a check marked failed with `exitCode: 0` | `bun test` + `e2e` — "rubric-only PASS rejected" |
| Budget stops the run | `dispatchable()` returns nothing at the cap; `budget.exhausted` is logged | `e2e` — "dispatch stops once the cap is hit" |
| One bad task doesn't poison the run | `maxRounds` exhaustion dead-letters that task; the rest continue | `e2e` — "3 of 4 completed, 1 parked" |
| The record can't be rewritten | events are hash-chained; `teamwork_resume` refuses a tampered log | `bun test` + `e2e` — tamper detection |
| Long runs survive compaction | `experimental.session.compacting` re-injects plan, task states and budget from the log | `plugin-integration` — "plan re-injected" |
| Per-role models survive the plugin | config is merged, not replaced | `plugin-integration` — "verifier model preserved" |
| An agent name can't escape the run dir | `assertAgentName` + argv-based git calls (no shell) | `bun test` — worktree safety |

## Architecture

```
/teamwork "…"
   │
   ├─ command.execute.before      ← flags parsed IN CODE, run id minted,
   │                                .opencode/teamwork/LATEST.json written
   │
   ├─ team/sentinel (primary)     ← picks a topology, calls the engine, merges
   │     │
   │     ├─ teamwork_plan         ← validate DAG, create run, write specs, worktrees
   │     ├─ teamwork_dispatch     ← "what runs now?" (topological + budget + cap)
   │     ├─ team/worker  ×N       ← one git worktree each, returns patch.diff + summary
   │     ├─ team/verifier ×N      ← runs the actual commands, records cmd+exitCode+hash
   │     ├─ teamwork_verify       ← engine rules: COMPLETED | retry | dead-letter
   │     ├─ teamwork_status       ← derived from the log, never from memory
   │     └─ teamwork_resume       ← chain-verified rebuild after a restart
   │
   └─ .opencode/teamwork/<run-id>/
        ├─ events.jsonl           ← append-only, hash-chained: the source of truth
        ├─ state.json             ← DERIVED snapshot (never hand-written)
        ├─ plan.dag.json          ← schema-validated
        ├─ spec-<taskId>.json     ← schema-validated, one per task
        ├─ request.md             ← the raw request + parsed flags
        ├─ worktrees/             ← one per agent
        └─ final.md               ← what the user reads
```

Implementers are biased; that's the premise. The verifier sees the diff and the
spec, never the worker's self-report, and its verdict only counts when it carries
the exit code of something that actually ran.

## The 10 agents

| Agent | Role | Mode | Can edit |
|---|---|---|---|
| `team/sentinel` | run coordinator, drives the engine | primary | yes |
| `team/crafter` | interactive spec elicitation | primary | ask |
| `team/orchestrator` | v1 propose/falsify loop | primary | yes |
| `team/worker` | implements one scoped spec in its own worktree | subagent | yes |
| `team/proof-worker` | same, for Lean/Coq/Isabelle proofs | subagent | yes |
| `team/verifier` | the forcing function | subagent | **no** |
| `team/falsifier` | attacks a candidate | subagent | **no** |
| `team/scout` | read-only context gathering | subagent | **no** |
| `team/proposer` | one candidate per invocation | subagent | ask |
| `team/synthesizer` | merges candidates + critiques | subagent | ask |

Leaf agents get `task: deny` — a worker cannot fan out its own swarm. Only the
sentinel and the v1 orchestrator may invoke subagents.

## The 6 topologies

| Topology | Shape | Use when |
|---|---|---|
| `small-focused` | 1 builder + 1 reviewer loop | one self-contained fix |
| `iterative-coding` | proposer + falsifier + verify | a bug in a known place |
| `distributed-coding` | N workers in parallel + verifiers | multi-module change, migration |
| `long-proof` | strategist + 3-5 searchers + formal checker | math/TCS proof |
| `massive-proof-swarm` | meta-coordinator + 100+ searchers | open conjecture (opt-in) |
| `document-review` | chair + 3 critics + aggregator | paper / RFC / audit |

The definition files ship in `dist/cli/templates/patterns/`. The orchestrating
agents' prompts carry an index of their absolute paths — the names in the prompt
and the files on disk are generated from one source (`src/policy.ts`), so they
cannot drift apart.

## When NOT to use this

- A simple, well-scoped task ("rename this function", "add a log line"). The
  default `build` agent is faster.
- Anything that fits in one context. Teamwork's overhead is real: you pay for
  3-5 candidates where one would have worked.
- Production deployment. This is for the exploration phase, not the ship phase.

## Cost control

`--budget 30` (USD) or a per-topology default. The engine sums recorded cost from
the event log, warns at 80%, and refuses further dispatch at 100%. A run that hits
the cap presents partial results and the dead-letter queue instead of retrying
forever.

## Self-improving runs

The event log is the prerequisite for improving the *policy* rather than the
models: topologies, model ladders, required checks. The design — attribution,
typed policy deltas, adversarial falsification of the hypothesis, shadow replay
on a frozen benchmark, canary + rollback, and the escape-rate metric that keeps
the loop honest — is in [docs/self-improvement.md](docs/self-improvement.md).
Nothing in it ships yet; it is written down so it can be built against the log
that now exists.

## Development

```bash
git clone https://github.com/aditya0si/OpenCode-Team
cd OpenCode-Team
bun install
bun run verify     # typecheck → unit tests → build → smoke → e2e → plugin integration
```

| Command | What it proves |
|---|---|
| `bun run typecheck` | no type errors |
| `bun test` | scheduler, event log, report validation, config injection, guard, flags |
| `bun run e2e` | the whole loop against a real git repo: worktrees, evidence capture, budget, dead-letter, resume, cleanup |
| `bun run integration` | the built bundle with the hook shapes OpenCode sends: config, commands, tools, guard, compaction |
| `bun run smoke` | the installer: install / re-install / uninstall / doctor / dry-run |

## Contributing

Useful places to help:

- New topologies (security audit, perf work, data migration) — add a pattern file
  and one entry in `src/policy.ts`.
- A verification ladder (static → unit → property → integration) so cheap oracles
  run before the expensive one.
- The learning loop in `docs/self-improvement.md`, starting with `trace.jsonl`
  export from the existing event log.

See `CONTRIBUTING.md`.

## License

MIT. See `LICENSE`.
