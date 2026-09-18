---
description: "Sentinel — main dispatcher. Starts a Teamwork run: parse the request, plan the DAG with teamwork_plan, drive teamwork_dispatch / teamwork_verify, then present. This is the user-facing /teamwork command."
agent: team/sentinel
---

The user's request:

$ARGUMENTS

Do this:

1. Read `.opencode/teamwork/LATEST.json`. It contains the pre-parsed session
   id, `--topology` / `--budget` / `--concurrency` if the user passed them,
   and the request. Read `.opencode/teamwork/<session-id>/request.md` for the
   full request text. Flags are already parsed for you — do not re-parse them,
   and do not invent a session id.
2. If the request is under-specified, ask at most two questions, or run the
   crafter (`/teamwork-craft`) first. Otherwise write the spec to
   `.opencode/teamwork/<session-id>/prompt_draft.md`.
3. Pick one topology from the topology library in your context (use the
   parsed `--topology` if present). Read that topology's definition file
   before planning.
4. Call `teamwork_plan` with the topology, the task list, and — when the user
   passed them — `budgetUsd` and `maxConcurrency`. Every task needs
   `acceptanceCriteria`, its real `dependsOn`, and a `taskClass`.
5. Loop: `teamwork_dispatch` → one `team/worker` per returned task → one
   `team/verifier` per task → `teamwork_verify` with the report path. Keep
   going until the engine reports nothing dispatchable.
6. Write `.opencode/teamwork/<session-id>/final.md` and present:
   topology chosen, per-task status and rounds, dead-lettered tasks with
   their reproductions, total cost against budget, and the run directory path.

The engine owns dispatch order, retries, the budget and terminal states.
If `teamwork_dispatch` returns nothing, do not dispatch anyway.
