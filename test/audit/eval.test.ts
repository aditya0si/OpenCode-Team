/**
 * Task 6 — evaluation, adversarial review and usable delivery. RED first.
 *
 * The evaluation harness is written against a module that does not exist yet,
 * so the first run fails to import. These cases pin the fail-closed contract:
 *
 *   - the fixed 30-fixture catalogue is loaded and counted **in code** — the
 *     evaluator never trusts a hard-coded denominator;
 *   - a missing or duplicated fixture is an explicit error, not a silent pass;
 *   - every fixture's *regression* expectation matches the deterministic
 *     observed verdict, and no fixture labelled "not complete" is ever observed
 *     verified (zero false-complete);
 *   - the evaluation is reproducible across runs;
 *   - the baseline-vs-planner comparison is always `blocked`/no-data — the
 *     evaluator measures no planner and exposes no seam for injecting numbers;
 *   - injected headings/narratives never render as verifier conclusions;
 *   - the CLI exits non-zero on any fixture/label mismatch.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EvaluationError,
  evaluateFixture,
  loadFixtureManifest,
  loadFixtures,
  parseFixture,
  runAuditEvaluation,
  validateFixtureSet,
  type AuditFixture,
} from "../../src/audit/evaluation.js";

setDefaultTimeout(120_000);

const WORKSPACE = process.cwd();
const FIXTURES_DIR = join(WORKSPACE, "test", "audit", "fixtures");
const SCRATCH = join(WORKSPACE, "audit-build", "eval-fixtures-unit");
let seq = 0;

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function scratchDir(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = join(SCRATCH, `${name}-${process.pid}-${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function minimalInput(): unknown {
  const text = "R1";
  return {
    schemaVersion: 2,
    taskId: "eval-task",
    taskRevision: "rev-1",
    candidateId: "cand-eval",
    scope: { description: "unit scope" },
    criteria: [
      {
        id: "R1",
        span: { text, start: 0, end: text.length },
        required: true,
        acceptanceType: "EXECUTION",
      },
    ],
    claims: [],
    evidence: [],
    waivers: [],
  };
}

describe("fixture catalogue", () => {
  test("loads the fixed 30-fixture set and counts it in code", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    expect(fixtures.length).toBe(30);
    const summary = await runAuditEvaluation(fixtures);
    expect(summary.total).toBe(30);
    expect(summary.counts.byCategory).toEqual({
      complete: 10,
      contradictory_incomplete: 10,
      blocker: 5,
      stale_injection: 5,
    });
    expect(summary.counts.bySplit.development + summary.counts.bySplit.held_out).toBe(30);
    expect(summary.counts.byKind.schema).toBe(21);
    expect(summary.counts.byKind.filesystem).toBe(8);
    expect(summary.counts.byKind.adapter).toBe(1);
  });

  test("the catalogue matches its manifest", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const manifest = await loadFixtureManifest(FIXTURES_DIR);
    expect(validateFixtureSet(fixtures, manifest)).toEqual([]);
  });

  test("a fixture missing from the set is an explicit mismatch", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const manifest = await loadFixtureManifest(FIXTURES_DIR);
    const errors = validateFixtureSet(fixtures.slice(0, -1), manifest);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("a duplicated fixture id is refused by the loader", async () => {
    const dir = scratchDir("dup");
    const fixture = {
      schemaVersion: 1,
      id: "dup-fixture",
      category: "complete",
      split: "development",
      kind: "schema",
      title: "duplicate",
      label: { overall: "INCOMPLETE_EVIDENCE" },
      rationale: "duplicate id must fail closed",
      evidence: ["unit"],
      auditInput: minimalInput(),
    };
    writeFileSync(join(dir, "a.json"), `${JSON.stringify(fixture)}\n`, "utf8");
    writeFileSync(join(dir, "b.json"), `${JSON.stringify(fixture)}\n`, "utf8");
    await expect(loadFixtures(dir)).rejects.toBeInstanceOf(EvaluationError);
  });

  test("parseFixture rejects a malformed fixture", () => {
    expect(() => parseFixture({ id: "x" })).toThrow(EvaluationError);
  });

  test("an empty fixture list has exact zero denominators", async () => {
    const summary = await runAuditEvaluation([]);
    expect(summary.total).toBe(0);
    expect(summary.matched).toBe(0);
    expect(summary.mismatched).toBe(0);
    expect(summary.counts.byCategory).toEqual({
      complete: 0,
      contradictory_incomplete: 0,
      blocker: 0,
      stale_injection: 0,
    });
  });
});

describe("labels and outcomes", () => {
  test("every fixture matches its regression expectation; zero false-complete", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const summary = await runAuditEvaluation(fixtures);
    expect(summary.errored).toBe(0);
    expect(summary.mismatched).toBe(0);
    expect(summary.matched).toBe(30);
    expect(summary.falseComplete).toEqual([]);
    for (const outcome of summary.outcomes) {
      if (outcome.error !== null) {
        throw new Error(`fixture ${outcome.fixtureId} errored: ${outcome.error}`);
      }
      expect(outcome.matched).toBe(true);
      if (outcome.labelOverall !== "VERIFIED_WITHIN_SCOPE") {
        expect(outcome.observedOverall).not.toBe("VERIFIED_WITHIN_SCOPE");
      }
    }
  });

  test("complete fixtures observe VERIFIED_WITHIN_SCOPE", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const summary = await runAuditEvaluation(fixtures);
    const completes = summary.outcomes.filter((o) => o.category === "complete");
    expect(completes.length).toBe(10);
    for (const outcome of completes) {
      expect(outcome.observedOverall).toBe("VERIFIED_WITHIN_SCOPE");
    }
  });

  test("injection fixtures never render injected text as a conclusion", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const injections = fixtures.filter((f) => f.injection === true);
    expect(injections.length).toBeGreaterThan(0);
    for (const fixture of injections) {
      const outcome = await evaluateFixture(fixture, { scratchRoot: SCRATCH });
      expect(outcome.injectionEscaped).toBe(true);
    }
  });

  test("baseline vs planner is always blocked, with no injectable comparison", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const summary = await runAuditEvaluation(fixtures);
    expect(summary.plannerComparison.status).toBe("blocked");
    expect(summary.plannerComparison.reason.length).toBeGreaterThan(0);
    expect(Object.keys(summary.plannerComparison).sort()).toEqual(["reason", "status"]);
  });

  test("provenance is honest: regression labels, metadata-only split, no semantic/baseline test", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const summary = await runAuditEvaluation(fixtures);
    const provenance = summary.provenance.join(" ").toLowerCase();
    expect(provenance).toContain("regression");
    expect(provenance).toContain("metadata only");
    expect(provenance).toContain("not independently human-reviewed");
    expect(provenance).toContain("synthetic receipts");
    expect(provenance).toContain("not shipped in the installed package");
    expect(summary.limitations.join(" ").toLowerCase()).toContain("not a statistical evaluation");
  });

  test("evaluation is reproducible", async () => {
    const fixtures = await loadFixtures(FIXTURES_DIR);
    const first = await runAuditEvaluation(fixtures, { scratchRoot: SCRATCH, repeats: 2 });
    const second = await runAuditEvaluation(fixtures, { scratchRoot: SCRATCH });
    const normalize = (summary: Awaited<ReturnType<typeof runAuditEvaluation>>) =>
      summary.outcomes.map((o) => ({
        fixtureId: o.fixtureId,
        observedOverall: o.observedOverall,
        observedValid: o.observedValid,
        observedCriteria: o.observedCriteria,
        matched: o.matched,
      }));
    expect(normalize(first)).toEqual(normalize(second));
    expect(first.reproducibility).toEqual({ runs: 2, identical: true });
  });
});

describe("CLI", () => {
  test("exits 0 on the real catalogue and non-zero on a label mismatch", async () => {
    const good = scratchDir("cli-good");
    const fixture = {
      schemaVersion: 1,
      id: "cli-fixture",
      category: "contradictory_incomplete",
      split: "development",
      kind: "schema",
      title: "cli",
      label: { overall: "INCOMPLETE_EVIDENCE" },
      rationale: "no evidence for a required criterion",
      evidence: ["unit"],
      auditInput: minimalInput(),
    };
    const manifest = {
      schemaVersion: 1,
      total: 1,
      byCategory: { complete: 0, contradictory_incomplete: 1, blocker: 0, stale_injection: 0 },
      ids: ["cli-fixture"],
    };
    writeFileSync(join(good, "fixture.json"), `${JSON.stringify(fixture)}\n`, "utf8");
    writeFileSync(join(good, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");

    const bad = scratchDir("cli-bad");
    writeFileSync(
      join(bad, "fixture.json"),
      `${JSON.stringify({ ...fixture, label: { overall: "VERIFIED_WITHIN_SCOPE" } })}\n`,
      "utf8",
    );
    writeFileSync(join(bad, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");

    const runCli = (dir: string) =>
      spawnSync("bun", ["scripts/audit-eval.ts", "--fixtures", dir], {
        cwd: WORKSPACE,
        encoding: "utf8",
      });

    const goodRun = runCli(good);
    expect(goodRun.status).toBe(0);

    const badRun = runCli(bad);
    expect(badRun.status).not.toBe(0);

    const realRun = spawnSync("bun", ["scripts/audit-eval.ts"], { cwd: WORKSPACE, encoding: "utf8" });
    expect(realRun.status).toBe(0);
  });
});
