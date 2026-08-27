# Small Focused Team Pattern

For a single self-contained fix or tweak. The fastest of the
topologies. The user opts in explicitly with `--topology small-focused`
when they know the scope is tight.

## When to use

- One file, one function, one test failing.
- A small UI tweak.
- A typo / rename / refactor of a few lines.
- Any change where the answer fits in a single worker session.

If you're not sure, the Sentinel will default to `large-swarm` and
you can override.

## Topology

```
Sentinel
  │
  ├── Builder (1)
  │     scope: spec.json
  │     worktree: .../worktrees/agent-builder
  │     output: patch.diff + summary.md
  │
  └── Verifier (1, looping)
        scope: patch.diff + spec.json
        output: verification_report.json
```

That's it. No synthesizer, no multiple proposers, no strategist.
The loop is:

```
Builder → Verifier → (PASS: done) | (FAIL: back to Builder)
```

## Sentinel adjustments

1. **No DAG.** Single task. No dependencies. Run the Builder once.
2. **Round cap: 3.** If 3 builder-verifier rounds haven't converged,
   the problem is misdiagnosed. Stop and present.
3. **Verifier budget: small.** No need for 10 verifiers; one
   thorough check per round.
4. **Cost cap: low.** Default $2 for the whole run.
5. **Merging is automatic on PASS.** The Sentinel merges the
   builder's worktree back to the user's branch without asking.

## What the Builder does differently

In `small-focused`, the Builder:
- Receives the FULL `spec.json` (not scoped). It's a small task.
- Can run its own verification (the spec's programmatic checks).
- Writes a SHORT summary (1 paragraph).
- The patch is the whole point — there's no integration step.

## When NOT to use

- The change touches >1 file in different modules. Use
  `large-swarm`.
- You need 2+ workers in parallel. Use `large-swarm`.
- It's a math proof. Use `proof` or `massive-proof`.
- It's a doc review. Use `doc-review`.

## Cost shape

Total: 1 builder × (1-3 rounds) + 1 verifier × (1-3 rounds).
Expected wall time: 5-15 min for a typical fix.
Expected cost: $0.10 - $2.00 depending on model tier.
