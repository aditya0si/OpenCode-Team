# Independent documentation review brief

Reviewer model requested and confirmed by user: opencode-go/claude-haiku-5-5.

## Task and idea

Review and improve docs/review-pivot/*.md and video-notes/*.md. We are considering pivoting opencode-teamwork into an OpenCode-first independent completion auditor: original task + pinned diff/snapshot + agent output + independently obtained evidence -> claim-level supported/contradicted/unverified/blocked report. Factored Chain-of-Verification-inspired questions, not model voting. No auto-repair, no automatic deployment, no unqualified correctness guarantees.

Research currently includes 12 primary sources, six original X posts (three full, three previews), five HN comments, four actual YouTube caption transcripts and timestamped notes. Concept lives in 05-concept.md; roadmap in 06-roadmap-and-open-questions.md. Read all 11 original documents, not only this brief. Distinguish empirical findings, vendor claims, anecdotes and design proposals. Assess source accuracy/coverage as feasible, ambiguity, unsupported leaps, contradictory status vocabulary, practicality, cost, safety, integration assumptions and evaluation validity.

## Allowed edits

Only Markdown inside docs/review-pivot/. Improve existing research/concept/roadmap docs where justified and add 08-independent-review.md containing prioritized findings, what changed, current research-state assessment, missing evidence, product pointers, proposed build-readiness gates and open decisions. Preserve useful content and source limitations. Do not claim additional research was performed if it was not. New external claims need real identifiable sources and clear retrieval scope. Do not copy whole transcripts.

## Hard boundaries

DO NOT implement product code, run/install project dependencies, create implementation stubs, change package/config, edit README.md or SKILL.md or src/, reset/stash/pull, commit/push/publish, access secrets, or touch external systems. Existing dirty files must remain untouched. Local v0.2.1 checkout is older than public v0.3.0; do not claim v0.2 findings apply to current public code. External directories need not be explored; all research context required is here. Do not spend this review hunting for other repos. No build begins until user explicitly approves later.

## Output

Actually save bounded documentation edits and review report, then return changed paths, top issues, research gaps, whether ready for implementation planning (not building), and limitations. Ensure local Markdown links remain valid. A healthy result may state not ready; do not rubber-stamp. This is research/concept review only.
