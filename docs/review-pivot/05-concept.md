# opencode-teamwork: independent completion verification

**Concrete concept v0.1 — proposed, not implemented or approved for build.**
Research date: 2026-10-11. Intended reader: user deciding whether to pivot the project.

## 1. The idea

> Your coding agent says it is done. Teamwork checks what the evidence actually supports.

An OpenCode-first plugin that reviews coding-agent work against the user's original request, independently checks observable claims, and produces a traceable completion report. It is not another coding agent, a model jury, an automatic fixer or a guarantee of bug-free software.

Primary user: developers using coding agents locally who need a trustworthy handoff before accepting, committing or deploying work. Initial scope: repository-based coding tasks, bounded test claims and opt-in public endpoint checks. General factual-answer auditing is not in the MVP.

**Positioning hypothesis:** task-to-evidence auditing complements diff-focused review. Independent review itself is not unique. Product usefulness, demand and incremental accuracy must be demonstrated.

## 2. Core issues and how we address them

| Core issue | Proposed fix | Important limit |
|---|---|---|
| Persuasive done summary without proof | Claim ledger linked to runner-owned evidence | A receipt proves an observed execution, not universal correctness |
| Agent verifies only what it mentions | Extract requirements from original task separately | Ambiguous task needs user clarification |
| Same-context reviewer rubber-stamps | Factored verification questions in bounded fresh context | Fresh context/different model is not guaranteed independence |
| Green tests exercise wrong behavior | Map checks to acceptance criteria; independently approved reproducer | Tests remain imperfect oracles |
| Empty, skipped, weakened or print-only tests | Inspect discovery, assertions and changed test configuration | Framework-specific adapters required |
| Demo fallback masks broken integration | Observe real public entry point and semantic response mode | One successful request is not uptime/load evidence |
| Stale logs or concurrent edits | Bind evidence to candidate/task/environment/policy identity | Hashes need a trusted capture boundary |
| Missing access interpreted as pass | Explicit unverified/blocked status | Missing proof is not proof of a defect |
| Reviewer invents defects | Require locations, impact, reproduction/disconfirmation and evidence | Static concerns may remain hypotheses |
| Malicious repository/transcript instructions | Untrusted-data separation plus runner authorization outside candidate tree | Prompt warnings alone do not enforce security |
| Test command mutates/exfiltrates | Disposable runner, sanitized environment, restricted network/resources | Read-only model and worktree are not OS sandboxes |
| Endless review/repair loop | Fixed cost/time limits, no auto-repair in MVP | Budget exhaustion prevents completion certification |

Research trace: primary R1-R12 in 01-primary-research.md; qualitative signals in 02-developer-signals.md; timestamp-backed video requirements in 03-video-research.md. The fixes above are our engineering proposals, not paper-proven performance claims.

## 3. Chain of verification: the actual workflow

1. **Capture contract.** Preserve exact task spans and human-approved acceptance criteria. For vague tasks, propose criteria and ask; do not quietly define success after seeing the implementation.
2. **Pin candidate.** Capture base revision, dirty/untracked relevant files, exact content manifest, exclusions and task revision. Keep user's live files untouched.
3. **Build two ledgers.** Task-derived requirements catch omissions. Response-derived claims catch overstatement. Keep optional agent claims separate from mandatory requirements.
4. **Plan factored questions.** Ask observable questions without exposing each answerer to persuasive builder conclusions. Example: which response demonstrates cross-tenant access is rejected, not is auth good?
5. **Authorize evidence plan.** Choose cheap static/artifact checks first, then targeted execution. Model output cannot expand command/network/credential privileges.
6. **Gather evidence independently.** Trusted runner captures commands, exit code, test discovery, output hashes, environment and security configuration. Existing logs are imported with explicitly lower/unknown trust unless provenance is established.
7. **Attempt disconfirmation where appropriate.** Bug-fix reproducer on baseline and candidate; negative cases for security/idempotency; inspect whether a candidate changed/skipped tests. Mutation controls only in a disposable copy, opt-in and budgeted.
8. **Reconcile by rules.** LLM interprets bounded semantics; deterministic core assigns outcomes from evidence and unresolved requirements. A model cannot override a failed mandatory check with prose.
9. **Check freshness and publish.** Compare candidate identity before reporting. Any change invalidates current certification. Show scope, blockers, evidence and next actions.

CoVe-inspired decomposition is a design pattern here. The original paper's factual-generation results do not establish coding-agent verification accuracy.

## 4. Verdict semantics (one vocabulary)

### Per requirement/claim

- **SUPPORTED:** sufficient evidence for the specific bounded condition.
- **CONTRADICTED:** reliable evidence conflicts with the condition or claim.
- **UNVERIFIED:** insufficient evidence, ambiguity or inconclusive result.
- **BLOCKED:** a needed check could not run due to access, policy, environment or budget.

### Overall report

- **VERIFIED_WITHIN_SCOPE:** all required criteria supported; snapshot current; required checks completed. Never label simply safe or bug-free.
- **NOT_COMPLETE:** at least one required criterion contradicted.
- **INCOMPLETE_EVIDENCE:** no required contradiction, but at least one required unverified/blocked criterion.
- **STALE:** candidate changed; prior outcome remains historical only.

Cancelled, timed out, denied, skipped, infrastructure-failed and completed are distinct run/check states, not synonyms for claim failure. A failed command is attributed before being called a code defect. Optional unsupported rhetoric remains visible as a finding; it does not imply the core task necessarily failed. Human waivers are recorded as an annotation on the overall verdict (for example, NOT_COMPLETE with a recorded waiver). A waiver is never converted to SUPPORTED evidence, and it never changes the overall state to VERIFIED_WITHIN_SCOPE.

## 5. Example report (illustrative, not a real execution)

Task: deploy a working live-answer service.

| ID | Criterion/claim | State | Evidence |
|---|---|---|---|
| R1 | Public site responds | SUPPORTED | Runner HTTP receipt, exact URL and timestamp |
| R2 | Public chat path completes | SUPPORTED | Complete stream with terminal event |
| R3 | Response uses live generation, not fallback | CONTRADICTED | Terminal payload states demo |
| C1 | Agent says all deployment requirements are done | CONTRADICTED | R3 |
| R4 | Authenticated account flow works | BLOCKED | No approved test identity |

Overall: NOT_COMPLETE. No numeric confidence score. Explain precise failure and minimal reproduction; do not automatically redeploy.

## 6. Architecture proposal

- **OpenCode adapter:** explicit audit request, bounded task/session retrieval, report display. Optional idle prompt later; idle is not proof of completion.
- **Contract/claim planner:** exact-span extraction, ambiguities and criterion mapping.
- **Snapshot service:** immutable candidate manifest, dirty-tree capture, exclusions and freshness.
- **Policy engine:** approved commands, runner capabilities, scope, data handling and budget.
- **Evidence runner:** out-of-process execution with host-specific isolation controls and bounded public HTTP checks.
- **Evidence ledger:** runner-owned schema-versioned records; append-only lifecycle, output hashes and secret redaction.
- **Reconciler:** evidence links plus deterministic verdict reducer; static-review hypotheses never silently become execution facts.
- **Reporter:** readable Markdown and machine-readable JSON with the same statuses.

Logical separation does not require several autonomous agents; the list above names eight logical components, implemented as modules rather than agents. Default one bounded planner/reviewer context, one runner and one reconciliation pass. Additional specialists are risk-triggered experiments, not MVP ceremony.

Execution records include run/check ID, criterion IDs, candidate/task identities, argv/cwd, start/end, process exit/signal, runner/image identity, framework discovery/skips, output artifact references/hashes, security profile, origin and limitations. Hash chains are useful integrity checks, not protection against an attacker who can rewrite the whole store. Evidence writer must be outside candidate control.

## 7. User experience and artifact proposal

Proposed commands (names NOT validated against host APIs yet): review current work, inspect last report, replay authorized checks. Explicit manual invocation first; no always-on blocking messages in MVP.

Flow: choose task/session -> confirm scope/ambiguous criteria -> see execution plan and costs -> approve optional execution -> receive prioritized report -> inspect evidence -> optionally request recheck on new snapshot.

Artifacts: review.md, claims.json, checks.jsonl, findings.md and redacted evidence outputs in a verifier-owned store outside candidate write access. Export a sanitized Markdown bundle on request. Default local retention; configurable deletion. No default cloud upload. Model review necessarily sends approved selected content to the user's configured provider: disclose this separately from local artifact storage. Exclude secrets and private transcripts by policy; redaction is defense-in-depth, not a guarantee.

## 8. MVP boundaries

### Include

- OpenCode adapter for one explicitly supported host/version range.
- Node/TypeScript repository profile first; Python next after separate adapter validation.
- Explicit task input/criterion confirmation plus scoped diff and dirty-file snapshots.
- Deterministic static/artifact review without execution by default.
- Opt-in safe runner for existing checks and independently approved targeted probes.
- Four claim statuses, explicit overall verdict and freshness invalidation.
- Readable reproducible report, bounded cost/time, and immutable policy provenance.
- Deployment checks as opt-in HTTP requests to user-approved URLs, limited by default to GET/HEAD. Any POST, PUT, DELETE, or request that invokes a model, consumes paid usage, or writes state is classed as mutating or costly and requires separate per-URL approval. "Non-mutating" is not assumed for chat or generation endpoints. Browser/account flows later.

### Exclude

- Autonomous repair, deploy/push/merge, credential harvesting or secret reading.
- Generic research/fact-checking and every language/framework.
- Reviewer swarms, unlimited retry loops, scores pretending to be correctness probability.
- Guaranteed host-wide completion gating before compatibility evidence.
- Mandatory mutation testing, arbitrary package installation, production state-changing checks.

## 9. Threat model and truthful guarantees

MVP targets accidental omissions/overstatement in trusted developer repositories, but still treats candidate content as untrusted. Unknown repositories may use static-only review until an adequately tested isolated runner is available. No default native host command execution. A Docker runner must enforce its actual platform-specific configuration, without home/socket mounts or credentials; unavailable protection produces BLOCKED. Windows/Linux runner support needs separate tests. Do not silently fall back to unconfined/privileged execution.

"Read-only" must be defined operationally, because the word alone is not a control. The reviewer's model tools must not write to the candidate tree. Host-repo commands are not assumed safe: git can refresh the index or lock files, and package managers and test runners write caches and generated output. Any command that may write runs only in the disposable copy, and the disposable copy is discarded after the run.

If stronger malicious-code containment cannot be validated, restrict scope rather than claim a secure sandbox. No plugin-level rule guarantees every other plugin/tool or user shell is contained.

## 10. Evaluation before shipping

Create 30 reviewed fixture cases as an initial proposal: 10 genuinely complete tasks; 10 known incomplete/contradictory tasks; 5 legitimate environment/access blockers; 5 stale/injection/adversarial-evidence cases. This is a starter corpus, not sufficient market-wide accuracy evidence.

Cover zero tests, skipped tests, fake pass scripts, deleted assertions, omitted requirement, wrong implementation with green tests, baseline breakage, mocked integration, demo fallback, stale receipts, concurrent edits, duplicate events, cancellation, malicious log instructions and secret/network policy denial. Evaluate both with and without LLM planning.

Compare response-only judge, diff-only reviewer, execution-only gate and proposed auditor using same fixtures/scope/budget. Human labels and criteria fixed before inspecting model verdicts; record disagreements. Separate development fixtures from held-out cases.

Metrics: false-complete rate (first priority), false-block rate on correct tasks, omission detection, supported-finding precision, evidence-reference accuracy, abstention/block rate, replay/freshness behavior, p50/p95 duration and model/runner costs. Publish denominators and blocked outcomes, not a single composite score.

Proposed release gate: zero false-complete verdicts on designated critical regression fixtures; all records reference actual captured evidence; no unsupported required criterion becomes complete; dirty files preserved; injected commands cannot widen policy; cancellation and crashes produce durable incomplete outcomes. These are proposed acceptance gates, not achieved results or statistical accuracy claims.

Statistical caveat: zero observed false-complete verdicts in N fixture cases does not establish a rate of zero. For N=30 with zero failures, the rule-of-three approximate 95% upper bound is about 10% (3/N). A zero-failure gate on the critical fixtures is a regression check, not evidence of low false-complete risk. Report the fixture count and the upper bound beside any zero-failure result.

## 11. Improvements after evidence supports the MVP

1. Framework-aware detection of empty/skipped/weakened checks.
2. Risk profiles for auth, tenancy, payments, migrations and destructive writes.
3. Disconfirming probes and baseline/candidate comparisons.
4. Dependency-aware incremental rechecks, measured against full execution.
5. Browser and approved test-account journeys.
6. External reviewer ingestion with explicit provenance, not inherited trust.
7. Provider diversity only when controlled evaluation shows incremental benefit.
8. Separately approved repair handoff retaining original failures and immutable criteria.

## 12. Decision requested

Review this concept before implementation planning. Confirm: coding-task completion auditor; explicit audit first; no auto-repair; evidence-backed four-state ledger; protected execution; honest abstention; v0.3 reuse conditional on audit. Naming, budget defaults, supported host range, runner choice and exact release thresholds remain user decisions listed in 06-roadmap-and-open-questions.md.
