---
description: "Phase-1 prompt crafter. Runs the 9-step elicitation flow before a Teamwork run, produces prompt_draft.md. Use for any hard problem where you want a falsifiable spec before dispatching agents."
agent: team/crafter
---

$ARGUMENTS

The user wants to run a Teamwork session. Before dispatching agents,
you need a spec.

Run the 9-step elicitation flow:

1. Elicit project idea (1-2 declarative sentences)
2. Identify ambiguity + scale (small-focused / large-swarm / proof /
   massive-proof / doc-review)
3. Determine integrity mode (development / demo / benchmark)
4. Draft requirements $R_1 \dots R_N$ (2-5 behavior-focused)
5. Design verification (forcing function — what makes the verifier
   say PASS)
6. Set acceptance criteria (markdown checkboxes for each $R_i$)
7. Configure model allocation (preset: anthropic/team/google/openai/
   free — or `custom` for per-role)
8. Set working directory
9. Assemble + validate (run the anti-pattern checks)

Save the spec to
`.opencode/teamwork/<session-id>/prompt_draft.md`.

When the spec is approved by the user, they can run `/teamwork
<session-id>` to dispatch the Sentinel.

If the user just wants speed, tell them: "Run `/teamwork` with your
prompt. The Sentinel will ask the same 9 questions in compressed
form. The wizard is the right tool for multi-hour / multi-day
problems."

The user's full request was:

$ARGUMENTS
