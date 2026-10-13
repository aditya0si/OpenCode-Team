# Independent documentation review

Review date: 2026-10-12. Scope: docs/review-pivot/*.md and video-notes/*.md, as directed by [07-review-brief.md](07-review-brief.md). This is a research and concept review. It is not an implementation review, and it does not authorize any build.

Reviewer model: opencode-go/claude-haiku-5-5, as confirmed in the brief. This is a single-model pass. It is not a second-model confirmation, so treat its judgments as one reviewer's assessment.

## Verdict

**Not ready for implementation planning.** The concept is ready for a user decision and for a separately authorized compatibility spike. Blocking gaps remain: an unresolved retrieval-provenance conflict, enforcement semantics that fail open, an undefined read-only contract, and no primary source on test special-casing. A written implementation plan before these are addressed would rest on unverified assumptions.

## What was checked directly in this review

- Read all 11 original documents in full (00–06, the four video notes). The brief itself (07) was read and not edited.
- Re-fetched four primary sources. Results:
  - [1] CoVe v2 HTML: Table 2 (F1 0.39 to 0.48) and Table 3 (FactScore 55.9 to 71.4; average facts 16.6 to 12.3) match the registry. Sample sizes are small (56, 55, 418 questions); no confidence intervals in the inspected tables.
  - [5] InjecAgent arXiv abstract: 1,054 cases, 17 user tools, 62 attacker tools, 30 agents, 24% for ReAct GPT-4, hacking prompt nearly doubles success. Matches. Comments field lists ACL 2024 Findings, which the registry did not previously state.
  - [12] OpenCode plugins page: events and examples match the text. Also documents load order, `shell.env` env injection, and that `experimental.session.compacting` is experimental.
  - [13] OpenCode policies page (new in the registry): `experimental.policies`; invalid statements are dropped with a log warning; no match means allow; policies do not sandbox plugin code.
- Local repo baseline: HEAD is 70c1dba (v0.2.1 as recorded), origin is aditya0si/OpenCode-Team. Dirty files are README.md, SKILL.md and src/cli/index.ts; docs/ is untracked. Consistent with 04.

Not re-checked: [2], [3], [4], [6], [7], [8], [9], [10], [11]; all X posts and HN comments; all YouTube transcripts; v0.3 internals.

## Prioritized findings

Severity reflects impact on build readiness. Status shows whether this review changed the document.

| # | Severity | Finding | Where | Status |
|---|---|---|---|---|
| 1 | High | Enforcement may fail open. OpenCode policies drop invalid statements with only a server-log warning, and no match means allow. Any reviewer read-only guarantee relying on policy would silently fail. | 01 [13], 04, 06 decision 11 | Added [13], R13, probe. Not verified on a pinned host. |
| 2 | High | Retrieval-provenance conflict. 01 says all URLs were retrieved with web.run; 02 says web.run was not invocable and that fallbacks were used. Neither document gives per-source tool logs. | 01 section 7, 02, 06 | Conflict recorded in both; not resolvable from the documents. |
| 3 | High | "Read-only" is not operationally defined. Git and package managers and test runners write files. A model-layer read-only flag is not a host-level control. | 05 section 9, 06 decision 12 | Defined in 05 section 9 (proposal). Needs the write-behavior probe. |
| 4 | High | Missing primary evidence on test special-casing or reward hacking. The concept's test-integrity checks (R4, R10, "candidate changes tests") depend on it. | 01 section 6, 05 section 2 | Gap recorded. No source retrieved; not fixed by editing. |
| 5 | Medium-High | Zero-failure release gates are presented without a rate bound. With N=30 and zero failures, the 95% upper bound is about 10%. | 05 section 10 | Statistical caveat added. |
| 6 | Medium | Two status vocabularies. 02 used verified/refuted/inconclusive/not_checked; 01 and 05 use SUPPORTED/CONTRADICTED/UNVERIFIED/BLOCKED. | 02 P0 | Reconciled to the 05 vocabulary. |
| 7 | Medium | Undefined overall state. 05 mentioned ACCEPTED_WITH_WAIVERS, which is not in the overall verdict list. | 05 section 4 | Waivers are now an annotation; the label is removed. |
| 8 | Medium | "Non-mutating" deployment checks is an overstatement. Chat or generation endpoints invoke models, consume paid usage, or write state. | 05 section 8 | Restricted to GET/HEAD by default; other methods need per-URL approval. |
| 9 | Medium | Artifact names differ between 02 and 05. | 02 P1 | Aligned to 05 section 7 names. |
| 10 | Medium | Two OpenCode doc generations (V1 and V2) coexist. Schemas must come from the pinned version, not either page. | 01, 04 | Noted in 01 section 6 and 04. Not resolved. |
| 11 | Low-Medium | Dangling timestamp citation in 03 (harness notes 18:34–20:18), which does not exist in video-notes/01-harness.md. | 03 requirement 1 | Removed; a note records the removal. |
| 12 | Low-Medium | Source-registry attribution "Rohit Khanna / CodeRabbit" not verified. | 01 [9] | Flagged as not re-verified. |
| 13 | Low | "Seven autonomous agents" in 05 conflicted with the eight listed components. | 05 section 6 | Reworded to modules. |
| 14 | Low | Demo-fallback example in 05 section 2 is an illustrative scenario, not sourced evidence. | 05 section 5 | Not changed. Should be labeled illustrative before any external use. |
| 15 | Low | Windows host and Docker Desktop (a Linux VM) are not analyzed against R6/R7. | 05 section 9 | Not changed; carried into spike scope. |

## What changed

- 01-primary-research.md:
  - CoVe: sample sizes and a re-check note added.
  - InjecAgent: re-check note and ACL 2024 Findings venue added.
  - New source [13] (OpenCode policies) and derived requirement R13, with a probe.
  - Retrieval-provenance conflict stated in section 7; per-source status recorded; [9] attribution flagged.
  - Gaps added: test special-casing, host-tool read-only semantics, V1/V2 coexistence.
- 02-developer-signals.md: status vocabulary reconciled; artifact names aligned; provenance conflict noted.
- 03-video-research.md: removed the dangling citation; clarified that requirements are proposals, not video findings.
- 04-integration-and-project-baseline.md: documented plugin facts (load order, `shell.env`, experimental hooks); policy fail-open behavior; role-guard row extended.
- 05-concept.md: waiver annotation fixed; deployment-check definition narrowed; "seven" reworded; operational read-only definition; zero-failure bound caveat.
- 06-roadmap-and-open-questions.md: decisions 11 and 12 added; new limitations; Phase B exit probes; reading order extended with 07 and 08.
- 00-research-brief.md: workstream list references 08 (no new research workstream).
- 08-independent-review.md: this file (new, as requested).

No file under video-notes/ was changed. No README.md, SKILL.md or src/ file was touched, and the existing dirty files were not reset, stashed, or modified.

## Current research-state assessment

| Question from 00 | State |
|---|---|
| Q1 What CoVe does and does not establish | Adequate. Factual-generation evidence is clearly separated from coding claims. |
| Q2 Bias, correlated errors, rubber-stamping | Partial. Judge-bias evidence [3] is documented; no coding-specific measurement exists. |
| Q3 Evidence of completion vs successful tool calls | Partial. Derived from SWE-bench [4] and vendor docs; no measured study. |
| Q4 Snapshot identity and stale evidence | Design only. No source tested. |
| Q5 What read-only means | Now defined as a proposal. Not validated. |
| Q6 Prompt injection | Adequate as a threat model (InjecAgent [5]); no defense evaluated. |
| Q7 Overlap with existing reviewers | Adequate for CodeRabbit and Cursor docs. Not a census. |
| Q8 Measurement of false positives and misses | Designed (05 section 10). Not established. |
| Q9 Stable OpenCode APIs | Partial. Plugin and policy docs read; pinned-version behavior unverified. |

Overall: the research is a sound requirements and threat-model document. It is not evidence that the proposed product works, is needed, or is safe to run.

## Missing evidence (priority order)

1. Per-source retrieval logs, or a re-retrieval of the registry entries, to settle the web.run conflict.
2. Primary sources on coding-agent test special-casing, reward hacking, and tests weakened to pass.
3. Pinned-version OpenCode probes: invalid-policy behavior, plugin hook ordering, reviewer restriction, and `shell.env` side effects.
4. Operational read-only test: which git and package-manager commands write, on Windows and Linux.
5. Complete original long X posts where accessible; unrelated practitioner interviews with real repositories and logs.
6. Re-check of the unverified registry entries [2], [3], [4], [6]–[11].

## Build-readiness gates

No build begins until the user explicitly approves a later phase. These gates must pass before writing an implementation plan:

- G1: Retrieval provenance resolved for every cited external source.
- G2: Pinned OpenCode version identified; policy fail-open probe and hook-ordering probe run on it, with results recorded.
- G3: Read-only definition validated for at least Git and one package manager on Windows.
- G4: Test-integrity evidence base includes at least one primary source on test special-casing or reward hacking, or the concept explicitly drops those claims.
- G5: Fixture evaluation plan states denominators, human-label procedure, and the rule-of-three bound for zero-failure gates.
- G6: Decisions 1–12 in 06 answered, or explicitly deferred with stated consequences.
- G7: Runner threat model covers the Windows host and Docker Desktop configuration, or the MVP restricts scope to static-only review.

## Open decisions (for the user)

All items in 06-roadmap-and-open-questions.md "Decisions before build" remain open. This review adds 11 (enforcement channel) and 12 (read-only definition). Recommended first decision: approve or reject the concept in 05, and separately authorize the compatibility spike described in 06 phase B.

## Product pointers

- Overlap to position against: CodeRabbit CLI [8], CodeRabbit Security [9], Cursor Bugbot [10][11]. These products cover review and evidence-grounded findings. The differentiation hypothesis in 05 (task-to-evidence auditing with abstention) is untested against them.
- OpenCode surfaces for an MVP: plugin hooks (`tool.execute.before`, `session.idle`, `session.diff`) [12]; custom tools [12]; experimental policies [13]. Each needs a pinned-version probe before any enforcement claim.
- Local v0.2.1 is not the v0.3 public snapshot. Nothing here shows v0.3 behavior.

## Limitations of this review

- Single model (claude-haiku-5-5) with no second-reviewer confirmation.
- Four primary sources re-fetched, not all twelve plus the new one. Claims from the unrechecked sources were not re-verified.
- No X post, HN comment, or YouTube transcript was re-retrieved.
- No OpenCode behavior was executed; policy and plugin statements reflect documentation only.
- Dates: the environment date is 2026-10-12; the earlier documents record 2026-10-11 as their access date. Entries re-fetched in this review carry the 2026-10-12 date.
