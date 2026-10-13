# Roadmap, improvements and unresolved decisions

Status: proposal after research, 2026-10-11. This is NOT an approved implementation plan. No product code changed.

## Alternatives and recommendation

| Approach | Advantage | Main weakness |
|---|---|---|
| Prompt-only reviewer | Fast and cheap integration | May rubber-stamp or invent findings; cannot certify execution |
| Deterministic checks gate | Clear reproducible pass/fail | Can miss task intent, weak tests and omitted requirements |
| Task/claim/evidence auditor (recommended) | Combines bounded semantic interpretation with observable checks and abstention | More scope, snapshot and runner complexity; must prove incremental benefit |

Recommendation: retain opencode-teamwork identity temporarily while designing a focused audit mode; avoid breaking existing users before migration is specified. Do not market a generic orchestration replacement as the differentiator.

## Phase gates, not authorization to execute

### A. Concept review (now)

User approves/changes 05-concept.md. Evidence gaps and proposals stay visible. No implementation yet.

### B. Separately authorized compatibility/evaluation spike

Read-only v0.3 internals audit; installed OpenCode version discovery; isolated adapter probes; fixture labeling; compare deterministic baseline vs factored review. Throwaway probe code only after explicit approval. Exit: supported integration contract, demonstrated snapshot capture, defined runner threat model, evidence-schema draft and measured feasibility. Include a policy fail-open probe (invalid statement, valid deny) and a git-and-package-manager write-behavior probe for the read-only definition. Failure means narrower scope or revised design, not invented working integration.

### C. Written implementation plan

After approved concept/spike findings, create a concrete plan with modules, tests, fixture IDs, acceptance gates, migration, branch/worktree strategy and rollback. User approves execution method before product changes.

### D. Core verifier MVP

Schemas/status reducer and snapshots first; deterministic evidence runner second; OpenCode adapter/reporting third; model planner/reconciler last. Each phase requires real failing/passing tests and replayable results. Claims must not become supported solely because a model says so.

### E. Controlled dogfood

Use small non-production repositories and historical known-failure examples. Include correct solutions to measure false blocks. Do not turn external accounts or production data into a testing playground. Publish limits, costs and evaluation fixtures before efficacy claims.

## Improvement backlog

P0: requirement omissions; stale evidence; nonzero exit preserved; zero-discovery checks; candidate changes tests; runner authorization; protected evidence store; report exclusions; no recursive review; cancellation/crash terminal states; config preservation.

P1: baseline/candidate probes; negative controls; language-specific adapters; incremental invalidation; risk-sensitive policy; minimal reproducible findings; explicit human waiver; model-usage and subprocess costs.

P2: approved browser/account workflows; CI/PR adapter; external review inputs; stronger hostile-code runner; optional repair handoff; model-diversity experiments.

## Decisions before build

1. Keep package/brand opencode-teamwork or introduce separate reviewer package? Recommended: additive audit mode until migration validated.
2. Which exact OpenCode version/API surface will be supported? Unknown until local discovery/probe.
3. Execution runner: static-only everywhere plus opt-in tested Docker profile, or stronger VM boundary? Never silently native-run candidate commands.
4. First repository profile: Node/TypeScript recommended; Python separately validated later.
5. Default model/runner time budget and maximum scope? Need user constraints and measured fixture costs.
6. Task ingestion: explicit pasted/selected user request first; automatic conversation task extraction only after confirmation.
7. Evidence retention and approved provider data sharing? Local reports do not mean model calls remain local.
8. What conditions require human sign-off? Recommended auth, tenancy, destructive data changes and production checks.
9. What measured false-block rate is acceptable, with what sample/held-out set? No researched paper dictates a product threshold.
10. How preserve existing orchestration users and local dirty work? Separate branch/worktree; do not reset or overwrite.
11. Enforcement channel for reviewer restrictions: plugin hooks, `experimental.policies` permission statements (which fail open on dropped statements, per 01-primary-research.md [13]), or both? Recommended: both, with a fail-closed startup check and a probe on the pinned version before any enforcement claim.
12. What counts as "read-only" for the reviewer? Recommended definition in 05-concept.md section 9: no model-tool writes to the candidate tree; any possibly-writing command runs only in a discarded copy.

## Research limitations and next evidence

- 12 primary-source entries, not exhaustive literature review. Historical CoVe and judge findings are not current coding-verifier accuracy measurements.
- Six original X posts: three complete short texts, three truncated previews. Five HN comments from one discussion; anecdotal and selected, not market survey.
- Four actual caption transcripts retrieved, with timestamped notes; automatic captions/audio not independently checked. Demonstrations not reproduced.
- Competitor documentation reviewed, products not benchmarked; overlap exists.
- v0.3 entrypoint/package inspected; internals and runtime guarantees not certified.
- No product demand, willingness-to-pay or efficacy claim established.
- Retrieval-tool provenance is inconsistent between 01 (web.run) and 02 (web.run unavailable; search and syndication fallbacks). Per-source tool logs are needed before retrieval methods are cited as established.
- No primary source on coding-agent test special-casing or reward hacking was retrieved; this gap directly affects the test-integrity checks in the concept.
- Only four primary sources were re-fetched during the independent review (CoVe, InjecAgent, OpenCode plugins, OpenCode policies). The rest remain as recorded in 01.
- See 08-independent-review.md for the prioritized findings and build-readiness gates.

Next discovery should include unrelated practitioner interviews with actual repositories/logs, full original long X posts where accessible, negative experiences with review tools, and controlled comparison against simpler existing workflows.

## Reading order

1. 05-concept.md — concrete product idea and issue/fix matrix.
2. 06-roadmap-and-open-questions.md — decisions and phase gates.
3. 01-primary-research.md — papers/security/competitors with source registry.
4. 02-developer-signals.md — actual posts, conflicting perspectives and access limits.
5. 03-video-research.md and video-notes/ — timestamped transcript-backed findings.
6. 04-integration-and-project-baseline.md — project mismatch and integration constraints.
7. 00-research-brief.md — original research scope.
8. 07-review-brief.md — brief for the independent documentation review.
9. 08-independent-review.md — prioritized review findings, changes made, and build-readiness gates.
