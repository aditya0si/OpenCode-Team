# Massive Proof Swarm Pattern

For hard unsolved math / TCS problems. Opt-in only — the user must
explicitly request this. The cost is significant and the run time
is long (hours to days). The 7 problems Antigravity's Teamwork
solved with this approach (FOCS, JMLR, etc.) all used 100+ parallel
search agents.

## When to use

- Open conjecture or long-standing problem.
- Lean 4 / Coq / Isabelle is the verifier.
- You've already tried `proof` (5 searchers) and exhausted its
  strategies.
- The user is willing to wait hours and spend significant credits.

You will NOT use this for everyday work. The default for math is
`proof`.

## Topology

```
Meta-Coordinator (1)
  │
  ├── Strategy Pool (3-5)
  │     picks candidate proof strategies from a strategy pool
  │
  ├── Searcher Swarm (100+, default 20 for budget)
  │     each runs a (strategy, parameter) combination
  │     in parallel
  │     output: candidate proofs, possibly incomplete
  │
  ├── Falsifier Swarm (10+)
  │     each attacks a candidate
  │     kills broken ones early
  │
  └── Formal Engine Checker (1, the bottleneck)
        Lean / Coq compile
        must be green for any candidate to advance
```

## Sentinel adjustments

1. **Strategy pool first.** The meta-coordinator enumerates 3-5
   distinct strategies. Searchers are bound to strategies, not
   free-form.
2. **Searcher count is budget-driven.** Default 20. User can set
   higher. Cost scales linearly.
3. **Formal checker is the bottleneck.** Many searchers feed it.
   It's the gating function. Without it, every candidate that
   LOOKS correct is actually wrong.
4. **Pitfall registry is critical.** Every failed search adds an
   answer-agnostic mistake. The next generation of searchers
   reads the registry before starting.
5. **No synthesis tree at the small scale.** The winning
   candidate is the one that passes the formal checker. Synthesis
   is only needed if 2+ candidates tie.
6. **Hard cap: 24 hours wall clock OR $100.** Whichever first.
7. **Persistent state.** The session is checkpointed. The user can
   kill the process and resume next day.

## What the Searcher does differently

The Searcher is the heart of this pattern. Unlike a regular worker,
it:
- Runs 1 strategy + 1 parameter combo (e.g. "induction on n, with
  base case up to 100").
- Tries to prove or to find a counterexample.
- Returns EITHER a candidate proof OR a counterexample + why.
- The meta-coordinator clusters the outputs (by strategy) and
  picks the most promising.

A searcher that doesn't find anything useful still returns
"dead end" — that's valuable, because the meta-coordinator uses
it to switch strategies.

## Cost shape

Total: 1 meta-coord + 3-5 strategists + 20-100 searchers + 10+
falsifiers + 1 formal checker.
Expected wall time: 1-24 hours.
Expected cost: $5 - $100 depending on model tier and searcher
count.
The user must explicitly opt in. Default to `proof` (5 searchers,
$1-5) for normal math work.
