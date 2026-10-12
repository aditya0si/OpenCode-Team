/**
 * Task 5 — OpenCode manual audit adapter.
 *
 * Three additive, manual tools:
 *
 *   teamwork_audit_plan    — capture a bounded snapshot of the candidate, bind a
 *                            task, and (optionally) ask an injected, bounded
 *                            planner for *unconfirmed* criterion suggestions.
 *   teamwork_audit_check   — record a verifier-owned static artifact observation,
 *                            or refuse a model-supplied execution request.
 *   teamwork_audit_report  — replay the store deterministically and write a
 *                            Markdown + JSON report, keeping every missing
 *                            required criterion visible.
 *
 * ## Address audits by opaque id only
 *
 * Tools never accept an arbitrary filesystem root. A trusted host configuration
 * owns an {@link AuditRegistry}; the only thing a model supplies is the opaque
 * `auditId` minted by the registry. The registry resolves that id to a
 * verifier-owned snapshot/store root and refuses an unknown, malformed or
 * escaping id. A forged id (or a stray `root:` argument) is rejected.
 *
 * ## Static-only by default; execution needs genuine human approval
 *
 * `DEFAULT_AUDIT_ADAPTER_POLICY` is `STATIC_ONLY` with `executionEnabled:false`,
 * so the execution branch reports BLOCKED and runs nothing. A model-provided
 * `approval: { humanApproved: true }` is **not** trusted and is rejected
 * explicitly. Only a trusted-code execution seam (never reachable from the
 * model-facing arguments) could ever authorize a run, and even then the imported
 * receipt is stored as `IMPORTED`/nondecisive — it can never certify a check the
 * model approved itself.
 *
 * ## Honest limits
 *
 * The snapshot/store roots are verifier-owned **by declared host assumption**;
 * on a same-user host the operating system does not make them unreachable to the
 * candidate, and this module does not pretend otherwise. Task 4's same-process
 * discovery remains nondecisive: a suite-completeness criterion stays
 * UNVERIFIED. No capture authority or approval mint is exported to the model.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import {
  ClaimSchema,
  CriterionSchema,
  ID_PATTERN,
  LIMITS,
  type AuditScope,
  type Claim,
  type Criterion,
  type Span,
} from "./contracts.js";
import {
  appendCheck,
  bindTask,
  carriesKnownSecret,
  collectArtifactObservation,
  createEvidenceStore,
  EvidenceStoreError,
  openEvidenceStore,
  readAudit,
  redactClaim,
  redactCriterion,
  redactScope,
  redactSpan,
  redactText,
  type BoundTask,
  type CheckReceipt,
} from "./evidence-store.js";
import { renderJson, renderMarkdown, replayAudit, type AuditReport } from "./report.js";
import { captureSnapshot, checkFreshness, type SnapshotManifest } from "./snapshot.js";
import {
  DEFAULT_PLANNER_LIMITS,
  HARD_PLANNER_LIMITS,
  PlannerLimitsSchema,
  planCriteria,
  type PlannerLimits,
  type PlannerModel,
  type PlannerResult,
} from "./planner.js";

// ---------------------------------------------------------------------------
// Trusted configuration
// ---------------------------------------------------------------------------

export const ADAPTER_POLICY_SCHEMA_VERSION = 1;

const ABSOLUTE_OR_RELATIVE = z.string().min(1).max(LIMITS.maxPathLength);

export const AuditAdapterPolicySchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_POLICY_SCHEMA_VERSION).optional(),
    mode: z.enum(["STATIC_ONLY", "DOCKER"]),
    executionEnabled: z.boolean(),
    /** Trusted verifier-owned base for snapshot/store roots. */
    baseRoot: ABSOLUTE_OR_RELATIVE.optional(),
    plannerEnabled: z.boolean().optional(),
  })
  .strict();

export type AuditAdapterPolicy = z.infer<typeof AuditAdapterPolicySchema>;

/** The most restrictive default: static artifact observation only. */
export const DEFAULT_AUDIT_ADAPTER_POLICY: AuditAdapterPolicy = Object.freeze({
  schemaVersion: ADAPTER_POLICY_SCHEMA_VERSION,
  mode: "STATIC_ONLY",
  executionEnabled: false,
  plannerEnabled: false,
}) as AuditAdapterPolicy;

export const AUDIT_BASE_PORTABILITY_NOTE =
  "snapshot/store roots are verifier-owned by declared host assumption; on a same-user host the OS does not make them unreachable to the candidate";

export const ADAPTER_REDACTION_NOTE =
  "adapter-persisted and returned task/planner text is redacted with the same contextual patterns as the evidence store; a secret whose shape matches no known key/pattern remains a limitation";

// ---------------------------------------------------------------------------
// Trusted, human-confirmed task binding
// ---------------------------------------------------------------------------

export const CONFIRMED_TASK_SCHEMA_VERSION = 1;

/**
 * A task binding supplied by **trusted configuration**, never by the model. The
 * original acceptance text and its confirmed criteria/predicate mapping are
 * loaded out of the model-controlled tool arguments, so a model cannot rewrite
 * the task into an easier self-selected criterion and still be reported
 * verified.
 */
export const ConfirmedTaskSchema = z
  .object({
    schemaVersion: z.literal(CONFIRMED_TASK_SCHEMA_VERSION),
    taskId: z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN),
    taskRevision: z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN),
    statement: z.string().min(1).max(LIMITS.maxTextLength * 8),
    criteria: z.array(CriterionSchema).min(1).max(LIMITS.maxCriteria),
    claims: z.array(ClaimSchema).max(LIMITS.maxClaims).optional(),
  })
  .strict();

export type ConfirmedTask = z.infer<typeof ConfirmedTaskSchema>;

function confirmedTaskKey(taskId: string, taskRevision: string): string {
  return `${taskId}\u0000${taskRevision}`;
}

function findConfirmedTask(tasks: ConfirmedTask[] | undefined, taskId: string, taskRevision: string): ConfirmedTask | null {
  if (!tasks || tasks.length === 0) return null;
  const key = confirmedTaskKey(taskId, taskRevision);
  for (const candidate of tasks) {
    const parsed = ConfirmedTaskSchema.safeParse(candidate);
    if (!parsed.success) continue;
    if (confirmedTaskKey(parsed.data.taskId, parsed.data.taskRevision) === key) return parsed.data;
  }
  return null;
}

/**
 * Stable digest of the exact confirmed binding (statement + criteria + claims).
 * Recorded when a confirmed audit is published so a later re-plan of the same
 * `taskId`/`taskRevision` with different confirmed input can be refused.
 */
function confirmedBindingDigest(task: ConfirmedTask): string {
  const material = JSON.stringify({
    statement: task.statement,
    criteria: task.criteria,
    claims: task.claims ?? [],
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Opaque-id registry
// ---------------------------------------------------------------------------

const IdSchema = z.string().min(1).max(128).regex(ID_PATTERN, {
  message: "id must match [A-Za-z0-9][A-Za-z0-9._:-]*",
});

export type AuditRegistryErrorCode =
  | "REGISTRY_CORRUPT"
  | "REGISTRY_IO"
  | "REGISTRY_DUPLICATE"
  | "REGISTRY_INVALID_ENTRY"
  | "REGISTRY_ID_MISMATCH"
  | "REGISTRY_ESCAPE";

export class AuditRegistryError extends Error {
  readonly code: AuditRegistryErrorCode;

  constructor(code: AuditRegistryErrorCode, message: string) {
    super(message);
    this.name = "AuditRegistryError";
    this.code = code;
  }
}

export const AuditRegistryEntrySchema = z
  .object({
    auditId: IdSchema,
    root: ABSOLUTE_OR_RELATIVE,
    storeRoot: ABSOLUTE_OR_RELATIVE,
    snapshotRoot: ABSOLUTE_OR_RELATIVE,
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    createdAt: z.string().min(1).max(64),
    mode: z.enum(["STATIC_ONLY", "DOCKER"]),
    executionEnabled: z.boolean(),
    /**
     * Whether the bound criteria came from trusted human-confirmed configuration
     * or were merely selected by the model. Missing entries default to the
     * fail-safe `UNCONFIRMED` (never verified).
     */
    confirmation: z.enum(["HUMAN_CONFIRMED", "UNCONFIRMED"]).default("UNCONFIRMED"),
    /**
     * Binds a confirmed task to the exact confirmed statement+criteria+claims it
     * was planned with. `confirmation` is a *historical* record of that task
     * revision, not a live "currently approved" flag; this digest lets a re-plan
     * of the same revision with a different confirmed configuration be refused
     * instead of silently implying the new config was the one approved.
     */
    confirmationDigest: z.string().min(1).max(128).optional(),
  })
  .strict();

export type AuditRegistryEntry = z.infer<typeof AuditRegistryEntrySchema>;

const RegistryFileSchema = z
  .object({
    version: z.literal(1),
    audits: z.record(IdSchema, AuditRegistryEntrySchema),
  })
  .strict();

const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;

function canonicalKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function isWithin(child: string, parent: string): boolean {
  const c = stripTrailingSlash(canonicalKey(child));
  const p = stripTrailingSlash(canonicalKey(parent));
  return c === p || c.startsWith(`${p}/`);
}

/**
 * Canonicalise a path that may not exist yet: resolve the deepest existing
 * ancestor's `realpath`, then re-append the remaining segments. This collapses
 * relative/absolute aliases and (on Windows) case differences **before** any
 * directory is created, so an in-candidate base root is refused up front rather
 * than after a partial write.
 */
function canonicalizePlannedPath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuse a verifier-owned base root that overlaps the audited candidate tree in
 * either direction. There is deliberately **no** in-candidate fallback: the
 * check runs before any `mkdir`, so a misconfigured base leaves the candidate
 * bytes, its directory listing and its Git index untouched.
 */
function assertBaseRootExternalToCandidate(baseRoot: string, candidate: string): void {
  const baseKey = stripTrailingSlash(canonicalKey(canonicalizePlannedPath(baseRoot)));
  const candidateKey = stripTrailingSlash(canonicalKey(canonicalizePlannedPath(candidate)));
  if (
    baseKey === candidateKey ||
    baseKey.startsWith(`${candidateKey}/`) ||
    candidateKey.startsWith(`${baseKey}/`)
  ) {
    throw new Error(
      "BASE_ROOT_OVERLAP: the configured auditBaseRoot overlaps the audited candidate tree; configure a verifier-owned directory outside the candidate. No audit storage was written.",
    );
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** Per-base-root mutex so two handles over one base cannot lose a registry update. */
const registryLocks = new Map<string, Promise<void>>();

async function withRegistryLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = registryLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const chained = previous.then(() => gate);
  registryLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (registryLocks.get(key) === chained) registryLocks.delete(key);
  }
}

/**
 * A verifier-owned registry of audits. The model only ever sees `auditId`; the
 * registry maps that opaque token to the trusted snapshot/store roots and
 * refuses everything else.
 *
 * The registry file is treated as *data*, not as an authority: on every
 * `resolve` the roots are re-derived from the trusted base root and the opaque
 * id, every path component is `lstat`-checked (rejecting any symlink/junction)
 * and the canonical `realpath` must stay inside the base root. A registry that
 * names an external store, or an audit directory that is a link, is refused.
 * Corruption is fail-closed: a present-but-unreadable/oversized/invalid
 * registry throws instead of being silently replaced by an empty one, so a
 * `create` can never overwrite a damaged ledger and lose prior audits.
 */
export class AuditRegistry {
  readonly baseRoot: string;
  readonly auditsRoot: string;
  readonly registryPath: string;
  private readonly renameFile: (from: string, to: string) => void;

  constructor(options: { baseRoot: string; renameFile?: (from: string, to: string) => void }) {
    this.baseRoot = resolve(options.baseRoot);
    this.auditsRoot = join(this.baseRoot, "audits");
    this.registryPath = join(this.baseRoot, "registry.json");
    this.renameFile = options.renameFile ?? renameSync;
  }

  /** Stable, path-safe directory for one opaque audit id. */
  auditDir(auditId: unknown): string {
    return join(this.auditsRoot, assertAuditId(auditId));
  }

  private derivedRoots(auditId: string): { root: string; storeRoot: string; snapshotRoot: string } {
    const root = join(this.auditsRoot, auditId);
    const storeRoot = join(root, "store");
    return { root, storeRoot, snapshotRoot: join(storeRoot, "snapshots", "snapshot") };
  }

  private readRegistry(): z.infer<typeof RegistryFileSchema> {
    let stats;
    try {
      stats = lstatSync(this.registryPath);
    } catch (error) {
      if (isEnoent(error)) return { version: 1, audits: {} };
      throw new AuditRegistryError("REGISTRY_IO", "registry is not readable");
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_REGISTRY_BYTES) {
      throw new AuditRegistryError("REGISTRY_CORRUPT", "registry is not a bounded regular file");
    }
    let raw: string;
    try {
      raw = readFileSync(this.registryPath, "utf8");
    } catch {
      throw new AuditRegistryError("REGISTRY_IO", "registry could not be read");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuditRegistryError("REGISTRY_CORRUPT", "registry is not valid JSON");
    }
    const result = RegistryFileSchema.safeParse(parsed);
    if (!result.success) throw new AuditRegistryError("REGISTRY_CORRUPT", "registry failed strict validation");
    return result.data;
  }

  private writeRegistry(value: z.infer<typeof RegistryFileSchema>): void {
    mkdirSync(this.baseRoot, { recursive: true });
    const tmp = `${this.registryPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    // Publication is a single rename over the previous registry. It is not an
    // fsync-backed or multi-file transaction: a crash or a failed rename leaves
    // the previous registry file byte-for-byte unchanged (a lone `.tmp-*` file
    // may remain), and the error propagates fail-closed rather than pretending
    // the update was durable. This differs from the evidence store's
    // backup-swap recovery and is documented as such.
    this.renameFile(tmp, this.registryPath);
  }

  /**
   * Resolve each component under the canonical base root, rejecting any
   * symlink/junction before reading and requiring the canonical `realpath` to
   * stay inside the base root. There is deliberately no lexical fallback.
   */
  private resolveContainedDir(components: string[]): string {
    let current = this.baseRoot;
    for (const component of components) {
      current = join(current, component);
      let stats;
      try {
        stats = lstatSync(current);
      } catch {
        throw new AuditRegistryError("REGISTRY_ESCAPE", `audit path is missing: ${current}`);
      }
      if (stats.isSymbolicLink()) {
        throw new AuditRegistryError("REGISTRY_ESCAPE", `audit path traverses a link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new AuditRegistryError("REGISTRY_ESCAPE", `audit component is not a directory: ${current}`);
      }
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      throw new AuditRegistryError("REGISTRY_ESCAPE", `audit path cannot be resolved: ${current}`);
    }
    let baseReal: string;
    try {
      baseReal = realpathSync(this.baseRoot);
    } catch {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "audit base root cannot be resolved");
    }
    if (!isWithin(real, baseReal)) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", `audit path escapes the base root: ${current}`);
    }
    return real;
  }

  async create(entry: AuditRegistryEntry): Promise<void> {
    const parsed = AuditRegistryEntrySchema.safeParse(entry);
    if (!parsed.success) throw new AuditRegistryError("REGISTRY_INVALID_ENTRY", "invalid audit registry entry");
    const value = parsed.data;
    const derived = this.derivedRoots(value.auditId);
    if (canonicalKey(resolve(value.root)) !== canonicalKey(derived.root)) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry root is not the audit directory");
    }
    if (!isWithin(resolve(value.storeRoot), resolve(value.root))) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry store root escapes the audit root");
    }
    if (!isWithin(resolve(value.snapshotRoot), resolve(value.storeRoot))) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry snapshot root escapes the store root");
    }
    await withRegistryLock(canonicalKey(this.baseRoot), () => {
      const file = this.readRegistry();
      if (file.audits[value.auditId]) {
        throw new AuditRegistryError("REGISTRY_DUPLICATE", `audit id already registered: ${value.auditId}`);
      }
      file.audits[value.auditId] = value;
      this.writeRegistry(file);
    });
  }

  async resolve(auditId: unknown): Promise<AuditRegistryEntry> {
    const id = assertAuditId(auditId);
    const file = this.readRegistry();
    const entry = file.audits[id];
    if (!entry) throw new AuditRegistryError("REGISTRY_INVALID_ENTRY", "unknown audit id");
    if (entry.auditId !== id) {
      throw new AuditRegistryError("REGISTRY_ID_MISMATCH", "registry entry id does not match its key");
    }
    const derived = this.derivedRoots(id);
    if (canonicalKey(resolve(entry.root)) !== canonicalKey(derived.root)) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry root is not the audit directory");
    }
    if (canonicalKey(resolve(entry.storeRoot)) !== canonicalKey(derived.storeRoot)) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry store root is not the audit store");
    }
    if (canonicalKey(resolve(entry.snapshotRoot)) !== canonicalKey(derived.snapshotRoot)) {
      throw new AuditRegistryError("REGISTRY_ESCAPE", "entry snapshot root is not the audit snapshot");
    }
    const realRoot = this.resolveContainedDir(["audits", id]);
    const realStore = this.resolveContainedDir(["audits", id, "store"]);
    const realSnapshot = this.resolveContainedDir(["audits", id, "store", "snapshots", "snapshot"]);
    return { ...entry, root: realRoot, storeRoot: realStore, snapshotRoot: realSnapshot };
  }

  async list(): Promise<AuditRegistryEntry[]> {
    return Object.values(this.readRegistry().audits);
  }
}

function assertAuditId(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AuditRegistryError("REGISTRY_INVALID_ENTRY", "invalid audit id");
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new AuditRegistryError("REGISTRY_INVALID_ENTRY", "unsafe audit id");
  }
  return value;
}

function mintAuditId(): string {
  return `audit-${randomBytes(10).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Trusted execution seam (never reachable from model arguments)
// ---------------------------------------------------------------------------

export interface BoundExecutionRequest {
  auditId: string;
  criterionIds: string[];
  taskId: string;
  taskRevision: string;
  candidateId: string;
  argv: string[];
  image: string;
  inputRoot: string;
  inputDigest: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  scope: AuditScope;
}

/**
 * Trusted-code seam. A host that can *prove* a human approved this exact request
 * (and that genuinely observed the containment capabilities) may return a
 * receipt. The default host has no such seam, so execution reports BLOCKED.
 */
export interface AuditExecutionSeam {
  executeApproved(request: BoundExecutionRequest): Promise<CheckReceipt | null>;
}

export interface AuditToolHost {
  directory: string;
  auditBaseRoot?: string;
  policy?: Partial<AuditAdapterPolicy>;
  plannerModel?: PlannerModel | null;
  plannerLimits?: Partial<PlannerLimits>;
  registry?: AuditRegistry;
  /** Trusted, human-confirmed task bindings; never model-supplied. */
  confirmedTasks?: ConfirmedTask[] | null;
  /** Trusted-code-only; absent by default. */
  execution?: AuditExecutionSeam | null;
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const PlanArgsSchema = z
  .object({
    taskId: IdSchema,
    taskRevision: IdSchema,
    taskText: z.string().min(1).max(LIMITS.maxTextLength * 8).optional(),
    scopeDescription: z.string().min(1).max(LIMITS.maxTextLength),
    scopePaths: z.array(z.string().min(1).max(LIMITS.maxPathLength)).max(LIMITS.maxPaths).optional(),
    scopeExclusions: z.array(z.string().min(1).max(LIMITS.maxPathLength)).max(LIMITS.maxPaths).optional(),
    criteria: z.array(CriterionSchema).max(LIMITS.maxCriteria).optional(),
    claims: z.array(ClaimSchema).max(LIMITS.maxClaims).optional(),
    usePlanner: z.boolean().optional(),
    plannerBudget: PlannerLimitsSchema.optional(),
  })
  .strict();

const CheckArgsSchema = z
  .object({
    auditId: IdSchema,
    kind: z.enum(["artifact", "execution", "cancel"]),
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    path: z.string().min(1).max(LIMITS.maxPathLength).optional(),
    observationId: IdSchema.optional(),
    execution: z
      .object({
        argv: z.array(z.string().min(1).max(4_096)).min(1).max(64),
        image: z.string().min(1).max(512),
        inputRoot: z.string().min(1).max(LIMITS.maxPathLength).optional(),
        env: z.record(z.string().min(1).max(128), z.string().max(65_536)).optional(),
        timeoutMs: z.number().int().min(1).optional(),
        maxOutputBytes: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    approval: z.unknown().optional(),
  })
  .strict();

const ReportArgsSchema = z.object({ auditId: IdSchema }).strict();

type ToolResult = { title?: string; output: string; metadata?: Record<string, unknown> };

function failResult(title: string, error: string): ToolResult {
  return { title, output: `audit ${title} failed: ${error}`, metadata: { ok: false, error } };
}

function setupRequiredResult(title: string): ToolResult {
  return {
    title,
    output:
      "SETUP_REQUIRED: no trusted verifier-owned audit base root is configured. Configure an absolute `auditBaseRoot` (or `auditPolicy.baseRoot`) outside the candidate, or inject a trusted registry; the adapter refuses to write verifier storage inside the audited tree.",
    metadata: { ok: false, error: "SETUP_REQUIRED", setupRequired: true },
  };
}

function resolvePolicy(host: AuditToolHost): AuditAdapterPolicy {
  const merged = { ...DEFAULT_AUDIT_ADAPTER_POLICY, ...(host.policy ?? {}) };
  const parsed = AuditAdapterPolicySchema.safeParse(merged);
  if (!parsed.success) return { ...DEFAULT_AUDIT_ADAPTER_POLICY };
  return parsed.data;
}

/**
 * Resolve the trusted verifier-owned base root. There is deliberately **no**
 * in-candidate default: a default inside the candidate would always fail
 * `OUTPUT_OVERLAP` on `captureSnapshot` and would still create directories in
 * the audited tree first. When trusted configuration does not name a base root
 * the tools fail closed with `SETUP_REQUIRED` **before any write**.
 */
function resolveBaseRoot(host: AuditToolHost, policy: AuditAdapterPolicy): string | null {
  const chosen = policy.baseRoot ?? host.auditBaseRoot;
  if (!chosen) return null;
  return isAbsolute(chosen) ? resolve(chosen) : resolve(host.directory, chosen);
}

/**
 * A model-supplied `plannerBudget` may only ever *narrow* the trusted host
 * limits, never broaden them. The trusted host limits are themselves capped by
 * the hard planner ceilings.
 */
function resolveEffectivePlannerLimits(
  hostLimits: Partial<PlannerLimits> | undefined,
  requested: Partial<PlannerLimits> | undefined,
): PlannerLimits {
  const hostParsed = hostLimits === undefined ? undefined : PlannerLimitsSchema.safeParse(hostLimits);
  const host: PlannerLimits = {
    ...DEFAULT_PLANNER_LIMITS,
    ...(hostParsed && hostParsed.success ? hostParsed.data : {}),
  };
  const requestedParsed = requested === undefined ? undefined : PlannerLimitsSchema.safeParse(requested);
  if (!requestedParsed || !requestedParsed.success) return host;
  const out: PlannerLimits = { ...host };
  const keys = Object.keys(HARD_PLANNER_LIMITS) as Array<keyof PlannerLimits>;
  for (const key of keys) {
    const requestedValue = requestedParsed.data[key];
    if (requestedValue === undefined) continue;
    out[key] = Math.min(host[key], requestedValue);
  }
  return out;
}

async function readFreshness(manifest: SnapshotManifest): Promise<{ fresh: boolean; reasons: string[] }> {
  try {
    const result = await checkFreshness(manifest);
    return { fresh: result.fresh, reasons: [...result.reasons, ...result.errors] };
  } catch (error) {
    return { fresh: false, reasons: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Redact a whole narrative and record a digest/length instead of the raw secret. */
function redactNarrative(input: string): {
  text: string;
  labels: string[];
  originalDigest: string;
  originalLength: number;
} {
  const redaction = redactText(input);
  return {
    text: redaction.text,
    labels: redaction.labels,
    originalDigest: createHash("sha256").update(input, "utf8").digest("hex"),
    originalLength: input.length,
  };
}

// ---------------------------------------------------------------------------
// tool factory
// ---------------------------------------------------------------------------

export const AUDIT_TOOL_NAMES = [
  "teamwork_audit_plan",
  "teamwork_audit_check",
  "teamwork_audit_report",
] as const;

export type AuditToolName = (typeof AUDIT_TOOL_NAMES)[number];

/**
 * Host-facing argument shapes use the plugin's own zod (`tool.schema`), while
 * the strict schemas above run inside `execute`. The host only sees permissive
 * primitives, so a model cannot smuggle a richer structure past validation.
 */
const planArgsDef = {
  taskId: tool.schema.string().describe("stable audit task id"),
  taskRevision: tool.schema.string().describe("task revision this audit is pinned to"),
  taskText: tool.schema.string().describe("verbatim task/acceptance text (preserved separately)"),
  scopeDescription: tool.schema.string().describe("human description of the audited scope"),
  scopePaths: tool.schema.array(tool.schema.string()).optional(),
  scopeExclusions: tool.schema.array(tool.schema.string()).optional(),
  criteria: tool.schema
    .array(tool.schema.any())
    .optional()
    .describe("human-confirmed criteria; a planner only suggests and cannot bind"),
  claims: tool.schema.array(tool.schema.any()).optional(),
  usePlanner: tool.schema.boolean().optional(),
  plannerBudget: tool.schema.any().optional(),
};

const checkArgsDef = {
  auditId: tool.schema.string().describe("opaque id minted by teamwork_audit_plan"),
  kind: tool.schema.enum(["artifact", "execution", "cancel"]),
  criterionIds: tool.schema.array(tool.schema.string()),
  path: tool.schema.string().optional().describe("registered artifact path (artifact kind)"),
  observationId: tool.schema.string().optional(),
  execution: tool.schema.any().optional().describe("candidate execution request (never approved by the model)"),
  approval: tool.schema.any().optional().describe("a model-provided approval is never trusted"),
};

const reportArgsDef = {
  auditId: tool.schema.string().describe("opaque id minted by teamwork_audit_plan"),
};

/**
 * Build the additive audit tools for one plugin instance. The returned record is
 * meant to be spread into the existing plugin tool map.
 */
export function createAuditTools(host: AuditToolHost): Record<string, ToolDefinition> {
  const policy = resolvePolicy(host);
  const baseRoot = resolveBaseRoot(host, policy);
  const registry = host.registry ?? (baseRoot ? new AuditRegistry({ baseRoot }) : null);

  const planTool: ToolDefinition = tool({
    description:
      "Capture a verifier-owned snapshot of the current candidate and bind a task. Criteria come from trusted human-confirmed configuration when present; otherwise the task is bound UNCONFIRMED and can never be reported as verifying the original task. Optionally asks a bounded planner for unconfirmed suggestions. Addresses audits by an opaque auditId. Static-only: no candidate command is executed.",
    args: planArgsDef,
    async execute(args, context) {
      const parsed = PlanArgsSchema.safeParse(args);
      if (!parsed.success) return failResult("plan", "invalid plan arguments");
      if (!registry) return setupRequiredResult("plan");
      const value = parsed.data;
      const directory = context?.directory ?? host.directory;

      const confirmedTask = findConfirmedTask(
        host.confirmedTasks ?? undefined,
        value.taskId,
        value.taskRevision,
      );
      const confirmation: "HUMAN_CONFIRMED" | "UNCONFIRMED" = confirmedTask
        ? "HUMAN_CONFIRMED"
        : "UNCONFIRMED";

      if (!confirmedTask && (!value.taskText || value.taskText.trim().length === 0)) {
        return failResult("plan", "task text is required when no trusted confirmed task is configured");
      }
      const boundStatement = confirmedTask ? confirmedTask.statement : value.taskText!;
      const boundCriteria: Criterion[] = confirmedTask
        ? [...confirmedTask.criteria]
        : ([...(value.criteria ?? [])] as Criterion[]);
      if (boundCriteria.length === 0) {
        return failResult(
          "plan",
          "empty criteria: provide trusted human-confirmed criteria (a planner only suggests; it cannot bind)",
        );
      }
      const boundClaims: Claim[] = confirmedTask
        ? [...(confirmedTask.claims ?? [])]
        : ([...(value.claims ?? [])] as Claim[]);
      // When a trusted task is bound, any model-supplied criteria are recorded
      // as unconfirmed suggestions only and never used as the acceptance set. A
      // suggestion whose predicate path carries a known secret is refused (not
      // redacted, which would change the predicate) and never persisted.
      const rawModelSuggestedCriteria: Criterion[] = confirmedTask
        ? ([...(value.criteria ?? [])] as Criterion[])
        : [];
      const modelSuggestedCriteria: Criterion[] = rawModelSuggestedCriteria.filter(
        (entry) => !(entry.artifactExpectation !== undefined && carriesKnownSecret(entry.artifactExpectation.path)),
      );
      const modelCriteriaSecretRefused = rawModelSuggestedCriteria.length - modelSuggestedCriteria.length;

      // Fail closed *before any write* when the trusted base root overlaps the
      // candidate. `registry.baseRoot` is the resolved verifier-owned base even
      // when a registry was injected; the check creates nothing.
      try {
        assertBaseRootExternalToCandidate(registry.baseRoot, directory);
      } catch (error) {
        return failResult("plan", error instanceof Error ? error.message : String(error));
      }

      // A confirmation is historical to a task revision. Refuse reusing the same
      // revision with a *different* confirmed configuration rather than
      // implying the newly-supplied config is what was approved.
      const confirmedDigest = confirmedTask ? confirmedBindingDigest(confirmedTask) : undefined;
      if (confirmedTask && confirmedDigest) {
        let existing: AuditRegistryEntry[];
        try {
          existing = await registry.list();
        } catch (error) {
          return failResult(
            "plan",
            `registry read failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const conflict = existing.find(
          (entry) =>
            entry.taskId === value.taskId &&
            entry.taskRevision === value.taskRevision &&
            entry.confirmation === "HUMAN_CONFIRMED" &&
            entry.confirmationDigest !== undefined &&
            entry.confirmationDigest !== confirmedDigest,
        );
        if (conflict) {
          return failResult(
            "plan",
            "TASK_REVISION_CONFLICT: this taskId/taskRevision was already confirmed with a different configuration; bump the taskRevision instead of reusing it for different confirmed criteria. No audit storage was written.",
          );
        }
      }

      const auditId = mintAuditId();
      const root = registry.auditDir(auditId);
      const storeRoot = join(root, "store");
      const snapshotRoot = join(storeRoot, "snapshots", "snapshot");

      let snapshot: SnapshotManifest;
      let bound: BoundTask;
      try {
        mkdirSync(registry.auditsRoot, { recursive: true });
        mkdirSync(root, { recursive: false });
        await createEvidenceStore({ root: storeRoot });
        // The store owns the snapshot copy: `bindTask` requires `copyRoot` to
        // live inside the verifier-owned store root.
        const scope: { paths?: string[]; exclusions?: string[] } = {};
        if (value.scopePaths) scope.paths = [...value.scopePaths];
        if (value.scopeExclusions) scope.exclusions = [...value.scopeExclusions];
        snapshot = await captureSnapshot({
          taskId: value.taskId,
          taskRevision: value.taskRevision,
          sourceRoot: directory,
          outputRoot: snapshotRoot,
          ...(value.scopePaths || value.scopeExclusions ? { scope } : {}),
        });
        const store = await openEvidenceStore({ root: storeRoot });
        const scopeInput: AuditScope = {
          description: value.scopeDescription,
          ...(value.scopePaths ? { paths: [...value.scopePaths] } : {}),
          ...(value.scopeExclusions ? { exclusions: [...value.scopeExclusions] } : {}),
        };
        bound = await bindTask(store, {
          taskId: value.taskId,
          taskRevision: value.taskRevision,
          candidateId: snapshot.candidateId,
          scope: scopeInput,
          statement: boundStatement,
          criteria: boundCriteria,
          claims: boundClaims,
          snapshot,
        });
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        return failResult(
          "plan",
          `snapshot/store binding failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let plannerResult: PlannerResult | null = null;
      let plannerError: { code: string; message: string } | null = null;
      let plannerSuggestions: Array<Record<string, unknown>> = [];
      let plannerSuggestionsSecretRefused = 0;
      if (value.usePlanner) {
        if (policy.plannerEnabled !== true) {
          plannerError = { code: "PLANNER_DISABLED", message: "planner is not enabled by trusted policy" };
        } else if (!host.plannerModel) {
          plannerError = { code: "INVALID_INPUT", message: "no planner model is configured" };
        } else {
          const session: { agent?: string; sessionID?: string } = {};
          if (context?.agent) session.agent = context.agent;
          if (context?.sessionID) session.sessionID = context.sessionID;
          const effectiveLimits = resolveEffectivePlannerLimits(host.plannerLimits, value.plannerBudget);
          const result = await planCriteria(
            {
              taskId: value.taskId,
              taskRevision: value.taskRevision,
              taskText: boundStatement,
              acceptanceText: boundStatement,
              scopeDescription: value.scopeDescription,
              session,
            },
            host.plannerModel,
            effectiveLimits,
            { signal: context?.abort },
          );
          if (result.ok) {
            plannerResult = result;
            const acceptance = redactNarrative(result.originalAcceptanceText);
            // A suggestion whose predicate path carries a known secret is
            // refused rather than redacted (redacting would change the
            // predicate). It is never persisted to proposals.json or returned.
            const safeSuggestions = result.suggestions.filter(
              (suggestion) =>
                !(
                  suggestion.artifactExpectation !== undefined &&
                  carriesKnownSecret(suggestion.artifactExpectation.path)
                ),
            );
            plannerSuggestionsSecretRefused = result.suggestions.length - safeSuggestions.length;
            plannerSuggestions = safeSuggestions.map((suggestion) => {
              const span = redactSpan(suggestion.span as Span);
              return {
                ...suggestion,
                ...(suggestion.statement !== undefined
                  ? { statement: redactText(suggestion.statement).text }
                  : {}),
                span,
              };
            });
            writeFileSync(
              join(root, "proposals.json"),
              `${JSON.stringify(
                {
                  schemaVersion: 1,
                  auditId,
                  acceptance: {
                    text: acceptance.text,
                    digest: acceptance.originalDigest,
                    originalLength: acceptance.originalLength,
                    labels: acceptance.labels,
                  },
                  suggestions: plannerSuggestions,
                  limitations: [
                    ...result.limitations,
                    ADAPTER_REDACTION_NOTE,
                    ...(plannerSuggestionsSecretRefused > 0
                      ? [
                          `${plannerSuggestionsSecretRefused} planner suggestion(s) registered a predicate path carrying a known secret pattern and were refused (never persisted or returned).`,
                        ]
                      : []),
                  ],
                },
                null,
                2,
              )}\n`,
              "utf8",
            );
          } else {
            plannerError = { code: result.code, message: result.message };
          }
        }
      }

      const plannerMeta = plannerResult
        ? {
            ok: true as const,
            count: plannerSuggestions.length,
            secretRefused: plannerSuggestionsSecretRefused,
            suggestions: plannerSuggestions,
          }
        : plannerError
          ? { ok: false as const, code: plannerError.code, message: plannerError.message }
          : null;

      const statementRedaction = redactNarrative(boundStatement);
      writeFileSync(join(root, "original-task.txt"), statementRedaction.text, "utf8");
      writeFileSync(
        join(root, "plan.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            auditId,
            taskId: value.taskId,
            taskRevision: value.taskRevision,
            candidateId: snapshot.candidateId,
            confirmation,
            statement: bound.statement,
            statementDigest: statementRedaction.originalDigest,
            statementOriginalLength: statementRedaction.originalLength,
            statementRedactions: statementRedaction.labels,
            criteria: bound.criteria,
            claims: bound.claims,
            unconfirmedModelCriteria: modelSuggestedCriteria.map(redactCriterion),
            unconfirmedModelCriteriaSecretRefused: modelCriteriaSecretRefused,
            planner: plannerMeta,
            snapshot: {
              delta: snapshot.scope.delta,
              partial: snapshot.scope.partial,
              fileCount: snapshot.files.length,
              base: snapshot.base.revision,
              exclusions: snapshot.exclusions.length,
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      try {
        await registry.create({
          auditId,
          root,
          storeRoot,
          snapshotRoot,
          taskId: value.taskId,
          taskRevision: value.taskRevision,
          candidateId: snapshot.candidateId,
          createdAt: new Date().toISOString(),
          mode: policy.mode,
          executionEnabled: policy.executionEnabled,
          confirmation,
          ...(confirmedDigest ? { confirmationDigest: confirmedDigest } : {}),
        });
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        return failResult("plan", `registry write failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const plannerSummary = plannerResult
        ? `planner: ${plannerSuggestions.length} unconfirmed suggestion(s) written to proposals.json`
        : plannerError
          ? `planner failed (${plannerError.code}); static plan unaffected`
          : "planner: not used";

      return {
        title: "audit planned",
        output: [
          `auditId: ${auditId}`,
          `candidate: ${snapshot.candidateId}`,
          `taskConfirmation: ${confirmation}`,
          `criteria: ${bound.criteria.map((c) => c.id).join(", ")}`,
          `snapshot: delta=${snapshot.scope.delta} partial=${snapshot.scope.partial} files=${snapshot.files.length}`,
          plannerSummary,
          confirmation === "HUMAN_CONFIRMED"
            ? "The acceptance criteria come from trusted human-confirmed configuration."
            : "UNCONFIRMED: no trusted human-confirmed criteria were configured; this audit cannot verify the original task.",
        ].join("\n"),
        metadata: {
          ok: true,
          auditId,
          candidateId: snapshot.candidateId,
          taskId: value.taskId,
          taskRevision: value.taskRevision,
          taskConfirmation: confirmation,
          criteriaIds: bound.criteria.map((c) => c.id),
          statementDigest: statementRedaction.originalDigest,
          planner: plannerMeta,
          unconfirmedModelCriteriaSecretRefused: modelCriteriaSecretRefused,
          snapshot: {
            delta: snapshot.scope.delta,
            partial: snapshot.scope.partial,
            fileCount: snapshot.files.length,
          },
        },
      };
    },
  });

  const checkTool: ToolDefinition = tool({
    description:
      "Record a verifier-owned static artifact observation for a bound audit (addressed by opaque auditId), or refuse a model-supplied execution request. Execution is disabled by default and a model-provided approval is never trusted.",
    args: checkArgsDef,
    async execute(args, context) {
      const parsed = CheckArgsSchema.safeParse(args);
      if (!parsed.success) return failResult("check", "invalid check arguments");
      if (!registry) return setupRequiredResult("check");
      const value = parsed.data;

      let entry;
      try {
        entry = await registry.resolve(value.auditId);
      } catch (error) {
        const code = error instanceof AuditRegistryError ? error.code : "REGISTRY_INVALID_ENTRY";
        return failResult("check", `unknown or unsafe auditId (${code})`);
      }

      let store;
      try {
        store = await openEvidenceStore({ root: entry.storeRoot });
      } catch (error) {
        return failResult("check", `cannot open audit store: ${error instanceof Error ? error.message : String(error)}`);
      }

      const audit = await readAudit(store);
      if (!audit.task) return failResult("check", "audit has no bound task");

      if (value.kind === "execution") {
        if (value.approval !== undefined) {
          return {
            title: "audit check blocked",
            output:
              "AUDIT_EXECUTION_REJECTED: a model-provided approval is not trusted; execution requires a genuine human approval bound to the exact command, image, input digest, scope and resources.",
            metadata: { ok: true, blocked: true, auditId: value.auditId, reason: "MODEL_APPROVAL_REJECTED" },
          };
        }
        const freshness = await readFreshness(audit.task.snapshot);
        if (!freshness.fresh) {
          return {
            title: "audit check blocked",
            output: `STALE_SNAPSHOT: the candidate changed after capture (${freshness.reasons.join(", ")}); re-plan before running a check.`,
            metadata: { ok: true, blocked: true, auditId: value.auditId, reason: "STALE_SNAPSHOT" },
          };
        }
        if (!policy.executionEnabled || !host.execution) {
          return {
            title: "audit check blocked",
            output:
              "AUDIT_EXECUTION_BLOCKED: no provable human-approval authority is available in this host; the execution request is recorded as blocked and is never run. Provide the exact bound request to a human/verifier out of band.",
            metadata: { ok: true, blocked: true, auditId: value.auditId, reason: "HUMAN_APPROVAL_UNAVAILABLE" },
          };
        }
        const request: BoundExecutionRequest = {
          auditId: value.auditId,
          criterionIds: [...value.criterionIds],
          taskId: audit.task.taskId,
          taskRevision: audit.task.taskRevision,
          candidateId: audit.task.candidateId,
          argv: value.execution ? [...value.execution.argv] : [],
          image: value.execution?.image ?? "",
          inputRoot: value.execution?.inputRoot ?? audit.task.snapshot.copyRoot,
          inputDigest: audit.task.candidateId,
          env: { ...(value.execution?.env ?? {}) },
          timeoutMs: value.execution?.timeoutMs ?? 30_000,
          maxOutputBytes: value.execution?.maxOutputBytes ?? 65_536,
          scope: audit.task.scope,
        };
        // The trusted seam returns a receipt only for a genuinely approved run.
        const receipt = await host.execution.executeApproved(request);
        if (!receipt) {
          return {
            title: "audit check blocked",
            output: "AUDIT_EXECUTION_BLOCKED: the trusted execution seam did not approve this request.",
            metadata: { ok: true, blocked: true, auditId: value.auditId, reason: "NOT_APPROVED" },
          };
        }
        await appendCheck(store, receipt);
        return {
          title: "audit check recorded",
          output: "execution receipt imported as nondecisive (IMPORTED) provenance",
          metadata: { ok: true, blocked: false, auditId: value.auditId, checkId: receipt.checkId },
        };
      }

      if (value.kind === "cancel") {
        const receipt: CheckReceipt = {
          checkId: value.observationId ?? `cancel-${randomBytes(6).toString("hex")}`,
          taskId: audit.task.taskId,
          taskRevision: audit.task.taskRevision,
          candidateId: audit.task.candidateId,
          criterionIds: [...value.criterionIds],
          kind: "ARTIFACT",
          origin: "MODEL_ASSERTED",
          completion: "CANCELLED",
          result: "UNKNOWN",
          limitations: ["cancelled by caller; terminal and non-decisive"],
        };
        try {
          await appendCheck(store, receipt);
        } catch (error) {
          return failResult("check", `cancel refused: ${error instanceof Error ? error.message : String(error)}`);
        }
        return {
          title: "audit check cancelled",
          output: "the audit is now terminal (CANCELLED); no further checks may be appended",
          metadata: { ok: true, blocked: false, cancelled: true, auditId: value.auditId, checkId: receipt.checkId },
        };
      }

      // kind === "artifact"
      if (!value.path) return failResult("check", "artifact check requires a path");
      const freshness = await readFreshness(audit.task.snapshot);
      if (!freshness.fresh) {
        return {
          title: "audit check blocked",
          output: `STALE_SNAPSHOT: the candidate changed after capture (${freshness.reasons.join(", ")}); re-plan before recording an observation.`,
          metadata: { ok: true, blocked: true, auditId: value.auditId, reason: "STALE_SNAPSHOT" },
        };
      }
      try {
        const checkId = await collectArtifactObservation(store, {
          ...(value.observationId ? { observationId: value.observationId } : {}),
          criterionIds: [...value.criterionIds],
          path: value.path,
        });
        const replayed = replayAudit(await readAudit(store));
        const record = replayed.records.find((entryRecord) => entryRecord.checkId === checkId);
        return {
          title: "audit check recorded",
          output: `static artifact observation recorded as ${checkId} (verifier-owned, byte-level)`,
          metadata: {
            ok: true,
            blocked: false,
            auditId: value.auditId,
            checkId,
            completion: record?.completion ?? "COMPLETED",
            result: record?.result ?? "PASS",
          },
        };
      } catch (error) {
        const code = error instanceof EvidenceStoreError ? error.code : "CHECK_FAILED";
        return {
          title: "audit check blocked",
          output: `AUDIT_CHECK_BLOCKED (${code}): ${error instanceof Error ? error.message : String(error)}`,
          metadata: { ok: true, blocked: true, auditId: value.auditId, reason: code },
        };
      }
    },
  });

  const reportTool: ToolDefinition = tool({
    description:
      "Replay a bound audit (opaque auditId) deterministically, mark it stale if the candidate changed, and write Markdown + JSON reports. Every required criterion that is not supported stays visible.",
    args: reportArgsDef,
    async execute(args) {
      const parsed = ReportArgsSchema.safeParse(args);
      if (!parsed.success) return failResult("report", "invalid report arguments");
      if (!registry) return setupRequiredResult("report");

      let entry;
      try {
        entry = await registry.resolve(parsed.data.auditId);
      } catch (error) {
        const code = error instanceof AuditRegistryError ? error.code : "REGISTRY_INVALID_ENTRY";
        return failResult("report", `unknown or unsafe auditId (${code})`);
      }

      let store;
      let audit;
      try {
        store = await openEvidenceStore({ root: entry.storeRoot });
        audit = await readAudit(store);
      } catch (error) {
        return failResult("report", `cannot read audit: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!audit.task) return failResult("report", "audit has no bound task");

      const freshness = await readFreshness(audit.task.snapshot);
      const stale = !freshness.fresh;
      const confirmed = entry.confirmation === "HUMAN_CONFIRMED";
      const replayed = replayAudit(audit);
      let report: AuditReport;
      if (stale) {
        report = {
          ...replayed,
          valid: false,
          verdict: {
            ...replayed.verdict,
            overall: "STALE",
            reasons: [...replayed.verdict.reasons, "STALE_CANDIDATE"],
          },
          errors: [...replayed.errors, ...freshness.reasons],
        };
      } else if (!confirmed) {
        report = {
          ...replayed,
          valid: false,
          verdict: {
            ...replayed.verdict,
            overall: "INCOMPLETE_EVIDENCE",
            reasons: [...new Set([...replayed.verdict.reasons, "TASK_UNCONFIRMED"])],
          },
          limitations: [
            ...replayed.limitations,
            "The acceptance criteria and predicate mapping were not human-confirmed; static byte observations remain visible, but the original task cannot be reported as verified.",
          ],
        };
      } else {
        report = replayed;
      }

      const markdown = renderMarkdown(report);
      const json = renderJson(report);
      const reportPath = join(entry.root, "report.md");
      const jsonPath = join(entry.root, "report.json");
      try {
        writeFileSync(reportPath, markdown, "utf8");
        writeFileSync(jsonPath, json, "utf8");
      } catch (error) {
        return failResult("report", `cannot write report: ${error instanceof Error ? error.message : String(error)}`);
      }

      const missingCriteria = report.verdict.criteria
        .filter((criterion) => criterion.required && criterion.state !== "SUPPORTED")
        .map((criterion) => criterion.id);

      return {
        title: "audit report",
        output: `auditId: ${parsed.data.auditId}\ntaskConfirmation: ${entry.confirmation}\n\n${markdown}`,
        metadata: {
          ok: true,
          auditId: parsed.data.auditId,
          candidateId: audit.task.candidateId,
          overall: report.verdict.overall,
          stale,
          taskConfirmation: entry.confirmation,
          reportPath,
          jsonPath,
          missingCriteria,
          criteria: report.verdict.criteria.map((criterion) => ({
            id: criterion.id,
            required: criterion.required,
            state: criterion.state,
          })),
          trustedExecutionCaptures: report.trust.trustedExecutionCaptures,
          limitations: report.limitations,
        },
      };
    },
  });

  return {
    teamwork_audit_plan: planTool,
    teamwork_audit_check: checkTool,
    teamwork_audit_report: reportTool,
  };
}

// ---------------------------------------------------------------------------
// Optional host planner transport (uses existing host credentials)
// ---------------------------------------------------------------------------

export interface HostPlannerOptions {
  providerID?: string;
  modelID?: string;
  directory?: string;
}

interface HostClient {
  session: {
    create(input: { body: Record<string, unknown> }): Promise<{ data?: { id?: string } | null }>;
    prompt(input: {
      path: { id: string };
      body: Record<string, unknown>;
      signal?: AbortSignal;
    }): Promise<{ data?: { parts?: Array<{ type?: string; text?: string }> } | null }>;
  };
}

/**
 * Build a bounded planner transport over the already-configured host SDK. It
 * adds no credentials and creates a fresh, root planner session (never a child
 * of the calling session). Wiring this is opt-in trusted configuration.
 */
export function createHostPlannerModel(client: unknown, options: HostPlannerOptions = {}): PlannerModel {
  const hostClient = client as HostClient;
  return async ({ prompt, timeoutMs, signal }) => {
    const created = await hostClient.session.create({ body: { title: "audit-planner" } });
    const id = created?.data?.id;
    if (!id) throw new Error("planner could not create a session");

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body: Record<string, unknown> = { parts: [{ type: "text", text: prompt }] };
      if (options.providerID && options.modelID) {
        body.model = { providerID: options.providerID, modelID: options.modelID };
      }
      const response = await Promise.race([
        hostClient.session.prompt({ path: { id }, body, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`planner prompt exceeded ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      const parts = response?.data?.parts ?? [];
      const text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");
      return { text };
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}
