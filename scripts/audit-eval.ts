/**
 * Task 6 — audit evaluation CLI.
 *
 * Loads the fixed fixture catalogue, cross-checks it against its manifest,
 * evaluates every fixture with the deterministic auditor, and fails non-zero if
 * any fixture is missing/duplicated, any label mismatches, any fixture errors,
 * any false-complete is observed, or reproducibility fails.
 *
 * Usage:
 *   bun scripts/audit-eval.ts [--fixtures <dir>] [--json]
 *
 * This is a dev/verification tool. It does not certify completion, does not
 * publish, and reports no efficacy or coverage number beyond the counted
 * fixtures.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  loadFixtureManifest,
  loadFixtures,
  runAuditEvaluation,
  validateFixtureSet,
} from "../src/audit/evaluation.js";

interface CliOptions {
  fixturesDir: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let fixturesDir = join(process.cwd(), "test", "audit", "fixtures");
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixtures") {
      const next = argv[i + 1];
      if (!next) throw new Error("--fixtures requires a directory");
      fixturesDir = resolve(next);
      i += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("usage: bun scripts/audit-eval.ts [--fixtures <dir>] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { fixturesDir, json };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = await loadFixtures(options.fixturesDir);
  const manifest = await loadFixtureManifest(options.fixturesDir);
  const setErrors = validateFixtureSet(fixtures, manifest);

  const summary = await runAuditEvaluation(fixtures, { repeats: 2 });

  const failures: string[] = [...setErrors];
  if (summary.mismatched > 0) failures.push(`${summary.mismatched} fixture(s) did not match their label`);
  if (summary.errored > 0) failures.push(`${summary.errored} fixture(s) errored`);
  if (summary.falseComplete.length > 0) failures.push(`false-complete: ${summary.falseComplete.join(", ")}`);
  if (summary.falseIncomplete.length > 0) failures.push(`false-incomplete: ${summary.falseIncomplete.join(", ")}`);
  if (!summary.reproducibility.identical) failures.push("evaluation was not reproducible");

  const evidenceDir = join(process.cwd(), "audit-build", "logs");
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = join(evidenceDir, "audit-eval.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(
    evidencePath,
    `${JSON.stringify({ fixtureSetErrors: setErrors, summary }, null, 2)}\n`,
    "utf8",
  );

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log("audit evaluation");
    console.log(`  fixtures: ${summary.total}`);
    console.log(
      `  categories: complete=${summary.counts.byCategory.complete} contradictory_incomplete=${summary.counts.byCategory.contradictory_incomplete} blocker=${summary.counts.byCategory.blocker} stale_injection=${summary.counts.byCategory.stale_injection}`,
    );
    console.log(
      `  splits: development=${summary.counts.bySplit.development} held_out=${summary.counts.bySplit.held_out}`,
    );
    console.log(
      `  kinds: schema=${summary.counts.byKind.schema} filesystem=${summary.counts.byKind.filesystem} adapter=${summary.counts.byKind.adapter}`,
    );
    console.log(`  matched: ${summary.matched}/${summary.total}`);
    console.log(`  mismatched: ${summary.mismatched}`);
    console.log(`  errored: ${summary.errored}`);
    console.log(`  blocked: ${summary.blocked}`);
    console.log(`  false-complete: ${summary.falseComplete.length}`);
    console.log(`  planner comparison: ${summary.plannerComparison.status} (${summary.plannerComparison.reason})`);
    console.log(`  reproducibility: runs=${summary.reproducibility.runs} identical=${summary.reproducibility.identical}`);
    console.log(`  evidence: ${evidencePath}`);
    if (failures.length > 0) {
      console.log("FAILURES:");
      for (const failure of failures) console.log(`  - ${failure}`);
    }
  }

  return failures.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`audit evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
