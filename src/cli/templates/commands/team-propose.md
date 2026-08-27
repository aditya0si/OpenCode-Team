---
description: "Run only the propose step. Generates N candidate solutions in parallel and writes them under .teamwork-runs/. Use when you want to inspect raw candidates before the falsifier step."
agent: team/orchestrator
---

The user wants raw candidates, not a full Teamwork run. Do this:

1. Pick a pattern from the prompt (default: distributed-coding).
2. Run scout first to gather context.
3. Dispatch `@team/proposer` N=3 times in parallel, each with a different
   strategy framing. If no strategy framing is obvious, use these defaults:
   - Candidate 1: "the textbook approach"
   - Candidate 2: "an unconventional / contrarian angle"
   - Candidate 3: "the minimal change that could work"
4. Write the candidates to `.teamwork-runs/<run-id>/candidates/cand-1.md`
   through `cand-3.md`.
5. STOP after writing the candidates. Do not run falsifier, synthesizer,
   or verifier. The user will inspect and decide next.

Report back: where the candidates are, a 1-line summary of each, and any
patterns you noticed across them (e.g. "all 3 candidates picked the same
library — this might be the wrong choice").

The user's full request was:

$ARGUMENTS
