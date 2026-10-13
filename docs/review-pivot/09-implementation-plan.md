# Completion auditor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. User-selected method: OpenCode Go DeepSeek V4.1 Flash implements each bounded task; Hermes independently reviews and runs checks; findings return to the same writer; advance only after evidence passes.

**Goal:** Deliver an OpenCode-first manual completion auditor with task/claim/evidence ledger, immutable candidate identities, explicit scoped verdicts and replayable reports, without modifying the user's active workspace.

**Architecture:** Add an audit subsystem to public v0.3.0 in an isolated branch/worktree. Deterministic validation, policy, snapshot and verdict logic are independent of model prose. OpenCode adapter exposes manual tools; optional execution requires explicit approval and a tested disposable runner.

**Tech Stack:** Existing TypeScript/Bun/Zod toolchain; Node filesystem/process APIs; installed OpenCode 1.18.13 compatibility probe; optional Docker runner (observed server 29.6.2).

**Spec:** docs/review-pivot/05-concept.md, qualified by 08-independent-review.md. This plan is proposed and awaits user review before implementation.

## Global Constraints

- Preserve local v0.2.1 dirty README.md, SKILL.md, src/cli/index.ts and research docs. Build from public v0.3.0 281821a in a separate worktree/branch; copy docs there explicitly, without overwriting the original checkout.
- No push, publish, deployment, production writes, credential reading or autonomous repair.
- One writer at a time. Requested model spelling needs confirmation: available identifier is opencode-go/deepseek-v4.1-flash. Do not silently substitute another model.
- Explicit audit first; no idle-hook certification or universal completion interception.
- Model cannot change policy, promote missing evidence, or override deterministic mandatory failure.
- Candidate commands never run natively on host; execution disabled until disposable-runner safety gates pass. Static-only mode must remain useful and honest.
- SUPPORTED/CONTRADICTED/UNVERIFIED/BLOCKED claim states; VERIFIED_WITHIN_SCOPE/NOT_COMPLETE/INCOMPLETE_EVIDENCE/STALE overall outcomes. Waiver is an annotation, not proof.
- Evidence stored outside candidate writable tree; local persistence does not imply model-provider data remains local.
- Windows and Linux safety assertions need separate evidence. Unknown capabilities block execution.

## Review Focus

1. Valid-looking evidence from another snapshot/task must not certify completion (Tasks 1–3).
2. Symlink escapes, secrets and concurrent edits must not enter snapshots or preserve a stale pass (Task 2).
3. Zero tests/skips/print-only success and baseline failures need explicit limits, not blanket pass/fail (Tasks 3, 6).
4. Candidate content or malicious commands cannot widen runner policy or write evidence (Task 4).
5. Cancellation, nested/duplicate sessions and broken config must not recurse, lose state or damage user settings (Tasks 0, 5–6).

## Gate protocol for every task

- [ ] Writer adds focused tests and demonstrates RED before implementing behavior; record actual commands and exit codes.
- [ ] Writer implements only scoped files and runs focused GREEN checks.
- [ ] Hermes reads diff/source, verifies requirements and independently executes tests/typecheck relevant to task. Include an adversarial input, not only happy-path tests.
- [ ] Hermes records findings in task findings MD; writer repairs; Hermes rechecks exact candidate. Repeat until no unresolved blocking finding.
- [ ] Record acceptance evidence and actual limitations in progress.md before next task. No completion based solely on writer's final response.

## Task 0: Safe baseline and compatibility/safety probe

**Files:** audit-build/task_plan.md, audit-build/findings.md, audit-build/progress.md; scripts/audit-compatibility.ts and tests/audit/compatibility.test.ts in isolated branch only.
**Produces:** supported-host contract, tested event/tool signatures, evidence-store location strategy and feature flags. No invented enforcement guarantee.

- [ ] Create isolated v0.3 worktree, preserve original dirty-file hashes, copy reviewed research docs, inspect engine/guard/tools/schema APIs and install dependencies without candidate lifecycle scripts where feasible.
- [ ] Run existing v0.3 verify baseline; if failures, attribute and fix only necessary build blockers through writer/review loop.
- [ ] Probe real OpenCode 1.18.13 manual tool registration, parent/verifier session handling, cancellation and available permissions. Record actual host observations separately from unit mocks.
- [ ] Inspect Docker platform/security controls and reject unsafe fallback. Clarify documentation retrieval provenance: different research sessions are not inherently contradictory.
- [ ] Gate: baseline evidence captured, original dirty workspace hashes unchanged, actual adapter interfaces known, static-only default agreed. If live adapter cannot be probed, STOP and report rather than fabricating integration.

## Task 1: Validated contracts and fail-closed verdict core

**Create:** src/audit/contracts.ts, src/audit/verdict.ts, tests/audit/verdict.test.ts.
**Interfaces:** AuditInput schema contains taskId/taskRevision, criterion IDs/exact spans/required flag, candidateId, claim spans and evidence records. Evidence includes checkId, candidateId, taskRevision, criterionIds, completion state, origin, result and limitations. `evaluateAudit(input: AuditInput): AuditReport` is pure and validates unknown input via Zod boundary.

- [ ] RED tests: missing required evidence -> INCOMPLETE_EVIDENCE; mandatory contradiction -> NOT_COMPLETE; all required supported -> VERIFIED_WITHIN_SCOPE; stale identity -> STALE; optional unsupported claim visible without failing required work; waiver never becomes SUPPORTED.
- [ ] Reject duplicate IDs, unknown criterion references, invalid evidence statuses, missing scopes and malformed values. Model-supplied status alone cannot count as captured execution evidence.
- [ ] Implement schemas and deterministic reducer; no model/network dependency.
- [ ] Gate: focused tests + typecheck pass; adversarial forged/stale/partial inputs cannot yield complete.

## Task 2: Safe snapshots and freshness

**Create:** src/audit/snapshot.ts, tests/audit/snapshot.test.ts.
**Interfaces:** `captureSnapshot(options: SnapshotOptions): Promise<SnapshotManifest>`; `checkFreshness(manifest: SnapshotManifest): Promise<FreshnessResult>`. Manifest includes exact file hashes, base revision, dirty/untracked/deleted scope, exclusions and task revision. Options explicit root/scope/max bytes; no defaults admitting secrets or external paths.

- [ ] RED tests using temporary real Git repos: staged/unstaged/untracked/deleted files captured correctly; pre-existing edits preserved; changed content invalidates identity; symlink escape and traversal denied; oversized files excluded visibly.
- [ ] Implement bounded copy into verifier-owned location, protected policy/evidence paths excluded. No reset/stash/commit on original candidate.
- [ ] Gate: original content hashes unchanged, exact dirty snapshot reproducible, concurrent edit yields stale instead of current pass.

## Task 3: Evidence ledger and readable report

**Create:** src/audit/evidence-store.ts, src/audit/report.ts, tests/audit/evidence-store.test.ts, tests/audit/report.test.ts.
**Interfaces:** `appendCheck(store: EvidenceStore, receipt: CheckReceipt): Promise<void>`; `readAudit(store: EvidenceStore): Promise<AuditRecords>`; `renderMarkdown(report: AuditReport): string`. Receipt records argv/cwd/times/exit-or-signal/snapshot/task/runner/discovery/origin/output refs and limits. Schema-version records; no arbitrary path dereference.

- [ ] RED tests: truncated/corrupt records, duplicate IDs, unauthorized references, output boundedness, secret redaction, failed/nonexecuted checks, and cancellation terminal state.
- [ ] Implement protected atomic metadata writes and honest integrity limits. Hash chains are not authenticated attestations; model/imported logs retain origin and cannot impersonate runner receipts.
- [ ] Render claims, findings, scope, exclusions, limitations and exact evidence IDs to Markdown/JSON with consistent statuses.
- [ ] Gate: report replay produces same verdict; no fabricated missing output; malformed evidence fails closed.

## Task 4: Optional authorized disposable execution

**Create:** src/audit/policy.ts, src/audit/runner.ts, tests/audit/runner.test.ts, scripts/audit-runner-integration.ts.
**Interfaces:** `authorizeCheck(plan: CheckPlan, policy: AuditPolicy): AuthorizationResult`; `runCheck(approved: ApprovedCheck, context: RunnerContext): Promise<CheckReceipt>`. Approval binds exact argv, snapshot, image/security config, mounts/network/resource/time/output constraints; shell string execution prohibited by default.

- [ ] RED tests: injection-like argv, policy escalation, credential/env inheritance, external mounts, unapproved network, privileged/unconfined fallback, output flood, timeout and nonzero exits.
- [ ] Run approved fixture checks only in disposable Docker environment with no home/socket/secrets mounts; sanitize environment; candidate cannot write verifier metadata. Static-only default if safety capabilities absent.
- [ ] Discovery adapters must identify zero/skipped tests or state unknown; stdout PASS alone never proves a test suite ran.
- [ ] Gate: REAL integration evidence for allowed check, denied escape, timeout, failure, blocked missing protections and protected store. Docker configuration is not universal malicious-code containment.

## Task 5: OpenCode manual adapter and optional bounded model planning

**Create:** src/audit/tools.ts, src/audit/planner.ts, tests/audit/plugin.test.ts; modify src/index.ts and existing build exports only as needed.
**Interfaces:** tools `teamwork_audit_plan`, `teamwork_audit_check`, `teamwork_audit_report` (proposed names finalized from Task 0 host contract). Planner returns validated criterion/question proposals; human confirms ambiguous criteria. Check tool requires explicit approved policy and runner authorization.

- [ ] RED tests: missing task, empty criteria, malicious completion narrative, model/provider error, malformed planner output, nested verifier session, duplicate request, cancellation and stale report.
- [ ] Register additive audit tools without breaking current orchestration/config overrides. Original acceptance text stored separately from generated interpretation. Model calls via actual host SDK tested in Task 0, budgeted, no new provider credentials.
- [ ] Default static-only report; do not market mandatory interception. Require evidence refs for semantic conclusions; generated tests/checks need runner approval.
- [ ] Gate: actual OpenCode session invokes manual audit flow and saves matching report; existing plugin integration/smoke still pass; prompt injection cannot alter policy. No mocked API response substitutes for live host evidence.

## Task 6: Evaluation, adversarial review and usable delivery

**Create:** tests/audit/fixtures/*, scripts/audit-eval.ts, docs/audit/README.md; update package scripts/exports and additive user-facing docs in isolated branch only.
**Interfaces:** `runAuditEvaluation(fixtures: AuditFixture[]): EvaluationSummary` records labels, verdicts, denominators, errors, blocks and evidence refs.

- [ ] Curate proposed 30 fixtures: 10 complete, 10 contradictory/incomplete, 5 blockers, 5 stale/injection cases; fixed human labels with development/held-out split. Include docs-only valid task, wrong behavior with green tests, fake/empty suite, baseline breakage, missing requirement and demo-fallback payload.
- [ ] Measure deterministic baseline vs planner-enabled auditor if provider access permits; record blocked comparison if unavailable, never manufacture efficacy data.
- [ ] Exercise documented CLI/plugin usage in disposable sample repo; run full existing verify plus audit tests/evaluation; pack dry-run only, no publish.
- [ ] Final independent whole-branch review, iterate repairs, rerun invalidated gates.
- [ ] Gate: all critical regression fixtures have zero false-complete, denominators stated without claiming statistical proof; reports reproducible, original workspace unchanged, actual supported integration verified; remaining limits prominently documented.

## Scope and decision record

Proposed defaults: additive audit mode in same package; Node/TypeScript first; manual task input; static-only by default; no auto-repair; local protected evidence; model provider disclosure; optional approved Docker execution. Compatibility unknowns remain Task 0 blockers, not assumed resolved. Unvalidated browser/account workflows and strong hostile-code guarantees deferred.

## Execution approval

User has chosen sequential OpenCode writer + Hermes review/repair loop. Before any product code: review this written plan, confirm that it captures the intended goal, and confirm exact model identifier opencode-go/deepseek-v4.1-flash. Once approved, execute tasks 0–6 sequentially; do not skip review gates, publish or widen scope without approval.
