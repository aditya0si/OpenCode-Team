# Document Review Pattern

For structured analysis and critique of papers and technical documents.
This is the closest to a "single-agent" pattern in Teamwork, but the
falsifier is critical because reviewers have biases (the author is
often the proposer, or a friend of).

## When to use

- "Review this paper / RFC / design doc."
- "What does this paper actually claim? Is the math right?"
- "Summarize the contributions of these N papers."
- "Compare approaches X and Y."

The signal: there is a document (or a small set of documents) and you
need a critical reading of it.

## Orchestrator adjustments

1. **Proposer count: 1, sometimes 2.** The first proposer writes a
   structured review. The second (if used) is a "friendly reviewer"
   framing — same document, different tone. The synthesizer
   merges them.
2. **Falsifier is the citation checker.** The falsifier's job is to
   verify every claim in the review traces to a citation, and that
   the citation actually says what the review says it says. This is
   the unique contribution of the pattern.
3. **Verifier is the math checker.** For any quantitative claim in
   the review, the verifier re-derives. For a paper that says
   "Theorem 1 holds with probability ≥ 1/2", the verifier checks
   the proof.
4. **No synthesis in the simple case.** For a single document, one
   review is enough. For N documents, the synthesis is the
   comparison.
5. **Hard round cap: 3.** Reviews converge fast; a third round is
   almost always cosmetic.

## What changes vs. the base orchestrator

- The scout report focuses on the document being reviewed, the
  cited sources, and any background reading the reviewer should
  know about.
- The proposer writes prose, not code. (The "code" here is the
  document.)
- The falsifier's main tool is `webfetch` and citation lookup.
- The synthesizer (if used) merges reviews, not code.
- The verifier's PASS criterion is "every claim cited, every
  citation verified, every math claim re-derived."
