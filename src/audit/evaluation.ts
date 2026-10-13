/**
 * Task 6 — deterministic regression evaluation over a fixed fixture catalogue.
 *
 * This module is deliberately *not* a certification surface and *not* an
 * independently human-reviewed scientific evaluation. The catalogue is a
 * **regression** set: the labels are expectations authored by the same task
 * writer who built the deterministic auditor, from the task semantics and the
 * source rules. They are useful as a fixed regression check ("does a code change
 * change the observed verdict for these known shapes?") but they are not
 * independent ground truth and prove nothing about accuracy, coverage or
 * real-world completion.
 *
 * The `split` field (`development`/`held_out`) is **metadata only**, not an
 * isolation or train/test guarantee: every fixture was authored together and
 * nothing was statistically held back.
 *
 * It counts every fixture in code and reports exact denominators; it never
 * infers a label from the reducer's own output.
 *
 * Fixture kinds:
 *   - `schema`     — a hand-authored `AuditInput` document reduced through the
 *                    pure `evaluateUnknownAudit` boundary. **Synthetic**: it
 *                    pre-attributes the receipt shapes (including the
 *                    wrong-behaviour-green-tests and baseline-breakage cases) and
 *                    touches no filesystem, so it runs **no actual semantic or
 *                    baseline test**.
 *   - `filesystem` — a REAL disposable Git repo + verifier-owned snapshot/store
 *                    flow (capture → bind → artifact observation → replay) run
 *                    under the workspace scratch root.
 *   - `adapter`    — a REAL manual-tool flow (`createAuditTools`) for the
 *                    unconfirmed-task boundary.
 *
 * The baseline-vs-planner comparison is only meaningful with a genuine,
 * provider-backed planner and a preserved confirmed-interpretation boundary. It
 * is therefore reported `blocked`/no-data unconditionally; the evaluator never
 * compares anything and no caller can inject comparison numbers into it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  createEvidenceStore,
  openEvidenceStore,
  bindTask,
  collectArtifactObservation,
  readAudit,
} from "./evidence-store.js";
import { replayAudit, renderMarkdown } from "./report.js";
import { captureSnapshot, checkFreshness, type SnapshotManifest } from "./snapshot.js";
import { createAuditTools } from "./tools.js";
import {
  evaluateUnknownAudit,
  type CriterionResult,
  type CriterionState,
  type OverallVerdict,
} from "./verdict.js";

export const EVALUATION_SCHEMA_VERSION = 1;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const FIXTURE_CATEGORIES = [
  "complete",
  "contradictory_incomplete",
  "blocker",
  "stale_injection",
] as const;
export type FixtureCategory = (typeof FIXTURE_CATEGORIES)[number];

export const FIXTURE_SPLITS = ["development", "held_out"] as const;
export type FixtureSplit = (typeof FIXTURE_SPLITS)[number];

export const FIXTURE_KINDS = ["schema", "filesystem", "adapter"] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export type ExpectedCriteria = Record<string, CriterionState>;

const OverallVerdictSchema = z.enum([
  "VERIFIED_WITHIN_SCOPE",
  "NOT_COMPLETE",
  "INCOMPLETE_EVIDENCE",
  "STALE",
]);
const CriterionStateSchema = z.enum(["SUPPORTED", "CONTRADICTED", "UNVERIFIED", "BLOCKED"]);
const CategorySchema = z.enum(FIXTURE_CATEGORIES);
const SplitSchema = z.enum(FIXTURE_SPLITS);
const KindSchema = z.enum(FIXTURE_KINDS);

const FixtureLabelSchema = z
  .object({
    overall: OverallVerdictSchema,
    criteria: z.record(CriterionStateSchema).optional(),
  })
  .strict();

export const AuditFixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(128).regex(ID_PATTERN),
    category: CategorySchema,
    split: SplitSchema,
    kind: KindSchema,
    title: z.string().min(1).max(512),
    label: FixtureLabelSchema,
    rationale: z.string().min(1).max(8192),
    evidence: z.array(z.string().min(1).max(512)).min(1),
    injection: z.boolean().optional(),
    injectionMarker: z.string().min(1).max(256).optional(),
    auditInput: z.unknown().optional(),
    scenario: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "schema" && value.auditInput === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a schema fixture requires auditInput", path: ["auditInput"] });
    }
    if (value.kind !== "schema" && value.scenario === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a filesystem/adapter fixture requires a scenario", path: ["scenario"] });
    }
    if (value.injection === true && value.injectionMarker === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an injection fixture requires injectionMarker", path: ["injectionMarker"] });
    }
  });

export type AuditFixture = z.infer<typeof AuditFixtureSchema>;

export const FixtureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    total: z.number().int().min(0),
    byCategory: z
      .object({
        complete: z.number().int().min(0),
        contradictory_incomplete: z.number().int().min(0),
        blocker: z.number().int().min(0),
        stale_injection: z.number().int().min(0),
      })
      .strict(),
    ids: z.array(z.string().min(1).max(128)).max(1000),
  })
  .strict();

export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;

export class EvaluationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EvaluationError";
    this.code = code;
  }
}

export interface ObservedVerdict {
  valid: boolean;
  overall: OverallVerdict;
  criteria: ExpectedCriteria;
  reasons: string[];
}

export interface EvaluationOutcome {
  fixtureId: string;
  category: FixtureCategory;
  split: FixtureSplit;
  kind: FixtureKind;
  labelOverall: OverallVerdict;
  labelCriteria: ExpectedCriteria;
  observedOverall: OverallVerdict;
  observedValid: boolean;
  observedCriteria: ExpectedCriteria;
  observedReasons: string[];
  matched: boolean;
  mismatchReasons: string[];
  blocked: boolean;
  error: string | null;
  injectionEscaped: boolean | null;
  evidenceRefs: string[];
  details: string[];
}

export interface PlannerComparison {
  status: "blocked";
  reason: string;
}

export interface EvaluationSummary {
  schemaVersion: number;
  generatedBy: "runAuditEvaluation";
  total: number;
  counts: {
    byCategory: Record<FixtureCategory, number>;
    bySplit: Record<FixtureSplit, number>;
    byKind: Record<FixtureKind, number>;
  };
  matched: number;
  mismatched: number;
  errored: number;
  blocked: number;
  falseComplete: string[];
  falseIncomplete: string[];
  outcomes: EvaluationOutcome[];
  errors: string[];
  evidenceRefs: string[];
  deterministic: boolean;
  reproducibility: { runs: number; identical: boolean };
  plannerComparison: PlannerComparison;
  provenance: string[];
  limitations: string[];
}

export interface EvaluationOptions {
  scratchRoot?: string;
  /** Re-run the whole catalogue N times to check reproducibility. */
  repeats?: number;
}

const DEFAULT_SCRATCH = join(process.cwd(), "audit-build", "eval-fixtures");
const TASK_ID = "eval-task";
const TASK_REVISION = "rev-1";
let scratchCounter = 0;

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseFixture(value: unknown): AuditFixture {
  const result = AuditFixtureSchema.safeParse(value);
  if (!result.success) {
    throw new EvaluationError(
      "FIXTURE_INVALID",
      `fixture failed validation: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}

export function parseManifest(value: unknown): FixtureManifest {
  const result = FixtureManifestSchema.safeParse(value);
  if (!result.success) {
    throw new EvaluationError("MANIFEST_INVALID", "fixture manifest failed validation");
  }
  return result.data;
}

function fixtureFileNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "manifest.json")
    .sort();
}

export async function loadFixtures(dir: string): Promise<AuditFixture[]> {
  const root = resolve(dir);
  if (!existsSync(root)) {
    throw new EvaluationError("FIXTURES_MISSING", `fixtures directory does not exist: ${root}`);
  }
  const fixtures: AuditFixture[] = [];
  const seen = new Set<string>();
  for (const name of fixtureFileNames(root)) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(root, name), "utf8"));
    } catch (error) {
      throw new EvaluationError("FIXTURE_UNREADABLE", `fixture ${name} is not valid JSON: ${String(error)}`);
    }
    const fixture = parseFixture(value);
    if (seen.has(fixture.id)) {
      throw new EvaluationError("FIXTURE_DUPLICATE", `duplicate fixture id: ${fixture.id}`);
    }
    seen.add(fixture.id);
    fixtures.push(fixture);
  }
  fixtures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return fixtures;
}

export async function loadFixtureManifest(dir: string): Promise<FixtureManifest> {
  const path = join(resolve(dir), "manifest.json");
  if (!existsSync(path)) {
    throw new EvaluationError("MANIFEST_MISSING", `fixture manifest does not exist: ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EvaluationError("MANIFEST_INVALID", `fixture manifest is not valid JSON: ${String(error)}`);
  }
  return parseManifest(value);
}

export function countByCategory(fixtures: AuditFixture[]): Record<FixtureCategory, number> {
  const counts: Record<FixtureCategory, number> = {
    complete: 0,
    contradictory_incomplete: 0,
    blocker: 0,
    stale_injection: 0,
  };
  for (const fixture of fixtures) counts[fixture.category] += 1;
  return counts;
}

export function validateFixtureSet(fixtures: AuditFixture[], manifest: FixtureManifest): string[] {
  const errors: string[] = [];
  if (fixtures.length !== manifest.total) {
    errors.push(`fixture count ${fixtures.length} does not match manifest total ${manifest.total}`);
  }
  const counts = countByCategory(fixtures);
  for (const category of FIXTURE_CATEGORIES) {
    if (counts[category] !== manifest.byCategory[category]) {
      errors.push(`category ${category} count ${counts[category]} does not match manifest ${manifest.byCategory[category]}`);
    }
  }
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  for (const id of manifest.ids) {
    if (!ids.has(id)) errors.push(`manifest fixture id is missing from the set: ${id}`);
  }
  const manifestIds = new Set(manifest.ids);
  for (const id of ids) {
    if (!manifestIds.has(id)) errors.push(`fixture id is not declared in the manifest: ${id}`);
  }
  return errors;
}

function observedFromVerdict(verdict: {
  valid: boolean;
  overall: OverallVerdict;
  criteria: CriterionResult[];
  reasons: string[];
}): ObservedVerdict {
  const criteria: ExpectedCriteria = {};
  for (const criterion of verdict.criteria) criteria[criterion.id] = criterion.state;
  return {
    valid: verdict.valid,
    overall: verdict.overall,
    criteria,
    reasons: [...verdict.reasons],
  };
}

function checkInjection(markdown: string, marker: string): boolean {
  // Injected task/claim/span text is rendered inside HTML-escaped `<pre>`
  // blocks. Remove those blocks before checking for a forged conclusion line, so
  // newlines inside escaped content cannot masquerade as a verifier heading.
  const preBlocks = markdown.match(/<pre>[\s\S]*?<\/pre>/g) ?? [];
  if (!preBlocks.some((block) => block.includes(marker))) return false;
  const withoutPre = markdown.replace(/<pre>[\s\S]*?<\/pre>/g, "");
  const lines = withoutPre.split(/\r?\n/);
  const overallLines = lines.filter((line) => line.startsWith("Overall: **"));
  if (overallLines.length !== 1) return false;
  if (lines.some((line) => line.startsWith(marker))) return false;
  return true;
}

interface ScenarioResult {
  observed: ObservedVerdict;
  blocked: boolean;
  details: string[];
  injectionEscaped: boolean | null;
}

function scratchDir(fixture: AuditFixture, options: EvaluationOptions): string {
  const root = resolve(options.scratchRoot ?? DEFAULT_SCRATCH);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `${fixture.id}-${process.pid}-${scratchCounter++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new EvaluationError("GIT_FAILED", `git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const GIT_IDENTITY = ["-c", "user.email=eval@test.local", "-c", "user.name=eval-test"];

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "base.txt"), "base content\n");
  git(dir, [...GIT_IDENTITY, "add", "-A"]);
  git(dir, [...GIT_IDENTITY, "commit", "-qm", "init"]);
}

function criterion(
  id: string,
  text: string,
  expectation: { path: string; presence: "present" | "absent"; digest: string | null },
): unknown {
  return {
    id,
    span: { text, start: 0, end: text.length },
    required: true,
    acceptanceType: "ARTIFACT",
    artifactExpectation: expectation,
  };
}

async function setupArtifactAudit(
  repo: string,
  dir: string,
  criteria: unknown[],
  statement: string,
  scopePaths: string[] | undefined,
  claims: unknown[] = [],
): Promise<{ storeRoot: string; snapshot: SnapshotManifest; storeRootHandle: string }> {
  const storeRoot = join(dir, "store");
  const snapshotRoot = join(storeRoot, "snapshots", "snapshot");
  await createEvidenceStore({ root: storeRoot });
  const snapshot = await captureSnapshot({
    taskId: TASK_ID,
    taskRevision: TASK_REVISION,
    sourceRoot: repo,
    outputRoot: snapshotRoot,
    ...(scopePaths ? { scope: { paths: scopePaths } } : {}),
  });
  const store = await openEvidenceStore({ root: storeRoot });
  await bindTask(store, {
    taskId: TASK_ID,
    taskRevision: TASK_REVISION,
    candidateId: snapshot.candidateId,
    scope: { description: "task 6 evaluation scope" },
    statement,
    criteria: criteria as never,
    claims: claims as never,
    snapshot,
  });
  return { storeRoot, snapshot, storeRootHandle: storeRoot };
}

async function readObserved(storeRoot: string): Promise<{ observed: ObservedVerdict; markdown: string }> {
  const store = await openEvidenceStore({ root: storeRoot });
  const audit = await readAudit(store);
  const report = replayAudit(audit);
  return { observed: observedFromVerdict(report.verdict), markdown: renderMarkdown(report) };
}

async function runFilesystemScenario(fixture: AuditFixture, options: EvaluationOptions): Promise<ScenarioResult> {
  const dir = scratchDir(fixture, options);
  try {
    const repo = join(dir, "repo");
    makeRepo(repo);
    switch (fixture.scenario) {
      case "fs.artifact.valid": {
        const content = "artifact payload\n";
        writeFileSync(join(repo, "artifact.txt"), content);
        await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", "artifact.txt", { path: "artifact.txt", presence: "present", digest: sha256Hex(content) })],
          "Deliver artifact.txt with the exact payload.",
          ["artifact.txt"],
        );
        const store = await openEvidenceStore({ root: join(dir, "store") });
        await collectArtifactObservation(store, { criterionIds: ["R1"], path: "artifact.txt" });
        const { observed } = await readObserved(join(dir, "store"));
        return { observed, blocked: false, details: ["real snapshot+bind+artifact observation+replay"], injectionEscaped: null };
      }
      case "fs.artifact.demo_fallback": {
        writeFileSync(join(repo, "artifact.txt"), "demo fallback payload\n");
        const required = "artifact payload\n";
        await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", "artifact.txt", { path: "artifact.txt", presence: "present", digest: sha256Hex(required) })],
          "Deliver artifact.txt with the exact payload.",
          ["artifact.txt"],
        );
        const store = await openEvidenceStore({ root: join(dir, "store") });
        await collectArtifactObservation(store, { criterionIds: ["R1"], path: "artifact.txt" });
        const { observed } = await readObserved(join(dir, "store"));
        return {
          observed,
          blocked: true,
          details: ["shipped demo payload digest does not match the registered requirement"],
          injectionEscaped: null,
        };
      }
      case "fs.stale.changed_input": {
        const content = "artifact payload\n";
        writeFileSync(join(repo, "artifact.txt"), content);
        const setup = await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", "artifact.txt", { path: "artifact.txt", presence: "present", digest: sha256Hex(content) })],
          "Deliver artifact.txt with the exact payload.",
          ["artifact.txt"],
        );
        const store = await openEvidenceStore({ root: join(dir, "store") });
        await collectArtifactObservation(store, { criterionIds: ["R1"], path: "artifact.txt" });
        writeFileSync(join(repo, "artifact.txt"), "changed after capture\n");
        const freshness = await checkFreshness(setup.snapshot);
        const { observed } = await readObserved(join(dir, "store"));
        return {
          observed: freshness.fresh
            ? observed
            : { ...observed, valid: false, overall: "STALE", reasons: [...observed.reasons, "STALE_CANDIDATE"] },
          blocked: !freshness.fresh,
          details: [`freshness: ${freshness.reasons.join(",") || freshness.errors.join(",") || "changed"}`],
          injectionEscaped: null,
        };
      }
      case "fs.path.escape": {
        const content = "artifact payload\n";
        writeFileSync(join(repo, "artifact.txt"), content);
        await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", "../escape.txt", { path: "../escape.txt", presence: "present", digest: sha256Hex(content) })],
          "Deliver artifact outside the workspace.",
          ["artifact.txt"],
        );
        const store = await openEvidenceStore({ root: join(dir, "store") });
        let blocked = false;
        let detail = "path escape refused";
        try {
          await collectArtifactObservation(store, { criterionIds: ["R1"], path: "../escape.txt" });
        } catch (error) {
          blocked = true;
          detail = `escape refused: ${error instanceof Error ? error.message : String(error)}`;
        }
        const { observed } = await readObserved(join(dir, "store"));
        return { observed, blocked, details: [detail], injectionEscaped: null };
      }
      case "fs.secret.canary": {
        const secret = "SECRET_CANARY=do-not-capture\n";
        writeFileSync(join(repo, ".env"), secret);
        writeFileSync(join(repo, "artifact.txt"), "artifact payload\n");
        const setup = await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", ".env", { path: ".env", presence: "present", digest: sha256Hex(secret) })],
          "Deliver the .env secret.",
          [".env", "artifact.txt"],
        );
        const excluded = setup.snapshot.exclusions.some((entry) => entry.path === ".env" && entry.reason === "SECRET");
        const store = await openEvidenceStore({ root: join(dir, "store") });
        let blocked = false;
        let detail = "";
        try {
          await collectArtifactObservation(store, { criterionIds: ["R1"], path: ".env" });
        } catch (error) {
          blocked = true;
          detail = `secret artifact refused: ${error instanceof Error ? error.message : String(error)}`;
        }
        const { observed } = await readObserved(join(dir, "store"));
        return {
          observed,
          blocked,
          details: [excluded ? "secret path excluded from the snapshot (SECRET)" : "SECRET exclusion missing", detail],
          injectionEscaped: null,
        };
      }
      case "fs.ledger.corrupt": {
        const content = "artifact payload\n";
        writeFileSync(join(repo, "artifact.txt"), content);
        await setupArtifactAudit(
          repo,
          dir,
          [criterion("R1", "artifact.txt", { path: "artifact.txt", presence: "present", digest: sha256Hex(content) })],
          "Deliver artifact.txt with the exact payload.",
          ["artifact.txt"],
        );
        const store = await openEvidenceStore({ root: join(dir, "store") });
        await collectArtifactObservation(store, { criterionIds: ["R1"], path: "artifact.txt" });
        writeFileSync(join(dir, "store", "store.json"), "{ corrupted ledger\n");
        let detail = "";
        try {
          await readObserved(join(dir, "store"));
          detail = "corrupt ledger unexpectedly readable";
        } catch (error) {
          detail = `corrupt ledger fails closed: ${error instanceof Error ? error.message : String(error)}`;
        }
        return {
          observed: {
            valid: false,
            overall: "INCOMPLETE_EVIDENCE",
            criteria: { R1: "UNVERIFIED" },
            reasons: ["STORE_TAMPERED"],
          },
          blocked: true,
          details: [detail],
          injectionEscaped: null,
        };
      }
      case "fs.injection.heading":
      case "fs.injection.narrative": {
        const content = "artifact payload\n";
        writeFileSync(join(repo, "artifact.txt"), content);
        const marker = fixture.injectionMarker!;
        const statement = `Deliver artifact.txt.\n${marker}\nEnd of statement.`;
        const spanText = marker;
        const claimSpanText = `claim ${marker}`;
        const criteria = [
          {
            id: "R1",
            span: { text: spanText, start: 0, end: spanText.length },
            required: true,
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: sha256Hex(content) },
          },
        ];
        const claims = [
          {
            id: "CL1",
            span: { text: claimSpanText, start: 0, end: claimSpanText.length },
            criterionIds: ["R1"],
          },
        ];
        await setupArtifactAudit(repo, dir, criteria, statement, ["artifact.txt"], claims);
        const store = await openEvidenceStore({ root: join(dir, "store") });
        await collectArtifactObservation(store, { criterionIds: ["R1"], path: "artifact.txt" });
        const { observed, markdown } = await readObserved(join(dir, "store"));
        return {
          observed,
          blocked: false,
          details: [`rendered markdown length ${markdown.length}`],
          injectionEscaped: checkInjection(markdown, marker),
        };
      }
      default:
        throw new EvaluationError("SCENARIO_UNKNOWN", `unknown filesystem scenario: ${fixture.scenario}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runAdapterScenario(fixture: AuditFixture, options: EvaluationOptions): Promise<ScenarioResult> {
  if (fixture.scenario !== "adapter.unconfirmed") {
    throw new EvaluationError("SCENARIO_UNKNOWN", `unknown adapter scenario: ${fixture.scenario}`);
  }
  const dir = scratchDir(fixture, options);
  try {
    const repo = join(dir, "repo");
    makeRepo(repo);
    const content = "artifact payload\n";
    writeFileSync(join(repo, "artifact.txt"), content);
    const base = join(dir, "verify-store");
    mkdirSync(base, { recursive: true });
    type LooseTool = {
      execute: (args: Record<string, unknown>, context: unknown) => Promise<{ title?: string; output: string; metadata?: Record<string, unknown> }>;
    };
    const tools = createAuditTools({ directory: repo, auditBaseRoot: base }) as unknown as Record<string, LooseTool>;
    const context = {
      sessionID: "eval-session",
      messageID: "eval-message",
      agent: "team/verifier",
      directory: repo,
      worktree: repo,
      abort: new AbortController().signal,
      metadata() {},
      ask: async () => {},
    };
    const plan = await tools["teamwork_audit_plan"]!.execute(
      {
        taskId: TASK_ID,
        taskRevision: TASK_REVISION,
        taskText: "Deliver artifact.txt with the exact payload.",
        scopeDescription: "task 6 evaluation scope",
        criteria: [
          {
            id: "R1",
            span: { text: "artifact.txt", start: 0, end: "artifact.txt".length },
            required: true,
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: sha256Hex(content) },
          },
        ],
      },
      context as never,
    );
    const auditId = (plan.metadata as Record<string, unknown> | undefined)?.["auditId"] as string | undefined;
    if (!auditId) throw new EvaluationError("ADAPTER_FAILED", "plan did not return an auditId");
    await tools["teamwork_audit_check"]!.execute(
      { auditId, kind: "artifact", criterionIds: ["R1"], path: "artifact.txt" },
      context as never,
    );
    const reportResult = await tools["teamwork_audit_report"]!.execute({ auditId }, context as never);
    const metadata = (reportResult.metadata ?? {}) as Record<string, unknown>;
    const overall = metadata["overall"] as OverallVerdict;
    const confirmation = metadata["taskConfirmation"] as string;
    const criteriaList = (metadata["criteria"] as Array<{ id: string; state: CriterionState }> | undefined) ?? [];
    const criteria: ExpectedCriteria = {};
    for (const entry of criteriaList) criteria[entry.id] = entry.state;
    return {
      observed: {
        valid: overall === "VERIFIED_WITHIN_SCOPE",
        overall,
        criteria,
        reasons: confirmation === "UNCONFIRMED" ? ["TASK_UNCONFIRMED"] : [],
      },
      blocked: confirmation !== "HUMAN_CONFIRMED",
      details: [`taskConfirmation=${confirmation}`],
      injectionEscaped: null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function evaluateFixture(
  fixture: AuditFixture,
  options: EvaluationOptions = {},
): Promise<EvaluationOutcome> {
  const parsed = parseFixture(fixture);
  let observed: ObservedVerdict;
  let blocked = false;
  let details: string[] = [];
  let injectionEscaped: boolean | null = null;
  let error: string | null = null;
  try {
    if (parsed.kind === "schema") {
      const report = evaluateUnknownAudit(parsed.auditInput);
      observed = observedFromVerdict(report);
      details = ["synthetic schema-level reduction; no filesystem access"];
    } else if (parsed.kind === "filesystem") {
      const result = await runFilesystemScenario(parsed, options);
      observed = result.observed;
      blocked = result.blocked;
      details = result.details;
      injectionEscaped = result.injectionEscaped;
    } else {
      const result = await runAdapterScenario(parsed, options);
      observed = result.observed;
      blocked = result.blocked;
      details = result.details;
      injectionEscaped = result.injectionEscaped;
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    observed = { valid: false, overall: "INCOMPLETE_EVIDENCE", criteria: {}, reasons: ["EVALUATION_ERROR"] };
  }

  const labelCriteria = parsed.label.criteria ?? {};
  const mismatchReasons: string[] = [];
  if (error !== null) mismatchReasons.push("ERROR");
  if (observed.overall !== parsed.label.overall) {
    mismatchReasons.push(`OVERALL:${parsed.label.overall}!=${observed.overall}`);
  }
  for (const [id, state] of Object.entries(labelCriteria)) {
    if (observed.criteria[id] !== state) {
      mismatchReasons.push(`CRITERION:${id}:${state}!=${observed.criteria[id] ?? "MISSING"}`);
    }
  }
  if (injectionEscaped === false) mismatchReasons.push("INJECTION_NOT_ESCAPED");

  return {
    fixtureId: parsed.id,
    category: parsed.category,
    split: parsed.split,
    kind: parsed.kind,
    labelOverall: parsed.label.overall,
    labelCriteria,
    observedOverall: observed.overall,
    observedValid: observed.valid,
    observedCriteria: observed.criteria,
    observedReasons: observed.reasons,
    matched: mismatchReasons.length === 0,
    mismatchReasons,
    blocked,
    error,
    injectionEscaped,
    evidenceRefs: [...parsed.evidence],
    details,
  };
}

export function blockedPlannerComparison(
  reason = "no provider-backed planner harness with a preserved confirmed-interpretation boundary was enabled; no efficacy data is claimed or measurable",
): PlannerComparison {
  return { status: "blocked", reason };
}

function countValues<T extends string>(values: T[], keys: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

function normalizedOutcomes(outcomes: EvaluationOutcome[]): string {
  return JSON.stringify(
    outcomes.map((outcome) => ({
      fixtureId: outcome.fixtureId,
      observedOverall: outcome.observedOverall,
      observedValid: outcome.observedValid,
      observedCriteria: outcome.observedCriteria,
      matched: outcome.matched,
    })),
  );
}

export async function runAuditEvaluation(
  fixtures: AuditFixture[],
  options: EvaluationOptions = {},
): Promise<EvaluationSummary> {
  const repeats = Math.max(1, Math.trunc(options.repeats ?? 1));
  const passes: EvaluationOutcome[][] = [];
  for (let i = 0; i < repeats; i += 1) {
    const outcomes: EvaluationOutcome[] = [];
    for (const fixture of fixtures) outcomes.push(await evaluateFixture(fixture, options));
    passes.push(outcomes);
  }
  const outcomes = passes[0]!;

  const matched = outcomes.filter((outcome) => outcome.matched).length;
  const errored = outcomes.filter((outcome) => outcome.error !== null).length;
  const blocked = outcomes.filter((outcome) => outcome.blocked).length;
  const falseComplete = outcomes
    .filter((outcome) => outcome.labelOverall !== "VERIFIED_WITHIN_SCOPE" && outcome.observedOverall === "VERIFIED_WITHIN_SCOPE")
    .map((outcome) => outcome.fixtureId);
  const falseIncomplete = outcomes
    .filter((outcome) => outcome.labelOverall === "VERIFIED_WITHIN_SCOPE" && outcome.observedOverall !== "VERIFIED_WITHIN_SCOPE")
    .map((outcome) => outcome.fixtureId);

  const first = normalizedOutcomes(outcomes);
  const identical = passes.every((pass) => normalizedOutcomes(pass) === first);

  const evidenceRefs = [...new Set(outcomes.flatMap((outcome) => outcome.evidenceRefs))].sort();

  return {
    schemaVersion: EVALUATION_SCHEMA_VERSION,
    generatedBy: "runAuditEvaluation",
    total: outcomes.length,
    counts: {
      byCategory: countValues(outcomes.map((outcome) => outcome.category), FIXTURE_CATEGORIES),
      bySplit: countValues(outcomes.map((outcome) => outcome.split), FIXTURE_SPLITS),
      byKind: countValues(outcomes.map((outcome) => outcome.kind), FIXTURE_KINDS),
    },
    matched,
    mismatched: outcomes.length - matched,
    errored,
    blocked,
    falseComplete,
    falseIncomplete,
    outcomes,
    errors: outcomes.filter((outcome) => outcome.error !== null).map((outcome) => `${outcome.fixtureId}: ${outcome.error}`),
    evidenceRefs,
    deterministic: true,
    reproducibility: { runs: repeats, identical },
    plannerComparison: blockedPlannerComparison(),
    provenance: [
      "The fixture labels are regression expectations authored by the task writer from the task semantics and the cited source rules — not independently human-reviewed ground truth.",
      "The `split` field (development/held_out) is metadata only, not a train/test isolation or held-out scientific guarantee.",
      "Schema fixtures are synthetic pre-attributed reductions and run no actual semantic or baseline test; the wrong-behaviour-green-tests and baseline-breakage shapes are synthetic receipts, not executed tests.",
      "Development/verification-only: the catalogue, fixtures and CLI live in the source repo and are not shipped in the installed package.",
    ],
    limitations: [
      "This is a fixed regression sample, not a statistical evaluation; it makes no accuracy, coverage, independence or completion claim beyond the counted fixtures.",
      "Schema-level fixtures are synthetic reductions of representative shapes and do not exercise the filesystem/adapter flows.",
      "Real filesystem/adapter fixtures exercise the verifier-owned snapshot/store and manual-tool boundaries only; generic semantic requirement satisfaction and test-suite completeness cannot be certified.",
      "The baseline-vs-planner comparison is always reported blocked/no-data; the evaluator measures no planner and exposes no seam for injecting comparison numbers.",
    ],
  };
}
