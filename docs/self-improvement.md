# Self-improving runs — design

Status: **designed, not built.** The prerequisite (`events.jsonl`, an
append-only trace of every run) now ships. This document describes the loop that
log makes possible, so it can be built against real data instead of guesses.

The short version: **do not fine-tune anything.** The artifact worth improving is
the *orchestration policy* — which topology for which kind of task, which model
per role, which checks a task class must pass. That is small, versionable,
testable data, and improving it is measurable in a way weight updates are not for
a project this size.

## The policy is data, not prose

`src/policy.ts` already holds the routing table; `.teamwork/policy.json` in a
project overrides it. The fields the loop may touch:

```jsonc
{
  "version": 7,
  "parent": 6,
  "budget": { "perTaskUsd": 2.5, "perSessionUsd": 20, "haltAtPct": 80 },
  "routing": {
    "taskClass:bugfix-single-file": {
      "ladder": ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-5"],
      "topology": "small-focused",
      "requiredChecks": []
    },
    "taskClass:auth-change": {
      "ladder": ["anthropic/claude-sonnet-4-5"],
      "requiredChecks": ["adversarial:privilege-escalation"]
    }
  }
}
```

Two rules make this safe to edit:

1. **The verifier's rubric and the evaluation set are not in this file.** They
   change only through human review. A loop that can edit both the work and the
   checker will learn to satisfy the checker.
2. Every accepted change is a versioned diff with a benchmark table attached —
   including the changes that were *rejected*.

## The loop

Stages L0–L6, each one a place where a claim can be falsified before it costs
anything.

### L0 — Telemetry (exists today)

`events.jsonl` already records, per task: dispatch with the model used, every
verifier round with each check's `name`, `type`, `passed`, `cmd`, `exitCode` and
`stdoutSha256`, cost, attempt number, and terminal state (completed, failed,
dead-letter) with the reason. Add two fields to make it a learning signal:

- `humanAccepted` — one keystroke in the UI per run ("did this help? y/n/edit").
  This is the only ground truth about whether a PASS was *real*.
- `failureClass` — filled by L1, not by the agent.

### L1 — Attribution

Cluster `fatalFindings` into a closed label set:
`spec-ambiguity | missed-edge-case | wrong-interface | hallucinated-api |
test-not-run | scope-creep | merge-conflict | environment | budget-exhausted`.

Then mine for *conditional* signatures, never global averages:

- "hallucinated-api is 6× more likely when the task class has no type checker in
  its ladder" → a policy delta.
- "escape rate triples when the verifier model is weaker than the worker" → a
  routing constraint.

Surface it as a report, not an action: `teamwork learn --since 30d` prints the
top patterns with counts and confidence intervals.

### L2 — Proposer

A "policy architect" role emits a **typed delta**, never prose:

```jsonc
{
  "op": "add",
  "path": "/routing/taskClass:auth-change/requiredChecks/-",
  "value": "adversarial:privilege-escalation",
  "hypothesis": "3 of 5 recorded auth defects passed unit checks; this check fails on those repros",
  "expectedEffect": { "escapeRate": -0.15, "costDeltaUsdPerTask": 0.08 },
  "falsificationPlan": "replay the 12 recorded auth tasks; reject if pass rate drops or cost rises >20%"
}
```

**Constrain the delta grammar**: at most 3 fields per epoch, no rubric or
evaluation-set paths, no deletion of a check that has ever caught a real defect.
Bounded mutation rates are what stop a self-modifying loop from drifting.

### L3 — Falsifier (on the hypothesis)

An adversarial agent tries to kill the proposal *before* evaluation budget is
spent:

- "n=3 — you cannot detect a 5% change."
- "This effect is confounded: the task mix changed that week."
- "This delta lets the worker choose its own verifier. That is self-certification
  with extra steps."

Only proposals that survive reach L4. This is the stage most self-improving
systems skip, and the reason they degrade.

### L4 — Shadow replay

Incumbent vs candidate, offline, on a frozen benchmark of recorded tasks: same
repo commits, same recorded tool outputs, same provider parameters, N≥3 repeats,
**stratified by task class**. Adopt only if all hold:

- `passRate(candidate) ≥ passRate(incumbent)` per stratum, not just pooled;
- `escapeRate` not worse;
- `costPerSuccess ≤ +20%`;
- latency within budget.

Write the table into `policy-changelog.md`, rejections included.

### L5 — Canary and rollback

`policy@next` serves a fraction of live runs. Roll back automatically on
escape-rate or cost regression. Promote after k clean canary runs.

### L6 — Human gates

Verifier rubric, evaluation set, and any change touching permissions require
human review. Not negotiable.

## The metric that keeps it honest

Track **escape rate**: the fraction of verifier PASSes that a human (or a
stronger independent judge) later rejects. Without it the loop optimises the only
thing it can see — the verifier — and "improvement" means "we taught the team to
satisfy the checker". It is also the metric that makes L4 able to reject a
candidate that raises the pass rate while raising escapes.

## Failure modes to design against

| Failure mode | Mechanism | Mitigation |
|---|---|---|
| Verifier capture / Goodhart | the loop edits prompts *and* the checker | rubric is human-owned; escape rate is first-class; check retirement needs evidence |
| Task-mix drift | "improvement" is really a change in the week's work | stratify by task class; freeze the benchmark |
| Luck / nondeterminism | adopted on one lucky run | N≥3, seeds, recorded provider params, effect size vs measured noise floor |
| Unfalsifiable deltas | "write better prompts" is not a hypothesis | typed JSON-Patch deltas with an explicit falsification plan (L2/L3) |
| Cost asymmetry | the learner costs more than the win | nightly epochs only; only for task classes with n≥20 runs; budget the learner itself |

## Build order

| Milestone | Content | Acceptance test |
|---|---|---|
| M3 | `trace.jsonl` export from `events.jsonl`, failure taxonomy, `teamwork learn` report | golden-set test: injected patterns in 20 recorded runs are found (precision/recall thresholds) |
| M4 | `policy.json` schema, `teamwork bench --candidate`, per-stratum comparison, changelog | a *rejected* delta in CI — a plausible change the benchmark proves is not an improvement |
| M5 | canary routing, auto-rollback, escape rate in the run summary | a simulated regression triggers rollback |

M3 is mostly a projection of data that already exists on disk. That is the point
of having built the log first.
