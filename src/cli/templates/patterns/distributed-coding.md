# Distributed Coding Pattern

For decomposable engineering tasks that fan out across parallel workers
with critic review. The problem splits cleanly into N independent
sub-tasks. Each is well-scoped. The merge is the hard part.

## When to use

- "Build a feature across N files / N modules."
- "Migrate this codebase from X to Y, file by file."
- "Add tests for every public function in this module."
- "Refactor N components to a new shared interface."

The signal: you can write N independent task descriptions, each one
self-contained, and the union of the N solutions is the answer.

## Orchestrator adjustments

1. **Decompose first.** Write the dependency graph. Which sub-tasks
   depend on which? The independent ones run in parallel; the
   dependent ones run in topological order.
2. **Proposer count = sub-task count.** Each proposer gets one
   sub-task, not the whole problem.
3. **Falsifier per sub-task.** Same adversarial approach, but
   scoped to the sub-task's interface. The falsifier is checking:
   does this sub-task's output match its interface? Does it break
   any other sub-task's interface?
4. **Synthesizer is the integrator.** Not merging — INTEGRATING. The
   synthesized solution is the integrated codebase, plus a smoke
   test that exercises the integration points.
5. **Verifier runs the smoke test PLUS the full test suite.** If
   the integration test passes but the existing tests fail, the
   integration is wrong.
6. **Hard round cap: 4.** Integration bugs compound; the second
   round is usually a regression hunt, not a feature add.

## What changes vs. the base orchestrator

- The scout report is wider — the public API surface, the module
  boundaries, the test fixtures.
- The proposer is invoked many times in parallel, each with a
  different sub-task.
- The synthesizer's output is a complete integrated artifact, not
  a "best of N".
- The verifier's FAIL message must say which sub-task integration
  failed and which sub-tasks are still good.
