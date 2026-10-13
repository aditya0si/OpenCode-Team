# Review pivot — research brief

Date: 2026-10-11
Status: Research in progress. No product implementation authorized by this document.

## User intent

Rework opencode-teamwork toward reviewing coding-agent output using a chain of verification. Reduce blind trust in agent completion claims. Research the internet, actual X posts and YouTube transcripts; keep Markdown evidence notes; synthesize a concrete concept explaining the idea, core issues, fixes and improvements. Complete research/design before building.

## Working scope (proposal)

OpenCode-first independent completion verification for coding work. Inputs: original task, acceptance criteria, final response, diff, repository snapshot and execution artifacts. Outputs: evidenced findings and claim-level verified/contradicted/unverified judgments. Arbitrary factual-answer verification is outside the initial scope unless user chooses otherwise.

## Questions the research must answer

1. What do Chain-of-Verification results actually establish, and what do they NOT establish for coding agents?
2. How do we avoid evaluator bias, correlated errors and rubber-stamp reviews?
3. What evidence demonstrates completion rather than merely successful tool calls?
4. How should snapshot identity, stale logs, caching, partial execution and missing access affect verdicts?
5. What commands may the reviewer execute safely? What does read-only really mean?
6. How do we handle malicious repository content, agent transcripts and prompt injection?
7. Where do existing reviewers overlap, and which differentiation remains a hypothesis?
8. How do we measure false positives, missed failures, abstention, cost and latency?
9. Which OpenCode APIs/hooks are stable enough for an MVP, and which require compatibility probes?

## Research workstreams

- 01-primary-research.md — papers, evaluation methodology, primary product/security documentation.
- 02-developer-signals.md — original X posts and developer discussion; access limitations and sampling bias.
- 03-video-research.md and video-notes/ — actual transcript-backed timestamped notes; retrieval failures disclosed.
- 04-integration-and-project-baseline.md — current project snapshot and OpenCode integration constraints.
- 05-concept.md — concrete synthesis, scope, issue/fix matrix, verification lifecycle and acceptance criteria.
- 06-roadmap-and-open-questions.md — phased research-to-build handoff, alternatives and unresolved decisions.
- 08-independent-review.md — independent documentation review (findings, changes, build-readiness gates). Added after the research above; it does not add new research workstreams.

## Evidence discipline

Every external finding must have an identifiable source and retrieval scope. Separate paper results, vendor claims, anecdotes and our proposed design. Do not reproduce whole copyrighted transcripts. Do not count search descriptions as retrieved transcripts. Do not treat an inaccessible X post as fully reviewed. A minority sample does not establish market demand. No universal guarantees based on test success, LLM consensus or worktree isolation.

## Repository safety

Local checkout: C:/Users/oliad/Desktop/opencodeteam, older v0.2.1 at 70c1dba with existing dirty README.md, SKILL.md and src/cli/index.ts. Public main reviewed snapshot: v0.3.0 at 281821a; scratch copy C:/Users/oliad/AppData/Local/hermes/cache/scratch/compare-repos/OpenCode-Team. Do not reset, pull over, commit or modify those existing changes. New research docs only. Reuse decisions require a current v0.3 implementation audit, not conclusions from v0.2.

## Initial primary-source leads

- Chain-of-Verification paper: https://arxiv.org/abs/2309.11495 and https://aclanthology.org/2024.findings-acl.212/
- OpenCode plugins: https://docs.opencode.ai/docs/plugins/
- OpenCode custom tools: https://docs.opencode.ai/docs/custom-tools/
- OpenCode tools: https://docs.opencode.ai/docs/tools/
- OpenCode V2 policy boundary: https://opencode.ai/v2/docs/policies/

The coexistence of V1/V2 docs is a compatibility risk to investigate, not permission to assume a particular hook schema.
