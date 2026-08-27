---
description: "Sentinel — main dispatcher. Loads a spec (or asks 1-2 questions), provisions a worktree, builds the DAG, dispatches workers + verifiers, iterates, merges. This is the user-facing /teamwork command."
agent: team/sentinel
---

$ARGUMENTS

{{if eq .sessionId ""}}
  Look in `.opencode/teamwork/` for a recent `prompt_draft.md`. If
  you find one, ask the user to confirm the session ID. If not, ask
  1-2 short questions to pick the topology, then either run the
  crafter (via /teamwork-craft) or inline the answers and proceed.
{{else}}
  Load the spec from `.opencode/teamwork/{{.sessionId}}/prompt_draft.md`.
{{end}}

Then:

1. Provision the sentinel worktree: `git worktree add
   .opencode/teamwork/<session-id>/worktrees/sentinel -b
   teamwork/base-<session-id>` (or skip if not in a git repo).
2. Build the DAG in `.opencode/teamwork/<session-id>/plan.dag.json`.
   Independent tasks run in parallel; dependent ones in topological
   order.
3. Dispatch workers in topological order. Each gets:
   - Its own worktree
   - A scoped `spec.json`
   - Returns: `patch.diff` + `summary.md` + cost metrics
4. Dispatch verifiers against each worker's diff. Aggregated
   results go in
   `.opencode/teamwork/<session-id>/verify/summary.json`.
5. If FAIL, send the verifier's `feedback_for_worker.md` back to
   the worker for the next round. Loop until PASS, maxRounds, or
   budget exhausted.
6. On full PASS, merge the sentinel worktree back. On partial,
   present the partial + the open verification reports.

Hard caps (override in the spec if the user asks):
- 4 rounds per task (6 for proof, 1 for small-focused, 24h for
  massive-proof)
- Default $20 session budget (configurable per run)

When done, write `.opencode/teamwork/<session-id>/final.md` and
present. Tell the user:
- Which topology you chose
- How many rounds each task took
- Total cost (estimated)
- Path to the final artifact
- Any unresolved verification reports

The user's full request was:

$ARGUMENTS
