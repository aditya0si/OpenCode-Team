# Iterative Coding Pattern

For non-decomposable problems solved through tight agent–test–refine
loops. The problem is one thing. You can't parallelize the work because
each iteration depends on the previous.

## When to use

- "This one test is failing. Fix it."
- "Add a feature to a single function / file / module."
- "Refactor this N-line block without changing its behavior."
- The fix is local, but the failure mode is non-obvious (a subtle
  off-by-one, a missed edge case, a wrong type annotation).

## Orchestrator adjustments

1. **Proposer count: 1, not N.** The first proposer makes a fix.
   If the falsifier finds a flaw, the orchestrator may dispatch a
   second proposer with the falsifier's critique attached — but the
   second proposer is fixing the same function, not branching out.
2. **Falsifier is mandatory.** "It compiles" is not enough. The
   falsifier must add at least 2 negative tests (cases the original
   problem didn't cover) and verify the fix handles them.
3. **Verifier runs the full test suite.** Not just the new test.
   Adjacent files often share helpers and a fix that breaks an
   unrelated test is still a failure.
4. **Hard round cap: 3.** If three rounds of "fix → falsify → fix"
   haven't converged, the problem is probably misdiagnosed. Stop,
   present the diagnosis, ask the user.
5. **No synthesis.** Iterative coding has no synthesis tree — the
   verifier is the gate, the proposers are sequential fixes.

## What changes vs. the base orchestrator

- The scout report focuses on the failing test, the file under
  change, and the recent commits to that file. Most context is local.
- The proposer edits the actual code (the only pattern where this is
  allowed without a synthesis step).
- The falsifier adds negative tests to a scratch file and runs them.
- The synthesizer is unused.
- The verifier runs the full project test suite, not just the
  targeted one.
