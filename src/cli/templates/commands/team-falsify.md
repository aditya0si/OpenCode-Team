---
description: "Run only the falsifier step on existing candidates. Use after /team-propose to get adversarial critique before deciding to synthesize."
agent: team/orchestrator
---

The user wants falsifier critiques of existing candidates. Do this:

1. List the candidates in `.teamwork-runs/<run-id>/candidates/`.
2. For each candidate, dispatch `@team/falsifier`. Falsifiers run in
   parallel.
3. Write the critiques to `.teamwork-runs/<run-id>/critiques/crit-<n>.md`.
4. After all critiques are in, write a meta-summary at
   `.teamwork-runs/<run-id>/critiques/summary.md`:
   - How many candidates were killed (FATAL).
   - How many have SERIOUS findings.
   - How many pass with MINOR findings only.
   - Which failure modes appear across multiple candidates (these are
     likely real and the proposers should be told).
5. STOP. Do not synthesize. The user will decide.

Report back: the summary and a recommendation ("synthesis likely
unnecessary, all 3 are broken in the same way" or "candidates diverge
enough that synthesis will be hard" or "one clear winner, ready to
verify").

The user's full request was:

$ARGUMENTS
