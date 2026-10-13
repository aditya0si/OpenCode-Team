/**
 * Task 4 (round-2 repair) — the verifier-owned discovery harness.
 *
 * The harness runs the candidate test module with the standard `unittest`
 * framework and reports reconciled counts. It is written by the verifier into
 * the read-only input copy under a reserved directory *after* materialization,
 * so the candidate snapshot can never contain it and the mount is read-only, so
 * its **bytes** cannot be substituted.
 *
 * ## The same-process trust limit (round-2 blocker)
 *
 * Read-only bytes do NOT make the harness's *runtime state* trusted. The
 * candidate module is imported and executed in the **same Python process** as
 * the harness, so it can mutate the very machinery the harness relies on:
 *
 *   - it can `os.write(1, json.dumps(green))` and `os._exit(0)` at import,
 *     before `exec_module` returns, so the forged line is the last one;
 *   - it can monkeypatch `json.dumps`, `unittest.TestResult` /
 *     `loadTestsFromModule`, `sys.__stdout__` or `os._exit`.
 *
 * A cosmetic marker/token cannot fix this: the candidate can read or replace
 * anything in the process. Therefore the counts this harness emits are treated
 * as a **benign framework observation only** by the runner — they are recorded
 * for diagnostics but are **never decisive for suite completeness** and can
 * never produce `COMPLETED/PASS` or `COMPLETED/FAIL`. A process exit code only
 * ever proves that the process completed. A stronger, separately isolated
 * verifier-observed channel is a future task; it is not faked here with a
 * same-process marker.
 *
 * ## Bounded sink
 *
 * The candidate's Python-level stdout/stderr are redirected into a bounded,
 * discarding sink so a print flood cannot grow the harness's memory without
 * bound (the previous `io.StringIO` was unbounded inside the container). The
 * harness records whether the sink overflowed and reports `overflow` in its
 * JSON so the event is visible even though the excess is discarded. The
 * container memory limit remains the last-resort bound; the host output cap
 * cannot protect the in-container collector, so the collector bounds itself.
 */

import { createHash } from "node:crypto";

/** Reserved directory (inside the input mount) for verifier-owned harness bytes. */
export const VERIFIER_HARNESS_DIR = ".t4-verifier";

/** File name of the harness inside {@link VERIFIER_HARNESS_DIR}. */
export const VERIFIER_HARNESS_FILENAME = "harness.py";

/** Bytes of candidate stdout/stderr the in-container sink retains at most. */
export const VERIFIER_HARNESS_SINK_LIMIT = 65_536;

const HARNESS_LINES = [
  "import contextlib",
  "import importlib.util",
  "import json",
  "import os",
  "import sys",
  "import unittest",
  "",
  "",
  "class _BoundedSink:",
  "    def __init__(self, limit):",
  "        self.limit = limit",
  "        self.kept = 0",
  "        self.total = 0",
  "        self.overflow = False",
  "",
  "    def write(self, text):",
  "        if not isinstance(text, str):",
  "            text = str(text)",
  "        size = len(text)",
  "        self.total = self.total + size",
  "        if self.kept < self.limit:",
  "            remaining = self.limit - self.kept",
  "            self.kept = self.kept + (size if size < remaining else remaining)",
  "        if self.total > self.limit:",
  "            self.overflow = True",
  "        return size",
  "",
  "    def flush(self):",
  "        return None",
  "",
  "    def isatty(self):",
  "        return False",
  "",
  "",
  "def _emit(counts, overflow):",
  "    payload = dict(counts)",
  "    payload['overflow'] = bool(overflow)",
  "    sys.__stdout__.write(json.dumps(payload) + '\\n')",
  "    sys.__stdout__.flush()",
  "    os._exit(0)",
  "",
  "",
  "def main():",
  "    args = [a for a in sys.argv[1:] if a != '--json-counts']",
  "    if not args:",
  "        _emit({'collected': 0, 'passed': 0, 'failed': 0, 'skipped': 0}, False)",
  "        return",
  "    path = args[0]",
  `    sink = _BoundedSink(${VERIFIER_HARNESS_SINK_LIMIT})`,
  "    tests_run = 0",
  "    failed = 0",
  "    skipped = 0",
  "    try:",
  "        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):",
  "            spec = importlib.util.spec_from_file_location('candidate_tests', path)",
  "            module = importlib.util.module_from_spec(spec)",
  "            spec.loader.exec_module(module)",
  "            suite = unittest.TestLoader().loadTestsFromModule(module)",
  "            result = unittest.TestResult()",
  "            suite.run(result)",
  "            tests_run = result.testsRun",
  "            failed = len(result.failures) + len(result.errors)",
  "            skipped = len(result.skipped)",
  "    except BaseException:",
  "        failed = failed + 1",
  "    passed = tests_run - failed - skipped",
  "    if passed < 0:",
  "        passed = 0",
  "    collected = passed + failed + skipped",
  "    _emit({'collected': collected, 'passed': passed, 'failed': failed, 'skipped': skipped}, sink.overflow)",
  "",
  "",
  "if __name__ == '__main__':",
  "    main()",
  "",
];

/** Exact verifier-owned harness source copied into the container. */
export const VERIFIER_HARNESS_SOURCE = HARNESS_LINES.join("\n");

/** SHA-256 of {@link VERIFIER_HARNESS_SOURCE}; pinned in policy and the approval. */
export const VERIFIER_HARNESS_DIGEST = `sha256:${createHash("sha256")
  .update(VERIFIER_HARNESS_SOURCE)
  .digest("hex")}`;
