# opencode-teamwork

> Antigravity-style multi-agent orchestration for OpenCode. 6 agents, 4 patterns, 5 slash commands. One-line install.

[![npm version](https://img.shields.io/npm/v/opencode-teamwork.svg)](https://www.npmjs.com/package/opencode-teamwork)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OpenCode plugin](https://img.shields.io/badge/opencode-plugin-blueviolet)](https://opencode.ai)

This is a community replica of Google Antigravity's `/teamwork-preview`,
packaged as an opencode plugin. The team is opinionated: every run
goes scout → propose×N → falsify×N → synthesize → verify, with a
shared pitfall registry across rounds. You pick the pattern. You pick
the model per role. The loop is the same.

```
/teamwork "your hardest problem"
```

## Quick install

```bash
bunx opencode-teamwork@latest install
# or, if you don't have bun:
npx opencode-teamwork@latest install
```

Then run `opencode` and try:

```
/teamwork-craft                                # Phase 1: 9-step wizard
/teamwork "your hardest problem"               # v2: full DAG + worktrees + cost
/teamwork --topology small-focused "rename x"  # fast path for tiny fixes
/team-orchestrate "fix the off-by-one"         # v1: simpler propose/falsify loop
/teamwork --topology iterative-coding "fix the off-by-one in parser.ts"
/teamwork --topology distributed-coding "migrate the auth module to JWT"
/teamwork --topology long-proof "prove Knuth cycles for even n"
/teamwork --topology document-review "review https://arxiv.org/abs/2407.03262"
```

## What's in the box

| | |
|---|---|
| **10 agents** | crafter (wizard), sentinel (DAG coordinator), worker, proof-worker, verifier, orchestrator (v1), proposer, falsifier, synthesizer, scout |
| **6 patterns** | small-focused, iterative-coding, distributed-coding, long-proof, massive-proof-swarm, document-review |
| **7 commands** | `/teamwork`, `/teamwork-craft`, `/team-orchestrate`, `/team-propose`, `/team-falsify`, `/team-synthesize`, `/team-review` |
| **5 presets** | anthropic, team, google, openai, free — or `custom` for per-role |
| **1 DAG engine** | Builds the task dependency graph; dispatches in topological order |
| **Git worktree isolation** | One worktree per agent, no cross-contamination |
| **Typed artifact bus** | `spec.json`, `plan.dag.json`, `patch.diff`, `verification_report.json`, Zod-validated |
| **Cost tracking** | Per-agent spend, session budget guardrails, halt at 80% of cap |
| **Session checkpointing** | `state.json` written on every transition; resume after interruption |
| **Pitfall registry** | Shared across rounds, distills verifier findings into answer-agnostic mistakes |

## The v2 architecture (matches Antigravity's Teamwork)

```
PHASE 1 (crafter, primary, interactive)
    ↓ 9-step elicitation wizard
prompt_draft.md (in .opencode/teamwork/<session-id>/)

PHASE 2 (sentinel, primary, autonomous)
    ↓
[1] Load or inline the spec
[2] git worktree add .opencode/teamwork/<id>/worktrees/sentinel
[3] Build plan.dag.json — task dependency graph
[4] Provision worktrees per agent
[5] Dispatch workers in topological order (parallel where possible)
[6] Each worker returns: patch.diff + summary.md + cost.json
[7] Verifiers run against each patch.diff → verification_report.json
[8] If FAIL: feedback_for_worker.md → back to worker (loop)
    If PASS: merge worker branch → sentinel branch
[9] On full success: merge sentinel → user's branch
[10] Write state.json + final.md on every transition (resume-safe)
```

The key insight from the Teamwork paper: implementers are biased.
The verification engine enforces strict segregation of duties —
the verifier sees the diff, not the worker's self-report. The
worker cannot certify its own work.

## v1 (legacy) loop

If you don't need the DAG engine or worktree isolation, the v1 loop
is a simpler propose → falsify → synthesize → verify cycle:

```
        ┌──── scout (read-only, fast) ────┐
        │                                 │
   ┌────▼────┐  ┌────┐ ┌────┐ ┌────┐    │
   │ propose │─►│ c1 │ │ c2 │ │ c3 │    │   propose in parallel
   └────┬────┘  └─┬──┘ └─┬──┘ └─┬──┘    │   different strategies
        │         │      │      │         │
   ┌────▼────┐  ┌─▼──┐ ┌─▼──┐ ┌─▼──┐    │
   │ falsify │─►│crit│ │crit│ │crit│    │   falsify in parallel
   └────┬────┘  └─┬──┘ └─┬──┘ └─┬──┘    │   adversarial
        │         │      │      │         │
        │      ┌──▼──────▼──────▼──┐     │
        │      │    synthesize    │     │   merge into one
        │      └────────┬─────────┘     │
        │               │               │
        │      ┌────────▼─────────┐     │
        │      │     verify       │     │   PASS or FAIL
        │      └────────┬─────────┘     │
        │               │               │
        │         FAIL? ├──► pitfalls.md ──► re-propose (loop)
        │               │
        └──────────────►│
                       PASS ──► final.md
```

Use `/team-orchestrate` to invoke the v1 loop. Outputs go to
`.teamwork-runs/<run-id>/`.

## Installation details

The installer is `opencode-teamwork install`. It:

1. Resolves your config path: `$OPENCODE_CONFIG_DIR/opencode.json`
   or `~/.config/opencode/opencode.json`.
2. Asks which preset (or `custom` for per-role model selection).
3. Deep-merges the patch into your existing config. Doesn't touch
   anything else.
4. Adds `opencode-teamwork@latest` to the `plugin` array.
5. Prints the model assignments and tells you to run `opencode`.

### Flags

```bash
# Use a preset
opencode-teamwork install --preset anthropic
opencode-teamwork install --preset team
opencode-teamwork install --preset google
opencode-teamwork install --preset openai
opencode-teamwork install --preset free

# Overwrite existing config
opencode-teamwork install --reset

# Print what would be written, then exit
opencode-teamwork install --print

# Non-default config path
opencode-teamwork install --config /path/to/opencode.json
```

### What gets written

```json
{
  "plugin": ["opencode-teamwork@latest"],
  "agent": {
    "team/orchestrator": { "model": "anthropic/claude-sonnet-4-5" },
    "team/proposer":     { "model": "anthropic/claude-sonnet-4-5" },
    "team/falsifier":    { "model": "anthropic/claude-sonnet-4-5" },
    "team/synthesizer":  { "model": "anthropic/claude-sonnet-4-5" },
    "team/verifier":     { "model": "anthropic/claude-sonnet-4-5" },
    "team/scout":        { "model": "anthropic/claude-sonnet-4-5" }
  }
}
```

You can edit this file by hand. The plugin doesn't care which model
each role uses; it just dispatches.

## Patterns

### v2 (DAG-based) patterns

| Pattern | Topology | Use when |
|---|---|---|
| `small-focused` | 1 builder + 1 reviewer loop | Single self-contained fix |
| `distributed-coding` | N workers in parallel + verifiers | Multi-module build, migration |
| `long-proof` | 1 strategist + 3-5 searchers + formal checker | Math/TCS proof, Lean/Coq |
| `massive-proof-swarm` | meta-coord + 100+ searchers | Open conjecture, opt-in only |
| `document-review` | 1 chair + 3 critics + 1 aggregator | Paper / RFC / audit |

### v1 (legacy) pattern

`iterative-coding` — a single proposer + falsifier + verify loop, no
synthesis, no DAG. Use `/team-orchestrate --pattern iterative-coding`
to invoke.

Force a topology:
```bash
/teamwork --topology long-proof "prove X"
```

If you don't force one, the sentinel infers from the spec and asks
one short question if it can't tell.

## Manual install (no CLI)

If you don't want to use the installer, you can drop the agent
files into your project's `.opencode/agents/team/` directory. The
files are in `src/cli/templates/` in this repo. The plugin won't
load the `team/*` slash commands that way (those require the plugin),
but the agents themselves will work.

## Outputs

### v2 (DAG-based)

```
.opencode/teamwork/<session-id>/
├── prompt_draft.md         # from crafter
├── plan.dag.json           # task dependency graph (Zod-validated)
├── state.json              # sentinel state (for resume)
├── costs.json              # running cost / budget tracker
├── worktrees/
│   ├── sentinel/           # sentinel's worktree
│   ├── agent-builder-1/    # one per worker
│   └── agent-builder-N/
├── spec-<taskId>.json      # scoped spec per worker
├── patch-<taskId>.diff     # worker's output
├── summary-<taskId>.md     # worker's self-report
├── verify-<taskId>.json    # verifier's report
└── final.md                # the answer (sentinel writes)
```

### v1 (legacy)

```
.teamwork-runs/
└── 2026-08-28T12-34-56-abc123/
    ├── scout-report.md
    ├── candidates/
    │   ├── cand-1.md
    │   ├── cand-2.md
    │   └── cand-3.md
    ├── critiques/
    │   ├── crit-1.md
    │   ├── crit-2.md
    │   └── crit-3.md
    ├── synthesis/
    │   └── syn-1.md
    ├── verify/
    │   └── v-1.md
    ├── pitfalls.md         # carried across rounds
    └── final.md            # the answer
```

`final.md` is the thing to read first. It links to the supporting
artifacts and lists the open pitfalls.

## When NOT to use Teamwork

- A simple, well-scoped coding task ("rename this function", "add
  this log line", "explain this line"). The default opencode `build`
  agent is faster.
- Anything that fits in one model context. Teamwork's overhead is
  real; you spend tokens on 3-5 candidates when one would have
  worked.
- Production deployment. Use the `build` agent for that. Teamwork is
  for the exploration phase, not the ship phase.

The orchestrator asks once: "Skipping Teamwork — I'll work as a
single agent. OK?" before falling back.

## Comparison to upstream

| | Antigravity `/teamwork-preview` | opencode-teamwork v0.2 |
|---|---|---|
| Patterns | 5 | 6 (added `small-focused`) |
| Models | Gemini 3.x only | Any opencode-supported model |
| Hosting | Closed, Antigravity account | Open source, your own opencode |
| Cost control | Bundled with Antigravity plan | You pay your provider directly; per-session budget guardrails |
| Round cap | Dynamic, expensive | Topology-defined, sane defaults |
| Verification | Anti-leak sandboxed oracles (Spike sandbox, etc.) | Whatever the user has set up; structured JSON reports |
| DAG engine | Yes | Yes (`plan.dag.json`, topological dispatch) |
| Worktree isolation | Yes (per agent) | Yes (per agent) |
| Typed artifact bus | Yes (spec, plan, patch, verification_report) | Yes (same shape, Zod-validated) |
| Cost tracking | Yes | Yes (`costs.json` per session) |
| Session checkpoint / resume | Yes | Yes (`state.json` on every transition) |
| Prompt crafter (9-step wizard) | Yes | Yes (`/teamwork-craft`) |

We're not trying to out-Google Google. We're trying to make the
*pattern* usable. The interesting thing about Teamwork isn't the
Gemini integration — it's the falsifier loop and the pitfall
registry. Those are now yours.

## Development

```bash
git clone https://github.com/aditya0si/OpenCode-Team
cd OpenCode-Team
bun install
bun run build
bun dist/cli/index.js install --print   # test the installer
```

The build emits:
- `dist/index.js` — the opencode plugin entry (v1).
- `dist/server.js` — same, for v2 host compatibility.
- `dist/cli/index.js` — the `opencode-teamwork` CLI.

## Contributing

PRs welcome. Areas where help is useful:
- More patterns (security audit, perf optimization, etc.).
- More presets (Anthropic, Google, OpenAI, etc.).
- Better verifier heuristics.
- Smoke tests under `scripts/`.

See `CONTRIBUTING.md` for the conventions.

## License

MIT. See `LICENSE`.
