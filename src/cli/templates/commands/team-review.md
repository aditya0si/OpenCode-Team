---
description: "Run the verifier on the current synthesis or candidate. Use after /team-synthesize (or directly on a candidate) to get a binary PASS/FAIL with evidence."
agent: team/orchestrator
---

The user wants verification of a specific artifact. Do this:

1. Find the artifact: the latest file in
   `.teamwork-runs/<run-id>/synthesis/`, or fall back to the latest in
   `candidates/` if no synthesis exists.
2. Dispatch `@team/verifier` with the artifact and the relevant
   critiques.
3. Write the verification report to
   `.teamwork-runs/<run-id>/verify/v-<n>.md`.
4. STOP. The user will read the report and decide.

Report back: PASS or FAIL, a 1-line summary of the checks, and (if
FAIL) the specific commands to reproduce. Do not propose a fix.

The user's full request was:

$ARGUMENTS
