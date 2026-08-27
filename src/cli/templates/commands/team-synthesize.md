---
description: "Run the synthesizer on existing candidates + critiques. Use after /team-falsify when candidates have been critiqued and a merge is needed."
agent: team/orchestrator
---

The user wants a synthesis of existing candidates and their critiques.
Do this:

1. Read all candidates in `.teamwork-runs/<run-id>/candidates/`.
2. Read all critiques in `.teamwork-runs/<run-id>/critiques/`.
3. Read the pitfall registry `.teamwork-runs/<run-id>/pitfalls.md` if it
   exists.
4. Dispatch `@team/synthesizer` with all of the above.
5. Write the synthesis to `.teamwork-runs/<run-id>/synthesis/syn-1.md`.
6. STOP. Do not verify. The user will run /teamwork or call the
   verifier directly.

Report back: where the synthesis is, what was kept from each source
candidate, and any new failure modes the synthesizer flagged. If the
synthesis was inconclusive, say so explicitly and explain why.

The user's full request was:

$ARGUMENTS
