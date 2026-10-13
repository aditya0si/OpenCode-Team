# How to evaluate agents in practice

- Original video: https://www.youtube.com/watch?v=vuBvf7ZRKTA
- Creator/channel: Google Cloud Tech
- YouTube publishDate: 2025-12-12T09:01:51-08:00 (verified directly from watch-page metadata).
- Retrieved: 2026-10-11.
- Actual transcript: YouTube caption track retrieved with youtube-transcript-api 1.2.4 using the youtube-content skill API/normalization, in an isolated scratch venv. Language: en; automatically generated: True; segments: 250.
- Retrieval validation: nonempty segments with numeric starts/durations; inspected timestamp windows below. Caption timing is approximate.
- Raw retrieval scratch file: `C:\Users\oliad\AppData\Local\hermes\cache\scratch\video-research\vuBvf7ZRKTA.json` (not a published full transcript).

## Short actual transcript excerpt

[01:18] “component level unit tests,”

## Timestamped paraphrase notes (not transcript text)

- [01:15–01:53] Tier one isolates components, tool selection and structured parameters; cheap automated checks fit CI.
- [01:56–02:42] Tier two checks multistep trajectories, adaptation and goal attainment; tier three uses human judgment for safety and experience.
- [05:00–06:22] Measure both trajectory and final answer. A zero trajectory threshold admits unrelated behavior; the demo uses word overlap for response similarity.

## Limitations

Book-finder example, not a coding-agent benchmark. Exact tool sequences can reject valid alternatives; lexical overlap does not prove semantic correctness or safe code.
