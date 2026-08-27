# Long Proof Pattern

For open-ended mathematical and theoretical-CS problems where the
proposed strategy may not even be sound, and the flaw stays invisible
until deep into the attempt.

## When to use

- The user wants a proof, a formal verification, or an answer to an
  open problem.
- The problem has a "show that" or "∀...∃" shape.
- Lean / Coq / Isabelle is in scope.
- A single-model single-shot answer is unlikely to work (the strategy
  is the hard part, not the writing).

## Orchestrator adjustments

1. **Strategy framing is everything.** Before dispatching proposers,
   write 3-5 candidate strategies in `strategy-<n>.md`. The proposers
   do not start from scratch — they pick a strategy and execute it.
2. **Falsifier ratio is 1:1.** Every candidate gets its own
   falsifier, no exceptions. The "competitive strategy search" is
   the whole point.
3. **The synthesis tree has two levels.** First level: synthesize
   across candidates WITHIN a strategy. Second level: synthesize
   ACROSS strategies. Different falsifiers may have killed one
   strategy entirely; only the survivors feed into the second-level
   synthesis.
4. **Pitfall registry is answer-agnostic.** A pitfall here is a
   logical step type that failed, not a specific counterexample.
   "Assumed commutativity without justification" is a pitfall.
   "For n=3 it gives 7 instead of 8" is a finding, not a pitfall —
   findings go in the critique, pitfalls go in the registry.
5. **Hard round cap: 6.** Math runs that haven't converged by round
   6 are wasting the user's GPU budget. Stop and present.

## What changes vs. the base orchestrator

- The scout report focuses on the paper / statement, the formal proof
  system, and the definitions. Not code.
- The proposer gets a strategy framing, not just a problem.
- The falsifier MUST walk the proof step by step. "By symmetry" is
  not a step.
- The synthesizer's "local check" is `lean` or `coq` compile +
  `sorry` count.
- The verifier's PASS criterion is the formal proof checker accepting
  the artifact with zero `sorry` / `admitted`.
