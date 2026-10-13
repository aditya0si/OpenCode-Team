# Video research: review and verification pivot

Research completed 2026-10-11. Four videos have **actual caption transcripts retrieved**, not summaries or search snippets relabeled as transcripts. Supporting notes preserve short exact excerpts and timestamped paraphrases; full copyrighted transcripts are not copied into this documentation.

## Verified video inventory

| Verified channel | Video | Publication date (YouTube metadata) | Evidence |
|---|---|---|---|
| The Carbon Layer | Harness Engineering Masterclass: Technical Deep Dive on how to build Agentic Systems | 2026-05-16 | [01-harness.md](video-notes/01-harness.md) |
| Cole Medin | Coding Agent Reliability EXPLODES When They Argue (New Adversarial Dev Technique) | 2026-03-30 | [02-independent-review.md](video-notes/02-independent-review.md) |
| Google Cloud Tech | How to evaluate agents in practice | 2025-12-12 | [03-evaluation-pyramid.md](video-notes/03-evaluation-pyramid.md) |
| aiware | 22 Keynote: On the Evaluation of AI Coding Agents | 2026-06-11 | [04-coding-review-evals.md](video-notes/04-coding-review-evals.md) |

Original video URLs, exact publication timestamps, retrieval language, auto-caption status, segment counts, and limitations appear in each evidence file. Dates here retain the calendar date of YouTube's returned timezone, not a converted local date.

## Actionable requirements — our proposed design, not claims of proven efficacy

1. **Keep implementation and review separate.** Give the reviewer a fresh bounded context and read-only access to a pinned diff, relevant files, specification, and execution evidence. Do not count role separation alone as independence. Motivation: independent-review notes, 10:05–12:38. (An earlier draft also cited harness notes at 18:34–20:18; no such entry exists in video-notes/01-harness.md, so that citation was removed.)
2. **Define acceptance before work begins.** Persist criterion IDs, required checks, thresholds, and escalation rules. The implementer may propose criteria but must not silently weaken them. Motivation: independent-review notes, 10:05–11:49.
3. **Require execution receipts.** Each completion claim links to command, environment, exit status, output artifact and exact revision. A review score cannot override a failing mandatory check. Motivation: harness notes, 22:22–24:04.
4. **Evaluate at three levels.** Component/schema tests, end-to-end trajectories with recovery scenarios, and human review for consequential uncertainty. Judge outcomes as well as traces; allow valid alternate paths. Motivation: evaluation-pyramid notes, 01:15–02:42 and 05:00–06:22.
5. **Test the verifier.** Seed known defects, use mutation tests, and curate real review cases with language/context strata. Measure missed defects and false alarms separately; audit ground truth manually. Motivation: coding-review-evals notes, 04:21–04:43 and 26:36–29:16.
6. **Bound review loops.** Record retry budget, elapsed time, cost, unresolved defects and escalation. A budget exhaustion is an incomplete outcome, never an automatic pass. Motivation: independent-review notes, 12:22–12:38 and 16:05–16:56.
7. **Persist traceable evidence.** Save tool inputs/results, prompt/tool versions and approval events; turn repeated failures into regression cases or harness constraints. Motivation: harness notes, 24:07–26:09.

## Retrieval and integrity

The youtube-content skill was loaded and its fetch_transcript.py inspected. Its helper was actually executed for mQfTdNVCOB0 with timestamps (714 segments). A batch helper then used the identical YouTubeTranscriptApi().fetch + start/duration/text normalization for all four selected videos and directly fetched their YouTube watch-page metadata. Dependencies were installed only in `C:/Users/oliad/AppData/Local/hermes/cache/scratch/video-research-venv`, never Hermes production.

Discovery used actual YouTube search-page results and creator/host pages. Several accessible Latent Space-related candidates were retrieved but excluded for weaker relevance; the final selection uses the directly relevant coding-evaluation keynote instead. Search snippets and Cole's knowledge-base summaries were discovery/corroboration only, not the transcript input.

The configured web_extract backend rejected extraction (search-only backend). Direct HTTP retrieval and the caption API succeeded, so no selected video has an unresolved transcript-retrieval gap. One scratch command failed from shell quoting and was replaced with a script. No product code or existing tracked file was modified.

## Unresolved evidence gaps

Automatic captions have recognition errors and are not audio-verified. Channel and publication metadata are verified, but the keynote speaker's name is not. Demonstrations are not causal evidence that a harness improves reliability. The timestamped notes are paraphrases of automatic captions and carry approximate timing; the "Motivation" timestamps above point to paraphrase notes, not verbatim quotes. Requirements 1–7 are design proposals derived from these notes, not findings established by the videos. No independent rerun of the speakers' experiments, vendor metrics, or benchmark datasets was performed. This research informs requirements; it does not certify a product or prescribe adoption of a particular SDK.
