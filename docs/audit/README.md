# Completion auditor — usable configuration (OpenCode 1.18.13)

The completion auditor is an **additive, static-only** part of the
`opencode-teamwork` plugin. It captures a verifier-owned snapshot of the current
candidate, binds a task whose acceptance criteria come from *trusted, human
configuration*, records byte-level artifact observations, and renders a
deterministic, replayable report.

It is deliberately narrow. It does **not** prove that code is correct, does not
intercept every completion, and does not repair anything. It verifies a bounded,
byte-level claim inside an explicitly scoped delta snapshot — and it says so in
the report.

## What it is not

- Not a semantic correctness prover. A requirement such as "the report explains
  the design" cannot be certified by static bytes; a criterion without a
  registered byte-level predicate can never be satisfied.
- Not a test-suite completeness certifier. Same-process discovery counts are a
  non-decisive observation, not proof (see the separate fixture runner below).
- Not an interception hook. There is no idle-hook certification and no automatic
  repair. The tools are called manually.
- Not a sandbox and not an authenticator. Store integrity is a hash chain, not a
  signature; the snapshot manifest is unsigned.

## Prerequisites

- OpenCode **1.18.13** — the only version this package is verified against. Newer
  host versions are **unverified** and no compatibility is asserted for them.
- The host entry `dist/plugin.js` (the default-export-only adapter) — **not**
  `dist/index.js`, which keeps non-function library exports and is rejected by
  the host loader.
- A trusted **verifier-owned** `auditBaseRoot` directory that is *outside* the
  audited candidate tree. There is deliberately no in-candidate default: with no
  configured base root the tools fail closed with `SETUP_REQUIRED` before writing
  anything.

## The three manual tools

| Tool | Purpose |
|---|---|
| `teamwork_audit_plan` | Capture a verifier-owned delta snapshot, bind the task (trusted confirmed criteria when configured), and mint an opaque `auditId`. Optionally asks the bounded planner for *unconfirmed* criterion suggestions. |
| `teamwork_audit_check` | Record a store-owned static artifact observation for one or more criteria. Execution is refused unless a genuine human approval exists (never a model boolean). |
| `teamwork_audit_report` | Replay the audit deterministically, mark it `STALE` if the candidate changed, and write `report.md` + `report.json`. Every missing required criterion stays visible. |

Addressing is by opaque `auditId` only. A tool never accepts an arbitrary
filesystem root.

## Configuration

The plugin is configured through the OpenCode `plugin` array. The auditor only
reads **trusted plugin options** — the model can never supply them.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      // Path/subpath to the default-only host entry. For an installed package
      // this is "opencode-teamwork/plugin"; a file URL also works.
      "opencode-teamwork/plugin",
      {
        // REQUIRED. Absolute, verifier-owned, outside the audited candidate.
        "auditBaseRoot": "/home/me/.local/share/opencode-audit",

        // OPTIONAL but recommended. Absolute path to a trusted confirmed-task
        // JSON file (see below). Without it the audit is bound UNCONFIRMED and
        // can never verify the original task.
        "auditConfirmedTaskFile": "/home/me/.config/opencode/audit-confirmed-task.json",

        // OPTIONAL. Trusted adapter policy. Static-only is the default.
        // { "mode": "STATIC_ONLY", "executionEnabled": false, "plannerEnabled": false }
        "auditPolicy": { "mode": "STATIC_ONLY", "executionEnabled": false },

        // OPTIONAL. Enable the bounded planner transport (suggestions only).
        // Requires a real host provider and is off by default.
        "auditPlanner": false
      }
    ]
  ]
}
```

Two machine-checkable examples ship alongside this document:

- [`opencode.config.example.json`](./opencode.config.example.json)
- [`confirmed-task.example.json`](./confirmed-task.example.json)

On Windows, JSON string paths must escape backslashes (`"C:\\\\Users\\\\me\\\\audit"`)
or use forward slashes (`"C:/Users/me/audit"`).

`test/audit/docs.test.ts` loads these files, substitutes the placeholders with
real disposable paths, and exercises the exact flow below. If the examples drift
from the implementation the test fails.

### Confirmed task file

A confirmed task is the *only* source of bound acceptance criteria. It is loaded
from trusted configuration and matched by `taskId` + `taskRevision`.

```jsonc
{
  "schemaVersion": 1,
  "taskId": "my-task",
  "taskRevision": "rev-1",
  "statement": "Deliver artifact.txt with the exact payload.",
  "criteria": [
    {
      "id": "R1",
      "span": { "text": "artifact.txt", "start": 8, "end": 20 },
      "required": true,
      "acceptanceType": "ARTIFACT",
      "artifactExpectation": {
        "path": "artifact.txt",
        "presence": "present",
        "digest": "<64-char-sha256-of-the-required-bytes>"
      }
    }
  ]
}
```

Rules enforced by the schema:

- `artifactExpectation` is valid only for an `ARTIFACT` criterion.
- `presence: "present"` requires a concrete 64-hex `digest`; `presence:
  "absent"` requires `digest: null`.
- `span` must be exact: `end - start` must equal the text length.
- A predicate `path` that carries a known secret pattern (for example
  `password=CANARY123`) is **refused** before anything is bound or persisted —
  it is never silently rewritten, because rewriting the path would change which
  bytes the predicate checks.

`confirmation: HUMAN_CONFIRMED` is recorded **historically, per task revision**:
it attests that the criteria stored with that `taskId`/`taskRevision` came from
trusted configuration when the audit was created. It is not a live "currently
approved" flag. The `taskId`/`taskRevision` inputs are immutable for a bound
audit, and re-planning the same revision with a *different* confirmed
configuration is refused (`TASK_REVISION_CONFLICT`) rather than implying the new
configuration was the approved one. Bump the `taskRevision` to change a confirmed
binding.

## Manual static flow

1. `teamwork_audit_plan` — with the verbatim task text and the task identity.
   When a confirmed task is configured for that `taskId`/`taskRevision`, its
   criteria are bound and the audit is `HUMAN_CONFIRMED`. Model-supplied criteria
   are stored only as unconfirmed suggestions, never bound.
2. `teamwork_audit_check` (`kind: "artifact"`) — for each registered artifact
   criterion, with the registered `path`.
3. `teamwork_audit_report` — writes `report.md` / `report.json` under the audit
   directory. The report lists the overall verdict
   (`VERIFIED_WITHIN_SCOPE` / `NOT_COMPLETE` / `INCOMPLETE_EVIDENCE` / `STALE`),
   per-criterion state, evidence IDs, exclusions and limitations.

## Execution is blocked by design

`teamwork_audit_check` with `kind: "execution"` is refused:

- a model-supplied `approval` is rejected (`MODEL_APPROVAL_REJECTED`);
- with no provable human-approval authority in the host, the request reports
  `AUDIT_EXECUTION_BLOCKED` (`HUMAN_APPROVAL_UNAVAILABLE`) and runs nothing.

Only a trusted-code `AuditExecutionSeam` could authorize a run, and even then the
receipt is imported as non-decisive. No model-facing mint or approval exists.

## Optional disposable fixture runner (Task 4)

A separate, optional Docker runner (`scripts/audit-runner-integration.ts`) can run
an approved fixture check inside a disposable container. It is **not** wired into
the manual tools and is not enabled by default. Its important limit: the candidate
test module runs in the same Python process as the verifier harness, so its counts
are a non-decisive framework observation. **Suite completeness cannot be certified
by this runner** — only process completion is proven.

## Honest limits

- **Delta snapshot, not the whole repo.** A capture observes Git-reported deltas
  for the declared scope; unchanged tracked bytes and excluded paths are never
  included (`scope.delta` is always `true`).
- **Same-user store is a declared trust assumption, not isolation.** On a
  same-user host the OS does not make the verifier-owned store unreachable to the
  candidate or the model. Opaque-id addressing limits what the model can *name*,
  not what the host permits.
- **Best-effort durability.** Metadata head updates are crash-recoverable but not
  an atomic multi-file replacement and **not durable without an fsync** there are
  no fsync guarantees, and the store is unsigned. Hash-chain integrity is
  integrity, not authentication.
- **Registry publication is fail-closed, not crash-proof.** The audit registry is
  published with a single rename over the previous file. A failed rename (or a
  crash at that instant) leaves the **previous registry byte-for-byte unchanged**
  and propagates a publication error; it does not silently half-apply. There is
  no fsync, no multi-file transaction and no full crash-recovery guarantee — this
  is a different mechanism from the evidence store's backup-swap recovery, and a
  lone `.tmp-*` file may remain after a failure.
- **Static trust is byte-level and predicate-bound.** Only a registered
  path/presence/digest predicate can be observed; the report re-derives it from
  the registered snapshot copy on every read and rejects forged captures.
- **No automated repair, no interception.**
- **Redaction is pattern/key-based defence in depth.** Adapter-persisted and
  returned task/planner text is redacted with contextual patterns and the original
  is kept only as a digest/length; a secret whose shape matches no known
  key/pattern remains a limitation.

## Model provider disclosure

The optional planner uses the **already-configured host provider** and adds no
credentials. It creates a fresh verifier-root planner session and sends only the
bounded acceptance text and scope description. Planner output is untrusted
suggestions. If you enable `auditPlanner`, model-provider data-handling applies to
the bound acceptance text — local evidence persistence does **not** imply the
provider never saw the prompt.

## Evaluation harness

`bun run audit:eval` loads the fixed 30-fixture catalogue
(`test/audit/fixtures/`), evaluates every fixture against its **regression
expectation**, and fails non-zero on any missing/duplicated fixture, label
mismatch, error, false-complete or reproducibility failure. It counts every
fixture in code and reports exact denominators.

Honesty notes:

- The labels are **regression expectations authored by the task writer**, not
  independently human-reviewed ground truth. The catalogue is a fixed regression
  check, not a statistical scientific evaluation, and proves nothing about
  accuracy, coverage or real-world completion.
- The `development`/`held_out` split is **metadata only**, not a train/test
  isolation or held-out guarantee.
- `schema` fixtures are synthetic, pre-attributed reductions; the
  wrong-behaviour-green-tests and baseline-breakage shapes run **no actual
  semantic or baseline test**.
- The baseline-vs-planner comparison is always `blocked`/no-data; the evaluator
  measures no planner and exposes no seam for injecting comparison numbers.
- **Repo-only.** The catalogue, fixtures and CLI live in the source repository
  (`test/audit/fixtures/`, `scripts/audit-eval.ts`) and are **not included in the
  published package**, so `bun run audit:eval` is a development/verification
  command and is not available to an installed consumer. The
  `opencode-teamwork/audit/evaluation` export (the `runAuditEvaluation` API) *is*
  shipped, but it is only useful with an external fixture catalogue; no fixtures
  ship with the package.
