/**
 * Task 3 — evidence ledger: provenance, integrity and bounded trust.
 *
 * The evidence store is a **verifier-owned**, exclusively-reserved directory
 * outside the candidate's writable tree. It binds one task identity
 * (`taskId`/`taskRevision`/`candidateId`) plus the original task, criteria,
 * claims and the registered snapshot manifest, then records check receipts as
 * strict, versioned, hash-chained, atomically-written metadata.
 *
 * ## Provenance is not authenticity
 *
 * A receipt is JSON. A JSON field such as `origin: "RUNNER_CAPTURED"` is an
 * *assertion by the caller*, never proof that a verifier executed anything.
 * Therefore:
 *
 *   - the public `appendCheck`/import path **always downgrades** every receipt
 *     to provenance `IMPORTED` (or preserves a claimed `MODEL_ASSERTED` label);
 *     a structurally valid receipt that claims `RUNNER_CAPTURED` can never
 *     become decisive execution evidence;
 *   - only an internal, module-private capture authority can mark a record
 *     `CAPTURED`, and that authority is a module-private `WeakSet` object with
 *     **no exported mint function**. It is not a forgeable string or boolean and
 *     cannot be reached through the public API;
 *   - in this task the only capture is a **static artifact observation** the
 *     store performs itself against the registered snapshot copy (it re-reads
 *     and re-hashes the bytes). It attests byte-level presence/hash, never
 *     semantic satisfaction;
 *   - there is **no execution runner in this task**, so no execution record is
 *     ever captured. `replayAudit` reports zero trusted execution captures.
 *
 * On reopen, trust is reconstructed from bytes rather than a stored flag: a
 * `CAPTURED` artifact observation is only trusted if the store can independently
 * re-derive it from the registered snapshot copy, and `CAPTURED` execution
 * records are always treated as untrusted. Deterministic replay preserves
 * reducer outcomes only for legitimately scoped provenance and fails closed
 * (untrusted evidence, overall `INCOMPLETE_EVIDENCE`) when trust cannot be
 * reconstructed.
 *
 * ## Integrity is not authentication
 *
 * Every record carries a `previousHash`/`hash` pair forming an append-only hash
 * chain. The chain detects corruption and naive edits, but it is **not an
 * authenticated attestation**: a writer with access to the trusted store root
 * can recompute the whole chain (and the unsigned snapshot manifest it binds).
 * Nothing here can authenticate a capture process that ran in a different
 * trust domain. The precise trust assumption is that `<root>` is verifier-owned
 * and not writable by the candidate or the audited model.
 *
 * ## No arbitrary path reads
 *
 * Every store read — `store.json`, `binding.json`, records, snapshot copies and
 * opaque output refs — goes through one bounded, store-relative resolver that
 * `lstat`-checks **every** path component, refuses any symlink/junction before a
 * byte is read, requires the canonical `realpath` to stay inside the canonical
 * store root (with **no lexical fallback**) and re-checks containment after the
 * read. Metadata and records are size- and count-bounded *before* allocation.
 * The store never dereferences an arbitrary path a receipt or imported ledger
 * supplies.
 *
 * ## Predicate-bound artifact trust
 *
 * A captured artifact observation only supports an `ARTIFACT` criterion that
 * registers an explicit byte-level predicate (`artifactExpectation`: exact
 * path, presence and digest). A semantic requirement with no predicate can
 * never be promoted by matching bytes, and on reopen the store re-derives the
 * predicate against the registered snapshot copy rather than trusting the
 * record's own fields.
 *
 * ## Explicit terminal lifecycle
 *
 * `CANCELLED` is a store-level terminal state: once a cancelled check is
 * recorded, subsequent appends are refused with `TERMINAL_STATE`. Mutating
 * operations are serialised by a mutex keyed on the **canonical store root**
 * (not the handle), and records are committed with a collision-safe
 * `link`-after-exclusive-create so two same-root handles cannot lose an update.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  AUDIT_SCHEMA_VERSION,
  AuditValidationError,
  ClaimSchema,
  CriterionSchema,
  AuditScopeSchema,
  DiscoverySchema,
  EvidenceCompletionSchema,
  EvidenceKindSchema,
  EvidenceOriginSchema,
  EvidenceResultSchema,
  ID_PATTERN,
  LIMITS,
  parseAuditInput,
  type ArtifactExpectation,
  type AuditScope,
  type Claim,
  type Criterion,
  type EvidenceCompletion,
  type EvidenceKind,
  type EvidenceOrigin,
  type EvidenceRecord,
  type EvidenceResult,
  type Discovery,
  type Span,
} from "./contracts.js";
import {
  SnapshotManifestSchema,
  normalizeRelPath,
  type SnapshotManifest,
} from "./snapshot.js";

/**
 * Bumped whenever the persisted record/metadata shape changes incompatibly.
 *
 * v2 (round-1 repair): records now carry an explicit `terminal` flag and store
 * metadata carries an explicit `lifecycle`; the resolved limits gained
 * `maxMetadataBytes`/`maxRecordBytes`, so persisted metadata is incompatible
 * with v1.
 */
export const EVIDENCE_STORE_SCHEMA_VERSION = 2;

/**
 * Bumped whenever the redaction/selection/limit policy changes.
 *
 * v2 (round-1 repair): contextual redaction (env key names + adjacent argv
 * flags), predicate-bound artifact capture and complete store-root component
 * validation.
 */
export const STORE_POLICY_VERSION = 2;

/**
 * Absolute ceiling for the tiny `store.json` bootstrap metadata. `store.json`
 * is read before the configured limits are known, so it is bounded by this
 * fixed constant rather than a caller-supplied value.
 */
const MAX_STORE_METADATA_BYTES = 1 * 1024 * 1024;

/** Explicit statement of the storage assumption the whole ledger rests on. */
export const STORE_TRUST_ASSUMPTION =
  "The store root is assumed trusted and verifier-owned, outside candidate and model write access; " +
  "the hash chain detects corruption and naive edits but is not an authenticated attestation, and a writer " +
  "with store access can recompute it together with the unsigned snapshot manifest.";

/** The chain anchor; a fresh store has no records and this head. */
export const GENESIS_HASH = `sha256:${"0".repeat(64)}`;

export const DEFAULT_STORE_LIMITS = {
  maxRecords: 10_000,
  maxArgv: 64,
  maxArgLength: 4096,
  maxOutputChars: 16_384,
  maxOutputInputChars: 4 * 1024 * 1024,
  maxRefBytes: 1_048_576,
  maxOutputRefs: 16,
  maxEnvKeys: 64,
  maxSnapshotFiles: 100_000,
  maxStatementChars: 65_536,
  maxFileHashBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 32 * 1024 * 1024,
  maxRecordBytes: 8 * 1024 * 1024,
} as const;

export const HARD_STORE_LIMITS = {
  maxRecords: 100_000,
  maxArgv: 4096,
  maxArgLength: 65_536,
  maxOutputChars: 1_048_576,
  maxOutputInputChars: 16 * 1024 * 1024,
  maxRefBytes: 16 * 1024 * 1024,
  maxOutputRefs: 256,
  maxEnvKeys: 1024,
  maxSnapshotFiles: 1_000_000,
  maxStatementChars: 1_048_576,
  maxFileHashBytes: 256 * 1024 * 1024,
  maxMetadataBytes: 256 * 1024 * 1024,
  maxRecordBytes: 64 * 1024 * 1024,
} as const;

export type EvidenceStoreErrorCode =
  | "INVALID_OPTIONS"
  | "STORE_EXISTS"
  | "STORE_NOT_FOUND"
  | "STORE_INVALID"
  | "STORE_TAMPERED"
  | "STORE_VERSION_UNSUPPORTED"
  | "NOT_BOUND"
  | "TASK_COLLISION"
  | "TASK_BINDING_INVALID"
  | "DUPLICATE_RECORD"
  | "IDENTITY_MISMATCH"
  | "UNKNOWN_CRITERION"
  | "RECEIPT_INVALID"
  | "LIMIT_EXCEEDED"
  | "UNKNOWN_REF"
  | "REF_ESCAPE"
  | "REF_DIGEST_MISMATCH"
  | "SNAPSHOT_UNREGISTERED"
  | "SNAPSHOT_COPY_MISSING"
  | "SNAPSHOT_COPY_FILE_MISSING"
  | "SNAPSHOT_COPY_ESCAPE"
  | "SNAPSHOT_COPY_TAMPERED"
  | "ARTIFACT_NOT_BOUND"
  | "ARTIFACT_PREDICATE_MISMATCH"
  | "CRITERION_SECRET"
  | "TERMINAL_STATE"
  | "STORE_INCONSISTENT"
  | "ATOMIC_UNAVAILABLE"
  | "ATOMIC_REPLACE_FAILED";

export class EvidenceStoreError extends Error {
  readonly code: EvidenceStoreErrorCode;

  constructor(code: EvidenceStoreErrorCode, message: string) {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filesystem seam (defaults to the real filesystem; used to exercise tamper and
// race outcomes deterministically). Not a policy input.
// ---------------------------------------------------------------------------

export interface EvidenceStoreStats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface EvidenceStoreIo {
  exists(path: string): boolean;
  lstat(path: string): EvidenceStoreStats;
  mkdirp(path: string): void;
  mkdirExclusive(path: string): void;
  readFile(path: string): Buffer;
  writeFileExclusive(path: string, data: Buffer | string): void;
  rename(from: string, to: string): void;
  /**
   * Atomic, collision-safe hard link. Fails with `EEXIST` when `to` exists and
   * never overwrites it, so two racers cannot both commit the same record.
   */
  link(from: string, to: string): void;
  remove(path: string): void;
  readdir(path: string): string[];
  realpath(path: string): string;
}

export const nodeEvidenceStoreIo: EvidenceStoreIo = {
  exists: (path) => existsSync(path),
  lstat: (path) => lstatSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  mkdirExclusive: (path) => {
    mkdirSync(path);
  },
  readFile: (path) => readFileSync(path),
  writeFileExclusive: (path, data) => {
    writeFileSync(path, data, { flag: "wx" });
  },
  rename: (from, to) => renameSync(from, to),
  link: (from, to) => linkSync(from, to),
  remove: (path) => {
    rmSync(path, { force: true });
  },
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync(path),
};

// ---------------------------------------------------------------------------
// Store limits
// ---------------------------------------------------------------------------

export const StoreLimitsSchema = z
  .object({
    maxRecords: z.number().int().min(1).max(HARD_STORE_LIMITS.maxRecords).optional(),
    maxArgv: z.number().int().min(1).max(HARD_STORE_LIMITS.maxArgv).optional(),
    maxArgLength: z.number().int().min(1).max(HARD_STORE_LIMITS.maxArgLength).optional(),
    maxOutputChars: z.number().int().min(1).max(HARD_STORE_LIMITS.maxOutputChars).optional(),
    maxOutputInputChars: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxOutputInputChars)
      .optional(),
    maxRefBytes: z.number().int().min(1).max(HARD_STORE_LIMITS.maxRefBytes).optional(),
    maxOutputRefs: z.number().int().min(1).max(HARD_STORE_LIMITS.maxOutputRefs).optional(),
    maxEnvKeys: z.number().int().min(1).max(HARD_STORE_LIMITS.maxEnvKeys).optional(),
    maxSnapshotFiles: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxSnapshotFiles)
      .optional(),
    maxStatementChars: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxStatementChars)
      .optional(),
    maxFileHashBytes: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxFileHashBytes)
      .optional(),
    maxMetadataBytes: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxMetadataBytes)
      .optional(),
    maxRecordBytes: z
      .number()
      .int()
      .min(1)
      .max(HARD_STORE_LIMITS.maxRecordBytes)
      .optional(),
  })
  .strict();

export type StoreLimits = z.infer<typeof StoreLimitsSchema>;

const ResolvedStoreLimitsSchema = z
  .object({
    maxRecords: z.number().int().min(1).max(HARD_STORE_LIMITS.maxRecords),
    maxArgv: z.number().int().min(1).max(HARD_STORE_LIMITS.maxArgv),
    maxArgLength: z.number().int().min(1).max(HARD_STORE_LIMITS.maxArgLength),
    maxOutputChars: z.number().int().min(1).max(HARD_STORE_LIMITS.maxOutputChars),
    maxOutputInputChars: z.number().int().min(1).max(HARD_STORE_LIMITS.maxOutputInputChars),
    maxRefBytes: z.number().int().min(1).max(HARD_STORE_LIMITS.maxRefBytes),
    maxOutputRefs: z.number().int().min(1).max(HARD_STORE_LIMITS.maxOutputRefs),
    maxEnvKeys: z.number().int().min(1).max(HARD_STORE_LIMITS.maxEnvKeys),
    maxSnapshotFiles: z.number().int().min(1).max(HARD_STORE_LIMITS.maxSnapshotFiles),
    maxStatementChars: z.number().int().min(1).max(HARD_STORE_LIMITS.maxStatementChars),
    maxFileHashBytes: z.number().int().min(1).max(HARD_STORE_LIMITS.maxFileHashBytes),
    maxMetadataBytes: z.number().int().min(1).max(HARD_STORE_LIMITS.maxMetadataBytes),
    maxRecordBytes: z.number().int().min(1).max(HARD_STORE_LIMITS.maxRecordBytes),
  })
  .strict();

type ResolvedStoreLimits = z.infer<typeof ResolvedStoreLimitsSchema>;

const CreateStoreOptionsSchema = z
  .object({
    root: z.string().min(1).max(LIMITS.maxPathLength),
    limits: StoreLimitsSchema.optional(),
  })
  .strict();

const OpenStoreOptionsSchema = z
  .object({ root: z.string().min(1).max(LIMITS.maxPathLength) })
  .strict();

export type CreateStoreOptions = z.infer<typeof CreateStoreOptionsSchema>;
export type OpenStoreOptions = z.infer<typeof OpenStoreOptionsSchema>;

// ---------------------------------------------------------------------------
// Public handle
// ---------------------------------------------------------------------------

export interface EvidenceStore {
  /** Canonical store root (verifier-owned, outside the candidate tree). */
  readonly root: string;
  readonly storeId: string;
  readonly schemaVersion: number;
  readonly policyVersion: number;
  readonly limits: ResolvedStoreLimits;
  /** True when this process created the store; false when reopened from disk. */
  readonly createdInSession: boolean;
}

// ---------------------------------------------------------------------------
// Receipt schema (untrusted input)
// ---------------------------------------------------------------------------

const IdSchema = z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN);

export const CheckReceiptSchema = z
  .object({
    checkId: IdSchema,
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    kind: EvidenceKindSchema,
    origin: EvidenceOriginSchema,
    completion: EvidenceCompletionSchema,
    result: EvidenceResultSchema,
    discovery: DiscoverySchema.optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().min(1).max(64).optional(),
    argv: z
      .array(z.string().max(HARD_STORE_LIMITS.maxArgLength))
      .max(HARD_STORE_LIMITS.maxArgv)
      .optional(),
    cwd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
    startedAt: z.string().min(1).max(64).optional(),
    endedAt: z.string().min(1).max(64).optional(),
    runner: z.string().min(1).max(512).optional(),
    snapshotRef: z
      .object({ candidateId: IdSchema, baseRevision: z.string().max(128).nullable().optional() })
      .strict()
      .optional(),
    output: z.string().max(HARD_STORE_LIMITS.maxOutputInputChars).optional(),
    outputRefs: z
      .array(z.string().min(1).max(LIMITS.maxPathLength))
      .max(HARD_STORE_LIMITS.maxOutputRefs)
      .optional(),
    environment: z.record(z.string().min(1).max(512), z.string().max(65_536)).optional(),
    source: z.string().min(1).max(LIMITS.maxSourceLength).optional(),
    limitations: z
      .array(z.string().min(1).max(LIMITS.maxLimitationLength))
      .max(LIMITS.maxLimitations)
      .optional(),
  })
  .strict();

export type CheckReceipt = z.infer<typeof CheckReceiptSchema>;

export const ArtifactObservationRequestSchema = z
  .object({
    observationId: IdSchema.optional(),
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    path: z.string().min(1).max(LIMITS.maxPathLength),
  })
  .strict();

export type ArtifactObservationRequest = z.infer<typeof ArtifactObservationRequestSchema>;

// ---------------------------------------------------------------------------
// Persisted schemas
// ---------------------------------------------------------------------------

const StoreMetadataSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_STORE_SCHEMA_VERSION),
    policyVersion: z.literal(STORE_POLICY_VERSION),
    storeId: IdSchema,
    createdAt: z.string().min(1).max(64),
    limits: ResolvedStoreLimitsSchema,
    lifecycle: z.enum(["OPEN", "CANCELLED"]),
    chain: z
      .object({
        head: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        length: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();

export type StoreMetadata = z.infer<typeof StoreMetadataSchema>;

export const RecordOutputSchema = z
  .object({
    ref: IdSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(0),
    truncated: z.boolean(),
    redactions: z.array(z.string().min(1).max(64)).max(64),
    preview: z.string().max(HARD_STORE_LIMITS.maxOutputChars),
  })
  .strict();

export type RecordOutput = z.infer<typeof RecordOutputSchema>;

export const ArtifactRefSchema = z
  .object({
    path: z.string().min(1).max(LIMITS.maxPathLength),
    digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    size: z.number().int().min(0).nullable(),
  })
  .strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const StoredRecordSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_STORE_SCHEMA_VERSION),
    sequence: z.number().int().min(0),
    checkId: IdSchema,
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    kind: EvidenceKindSchema,
    claimedOrigin: EvidenceOriginSchema,
    provenance: z.enum(["CAPTURED", "IMPORTED"]),
    completion: EvidenceCompletionSchema,
    result: EvidenceResultSchema,
    discovery: DiscoverySchema.optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().max(64).optional(),
    argv: z.array(z.string().max(HARD_STORE_LIMITS.maxArgLength)).max(HARD_STORE_LIMITS.maxArgv),
    cwd: z.string().max(LIMITS.maxPathLength).optional(),
    startedAt: z.string().max(64).optional(),
    endedAt: z.string().max(64).optional(),
    runner: z.string().max(512).optional(),
    snapshotCandidateId: IdSchema.optional(),
    artifact: ArtifactRefSchema.optional(),
    output: RecordOutputSchema.nullable(),
    referencedOutputs: z.array(IdSchema).max(HARD_STORE_LIMITS.maxOutputRefs),
    environment: z.record(z.string(), z.string()),
    source: z.string().max(LIMITS.maxSourceLength).optional(),
    limitations: z.array(z.string()).max(LIMITS.maxLimitations),
    redactions: z.array(z.string()).max(128),
    /** True when this check's lifecycle is closed and the record is immutable. */
    terminal: z.boolean(),
    terminalReason: z.string().max(128).optional(),
    recordedAt: z.string().min(1).max(64),
    previousHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export type StoredRecord = z.infer<typeof StoredRecordSchema>;

/** A stored record plus the trust the reader independently reconstructs. */
export interface StoredRecordView extends StoredRecord {
  /** True only when this reader could independently re-derive a capture. */
  trusted: boolean;
  /** Origin actually used by replay: `RUNNER_CAPTURED` only when trusted. */
  effectiveOrigin: EvidenceOrigin;
  trustReasons: string[];
}

const BoundTaskSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_STORE_SCHEMA_VERSION),
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    scope: AuditScopeSchema,
    statement: z.string().min(1).max(HARD_STORE_LIMITS.maxStatementChars),
    criteria: z.array(CriterionSchema).max(LIMITS.maxCriteria),
    claims: z.array(ClaimSchema).max(LIMITS.maxClaims),
    snapshot: SnapshotManifestSchema,
    boundAt: z.string().min(1).max(64),
  })
  .strict();

export type BoundTask = z.infer<typeof BoundTaskSchema>;

export const TaskBindingSchema = z
  .object({
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    scope: AuditScopeSchema,
    statement: z.string().min(1).max(HARD_STORE_LIMITS.maxStatementChars),
    criteria: z.array(CriterionSchema).max(LIMITS.maxCriteria),
    claims: z.array(ClaimSchema).max(LIMITS.maxClaims),
    snapshot: SnapshotManifestSchema,
  })
  .strict();

export type TaskBinding = z.infer<typeof TaskBindingSchema>;

export interface AuditIntegrity {
  chainValid: boolean;
  chainLength: number;
  chainHead: string;
  copyValid: boolean;
  errors: string[];
  limitations: string[];
}

export interface AuditRecords {
  schemaVersion: number;
  policyVersion: number;
  storeId: string;
  session: { createdInSession: boolean; reconstruction: "created" | "reopened" };
  /**
   * Explicit lifecycle. `CANCELLED` is a store-level terminal state: once a
   * cancelled check is recorded no further check may be appended. (This is the
   * enforced terminal policy, not merely a stored label.)
   */
  lifecycle: "OPEN" | "CANCELLED";
  task: BoundTask | null;
  records: StoredRecordView[];
  integrity: AuditIntegrity;
  limitations: string[];
  errors: string[];
}

export interface OutputRefResolution {
  ref: string;
  digest: string;
  size: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Path + hash helpers
// ---------------------------------------------------------------------------

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

interface ResolveOptions {
  missing: EvidenceStoreErrorCode;
  escape: EvidenceStoreErrorCode;
  requireDir?: boolean;
}

/**
 * Resolve `components` under a canonical `base` directory, `lstat`-checking
 * **every** component (rejecting any symlink/junction before anything is read)
 * and returning the canonical `realpath` only when it is still contained in
 * `base`. There is deliberately **no lexical fallback**: a path whose realpath
 * cannot be computed is reported as missing, never silently accepted.
 */
function resolveComponents(
  base: string,
  components: string[],
  io: EvidenceStoreIo,
  opts: ResolveOptions,
): string {
  let current = base;
  for (let i = 0; i < components.length; i += 1) {
    const segment = components[i]!;
    current = join(current, segment);
    let stats: EvidenceStoreStats;
    try {
      stats = io.lstat(current);
    } catch {
      throw new EvidenceStoreError(opts.missing, `store path is missing: ${current}`);
    }
    if (stats.isSymbolicLink()) {
      throw new EvidenceStoreError(opts.escape, `store path traverses a link: ${current}`);
    }
    const isLast = i === components.length - 1;
    if (!isLast && !stats.isDirectory()) {
      throw new EvidenceStoreError(opts.escape, `store component is not a directory: ${current}`);
    }
    if (isLast && opts.requireDir && !stats.isDirectory()) {
      throw new EvidenceStoreError(opts.escape, `store path is not a directory: ${current}`);
    }
  }
  let real: string;
  try {
    real = io.realpath(current);
  } catch {
    throw new EvidenceStoreError(opts.missing, `store path cannot be resolved: ${current}`);
  }
  if (!isWithin(real, base)) {
    throw new EvidenceStoreError(opts.escape, `store path escapes its root: ${current}`);
  }
  return real;
}

/** Split an absolute path into components relative to a canonical store root. */
function componentsUnderRoot(root: string, target: string): string[] {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return [];
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new EvidenceStoreError("REF_ESCAPE", `path is outside the store root: ${target}`);
  }
  return rel.split(/[\\/]/).filter((segment) => segment !== "");
}

/** Read a bounded store file with before/after checks; never follows a link. */
function readBoundedFile(
  base: string,
  components: string[],
  maxBytes: number,
  io: EvidenceStoreIo,
  opts: { missing: EvidenceStoreErrorCode; escape: EvidenceStoreErrorCode },
): Buffer {
  const target = resolveComponents(base, components, io, opts);
  const before = io.lstat(target);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new EvidenceStoreError(opts.escape, `store path is not a regular file: ${target}`);
  }
  if (before.size > maxBytes) {
    throw new EvidenceStoreError("LIMIT_EXCEEDED", `store file exceeds the read bound: ${target}`);
  }
  const buffer = io.readFile(target);
  const after = io.lstat(target);
  if (after.isSymbolicLink() || !after.isFile() || after.size !== before.size) {
    throw new EvidenceStoreError("STORE_TAMPERED", `store file changed during read: ${target}`);
  }
  let realAfter: string;
  try {
    realAfter = io.realpath(target);
  } catch {
    throw new EvidenceStoreError("STORE_TAMPERED", `store file cannot be re-resolved: ${target}`);
  }
  if (!isWithin(realAfter, base)) {
    throw new EvidenceStoreError(opts.escape, `store file escaped during read: ${target}`);
  }
  return buffer;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashRecord(withoutHash: Record<string, unknown>): string {
  return `sha256:${sha256Hex(JSON.stringify(withoutHash))}`;
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "EEXIST" ||
      (error as { code?: unknown }).code === "EPERM")
  );
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Redaction + bounds (run before anything is persisted)
// ---------------------------------------------------------------------------

interface RedactionPattern {
  label: string;
  pattern: RegExp;
}

const REDACTION_PATTERNS: RedactionPattern[] = [
  {
    label: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { label: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { label: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "basic-auth-url", pattern: /:\/\/[^/\s:@]+:[^/\s@]+@/g },
  { label: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
  {
    label: "assigned-secret",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|access[_-]?key)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
  },
];

export function redactText(input: string): { text: string; labels: string[] } {
  let text = input;
  const labels = new Set<string>();
  for (const { label, pattern } of REDACTION_PATTERNS) {
    const replaced = text.replace(pattern, `[REDACTED:${label}]`);
    if (replaced !== text) {
      labels.add(label);
      text = replaced;
    }
  }
  return { text, labels: [...labels] };
}

/**
 * Names that mark a value as secret regardless of the value's own shape. This
 * is contextual redaction: an opaque value under `API_KEY`/`APP_SECRET`/`TOKEN`
 * is redacted even though no token pattern matches those arbitrary bytes.
 */
const SECRET_NAME_PATTERN =
  /(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|authorization|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|bearer)/i;

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** Redact environment values by key context, not just by value pattern. */
function redactEnvironment(environment: Record<string, string>): {
  environment: Record<string, string>;
  labels: string[];
} {
  const labels = new Set<string>();
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(environment)) {
    const keyRedaction = redactText(rawKey);
    for (const label of keyRedaction.labels) labels.add(label);
    const key = keyRedaction.text;
    if (isSecretName(rawKey) && value.length > 0) {
      labels.add("env-secret-key");
      out[key] = "[REDACTED:env-secret-key]";
      continue;
    }
    const valueRedaction = redactText(value);
    for (const label of valueRedaction.labels) labels.add(label);
    out[key] = valueRedaction.text;
  }
  return { environment: out, labels: [...labels] };
}

/**
 * Redact argv including the adjacent value of a secret-named flag. The store
 * cannot see the shell's token stream, but it can see `--password` immediately
 * followed by its value, which a pattern match on the isolated value misses.
 */
function redactArgv(argv: string[]): { argv: string[]; labels: string[] } {
  const labels = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const flag = /^(--?[A-Za-z0-9_.-]+)$/.exec(arg);
    if (flag && isSecretName(flag[1]!) && index + 1 < argv.length) {
      out.push(arg);
      out.push("[REDACTED:flag-secret]");
      labels.add("flag-secret");
      index += 1;
      continue;
    }
    const redaction = redactText(arg);
    for (const label of redaction.labels) labels.add(label);
    out.push(redaction.text);
  }
  return { argv: out, labels: [...labels] };
}

export function redactScope(scope: AuditScope): AuditScope {
  const next: AuditScope = { ...scope, description: redactText(scope.description).text };
  if (scope.paths) next.paths = scope.paths.map((path) => redactText(path).text);
  if (scope.exclusions) next.exclusions = scope.exclusions.map((path) => redactText(path).text);
  return next;
}

function boundText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Redact a span's display text without pretending the redaction is the exact
 * original span. When redaction changes the text, the true original offsets are
 * recorded separately (`originalStart`/`originalEnd`) and `redacted` is set; the
 * original secret text is never persisted. An untouched span is returned as-is.
 */
export function redactSpan(span: Span): Span {
  const redacted = redactText(span.text).text;
  if (redacted === span.text) return { ...span };
  return {
    text: redacted,
    start: span.start,
    end: span.start + redacted.length,
    redacted: true,
    originalStart: span.start,
    originalEnd: span.end,
  };
}

export function redactCriterion(criterion: Criterion): Criterion {
  const next: Criterion = {
    ...criterion,
    span: redactSpan(criterion.span),
  };
  if (criterion.statement !== undefined) next.statement = redactText(criterion.statement).text;
  return next;
}

export function redactClaim(claim: Claim): Claim {
  const next: Claim = {
    ...claim,
    span: redactSpan(claim.span),
    criterionIds: [...claim.criterionIds],
  };
  if (claim.text !== undefined) next.text = redactText(claim.text).text;
  return next;
}

/**
 * True when a string carries any known secret pattern (the same contextual
 * patterns used by {@link redactText}). Used to refuse, rather than silently
 * rewrite, a value whose exact bytes are semantically load-bearing.
 */
export function carriesKnownSecret(value: string): boolean {
  return redactText(value).labels.length > 0;
}

/**
 * Refuse a criterion whose registered artifact predicate `path` carries a known
 * secret pattern **before** it is persisted or returned.
 *
 * The path is the predicate identity: redacting it would silently change which
 * bytes the audit checks, so it is never rewritten. Instead the caller fails
 * closed with an error that does not echo the path. This covers trusted and
 * model-supplied criteria alike, and — because every returned/persisted
 * structure derives from the bound task — covers the artifacts, registry,
 * report and tool metadata that reference it.
 */
export function assertPredicatePathsSecretFree(
  criteria: ReadonlyArray<{ artifactExpectation?: { path: string } | undefined }>,
  where: string,
): void {
  for (const criterion of criteria) {
    const path = criterion.artifactExpectation?.path;
    if (path !== undefined && carriesKnownSecret(path)) {
      throw new EvidenceStoreError(
        "CRITERION_SECRET",
        `${where}: a criterion predicate path carries a known secret pattern and was refused; the path is not echoed here. Register a non-secret predicate path.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Metadata + binding IO
// ---------------------------------------------------------------------------

let tmpCounter = 0;

function nextTmp(path: string): string {
  return `${path}.tmp-${process.pid}-${tmpCounter++}`;
}

/**
 * Errors that can mean "the destination is momentarily unavailable" rather than
 * a permanent failure. Some Windows environments (AV/security policy) refuse a
 * `rename` that would replace an existing file but still allow moving that file
 * aside, so these are handled by the recoverable swap below.
 */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EAGAIN"]);
const RENAME_RETRY_ATTEMPTS = 3;
const RENAME_RETRY_DELAY_MS = 5;
/** Backup suffix for the crash-recoverable metadata swap. */
const METADATA_BACKUP_SUFFIX = ".bak";

/** Bounded synchronous sleep without pulling in a dependency. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  return TRANSIENT_RENAME_CODES.has(code);
}

function replaceErrorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error);
}

function lstatOrNull(io: EvidenceStoreIo, path: string): EvidenceStoreStats | null {
  try {
    return io.lstat(path);
  } catch {
    return null;
  }
}

function metadataBackupPath(path: string): string {
  return `${path}${METADATA_BACKUP_SUFFIX}`;
}

/**
 * The classification of one candidate metadata head. Existence alone is never
 * taken as proof that a publication completed: `valid` requires a bounded,
 * link-safe read *and* a successful `StoreMetadataSchema` parse.
 */
type MetadataHead =
  | { kind: "absent" }
  | { kind: "unusable"; reason: string }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; metadata: StoreMetadata };

/**
 * Read and classify a candidate metadata head (the live `store.json` or the
 * `<store.json>.bak` backup). Every candidate is read with the shared bounded,
 * link-safe resolver and validated against `StoreMetadataSchema`; a symlink,
 * non-file, oversized or unreadable candidate is `unusable` (never followed) and
 * malformed JSON / a schema mismatch is `invalid`.
 */
function readMetadataHead(root: string, name: string, io: EvidenceStoreIo): MetadataHead {
  const path = join(root, name);
  const stats = lstatOrNull(io, path);
  if (!stats) return { kind: "absent" };
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { kind: "unusable", reason: `${name} is not a regular file` };
  }
  let buffer: Buffer;
  try {
    buffer = readBoundedFile(root, [name], MAX_STORE_METADATA_BYTES, io, {
      missing: "STORE_NOT_FOUND",
      escape: "STORE_INVALID",
    });
  } catch (error) {
    if (error instanceof EvidenceStoreError && error.code === "STORE_NOT_FOUND") {
      return { kind: "absent" };
    }
    if (error instanceof EvidenceStoreError && error.code === "LIMIT_EXCEEDED") {
      return { kind: "unusable", reason: `${name} exceeds the metadata size bound` };
    }
    return { kind: "unusable", reason: `${name} is not safely readable` };
  }
  const parsed = parseJson(buffer.toString("utf8"));
  if (parsed === undefined) return { kind: "invalid", reason: `${name} is not valid JSON` };
  const result = StoreMetadataSchema.safeParse(parsed);
  if (!result.success) return { kind: "invalid", reason: `${name} failed metadata validation` };
  return { kind: "valid", metadata: result.data };
}

/**
 * Replace the live head with a validated backup. The backup is only ever offered
 * here after `readMetadataHead` classified it `valid`; both paths are fixed
 * single components under the canonical store root, so removing the (invalid or
 * absent) live head can never follow a link.
 */
function restoreMetadataBackup(storePath: string, backupPath: string, io: EvidenceStoreIo): void {
  try {
    if (io.exists(storePath)) io.remove(storePath);
  } catch {
    // best effort; if removal fails the rename below fails closed
  }
  try {
    io.rename(backupPath, storePath);
  } catch {
    // best effort: the validated backup is left in place and the subsequent read
    // fails closed rather than trusting a partial state
  }
}

/**
 * Whether two independently-valid metadata heads belong to the same store. A
 * head that changed the store identity, schema/policy version or resolved limits
 * is not a later version of the same ledger, so it can never justify discarding
 * the other candidate.
 */
function sameStoreIdentity(a: StoreMetadata, b: StoreMetadata): boolean {
  if (a.storeId !== b.storeId) return false;
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.policyVersion !== b.policyVersion) return false;
  const aKeys = Object.keys(a.limits) as (keyof typeof a.limits)[];
  const bKeys = Object.keys(b.limits) as (keyof typeof b.limits)[];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a.limits[key] === b.limits[key]);
}

/**
 * A lifecycle change is only a justified forward transition when a terminal
 * cancellation advanced from an OPEN backup to a strictly longer primary chain.
 * Any other lifecycle disagreement (e.g. CANCELLED -> OPEN, or a change at an
 * equal chain length) is ambiguous.
 */
function lifecycleTransitionJustified(primary: StoreMetadata, backup: StoreMetadata): boolean {
  if (primary.lifecycle === backup.lifecycle) return true;
  return (
    backup.lifecycle === "OPEN" &&
    primary.lifecycle === "CANCELLED" &&
    primary.chain.length > backup.chain.length
  );
}

/** Whether `chain` is a prefix (including genesis) of the committed `records`. */
function isChainPrefix(chain: StoreMetadata["chain"], records: StoredRecord[]): boolean {
  if (chain.length === 0) return chain.head === GENESIS_HASH;
  if (chain.length > records.length) return false;
  return records[chain.length - 1]!.hash === chain.head;
}

type MetadataSelection =
  | { decision: "primary"; reason: string }
  | { decision: "restore-backup"; reason: string }
  | { decision: "ambiguous"; reason: string };

/**
 * Choose between two independently-valid metadata heads using the **actual
 * committed record chain**, never numeric ordering alone.
 *
 * A candidate is coherent only when the on-disk records form exactly its
 * claimed chain (`verifyChain` is empty: matching length, head and every
 * intervening hash). The live head is kept only when it is coherent, shares the
 * backup's store identity/version/policy/limits (with at most a justified
 * OPEN->CANCELLED forward transition) and the backup is a strict prefix of the
 * same chain — so discarding the backup cannot lose a record. When the live head
 * is incoherent but the backup is coherent, the validated backup is restored.
 * Everything else is ambiguous: the backup is preserved and recovery fails
 * closed. `records === null` (unreadable or malformed committed records) is
 * always ambiguous.
 */
function selectMetadataHead(
  primary: StoreMetadata,
  backup: StoreMetadata,
  records: StoredRecord[] | null,
): MetadataSelection {
  if (records === null) {
    return { decision: "ambiguous", reason: "committed records are not safely readable" };
  }
  const primaryCoherent = verifyChain(records, primary).length === 0;
  const backupCoherent = verifyChain(records, backup).length === 0;

  if (primaryCoherent) {
    if (!sameStoreIdentity(primary, backup)) {
      return { decision: "ambiguous", reason: "heads disagree on store identity/version/limits" };
    }
    if (!lifecycleTransitionJustified(primary, backup)) {
      return { decision: "ambiguous", reason: "heads disagree on lifecycle" };
    }
    if (!isChainPrefix(backup.chain, records)) {
      return { decision: "ambiguous", reason: "backup is not a prefix of the live chain" };
    }
    return { decision: "primary", reason: "live head is coherent and the backup is its prefix" };
  }

  if (backupCoherent && sameStoreIdentity(primary, backup)) {
    return { decision: "restore-backup", reason: "live head is incoherent; backup is coherent" };
  }

  return { decision: "ambiguous", reason: "neither head is coherent with the committed records" };
}

/**
 * Read the committed records for a candidate head **without recursing** through
 * `readStoreMetadata`/`recoverInterruptedReplace`; returns `null` when the
 * record set cannot be safely read or fails schema validation.
 */
function readRecoveryChain(
  metadata: StoreMetadata,
  root: string,
  io: EvidenceStoreIo,
): StoredRecord[] | null {
  try {
    return readStoredRecords(root, metadata.limits, io);
  } catch {
    return null;
  }
}

/**
 * Restore a schema-valid backup only after proving it is coherent with the
 * actual committed records; otherwise fail closed and preserve it.
 */
function restoreIfCoherent(
  storePath: string,
  backupPath: string,
  root: string,
  backup: StoreMetadata,
  io: EvidenceStoreIo,
): void {
  const records = readRecoveryChain(backup, root, io);
  if (records === null || verifyChain(records, backup).length !== 0) {
    throw new EvidenceStoreError(
      "STORE_INVALID",
      "backup metadata is schema-valid but not coherent with the committed records; backup preserved",
    );
  }
  restoreMetadataBackup(storePath, backupPath, io);
}

/**
 * Reconcile an interrupted recoverable swap before any read.
 *
 * The swap is a best-effort, crash-recoverable substitute for
 * replace-by-rename on platforms that refuse it. It is **not** an atomic
 * multi-file replacement and is **not** durable without an fsync. It moves the
 * live head to `<store.json>.bak`, publishes the new head and then removes the
 * backup.
 *
 * Nothing is discarded or promoted from mere existence or from a larger claimed
 * count. Both candidates are independently read with bounded, link-safe reads
 * and validated against the metadata schema; a candidate is only accepted when
 * the **actual committed records** form its claimed chain. A corrupt primary
 * never causes a valid backup (the last recoverable head) to be erased — the
 * validated backup is restored instead. A chosen live head must also share the
 * backup's store identity/version/policy/limits (with at most a justified
 * forward lifecycle transition) and the backup must be its chain prefix; any
 * invalid or ambiguous head fails closed with the backup preserved. This is
 * best-effort against crash timing, not protection against concurrent hostile
 * mutation of the store root (which is outside the trust boundary).
 */
function recoverInterruptedReplace(root: string, io: EvidenceStoreIo): void {
  const storePath = join(root, "store.json");
  const backupPath = metadataBackupPath(storePath);
  const primary = readMetadataHead(root, "store.json", io);
  const backup = readMetadataHead(root, "store.json.bak", io);

  if (backup.kind === "absent") return;

  // An unsafe/unreadable backup can never be a valid head: never follow it,
  // never promote it. If there is no valid live head either, fail closed and
  // PRESERVE the backup for inspection instead of erasing it.
  if (backup.kind === "unusable") {
    if (primary.kind !== "valid") {
      throw new EvidenceStoreError(
        "STORE_INVALID",
        `metadata head is not usable and the backup is not safely readable (${backup.reason}); backup preserved`,
      );
    }
    return; // live head is valid; leave the unsafe backup untouched
  }

  if (primary.kind === "invalid" || primary.kind === "unusable") {
    if (backup.kind === "valid") {
      restoreIfCoherent(storePath, backupPath, root, backup.metadata, io);
      return;
    }
    throw new EvidenceStoreError(
      "STORE_INVALID",
      `live metadata head is unusable and the backup is invalid; backup preserved (${primary.reason}; ${backup.reason})`,
    );
  }

  if (primary.kind === "absent") {
    if (backup.kind === "valid") {
      restoreIfCoherent(storePath, backupPath, root, backup.metadata, io);
      return;
    }
    throw new EvidenceStoreError(
      "STORE_INVALID",
      `live metadata head is absent and the backup is invalid; backup preserved (${backup.reason})`,
    );
  }

  // primary is valid
  const records = readRecoveryChain(primary.metadata, root, io);

  if (backup.kind === "invalid") {
    // A schema-valid live head may still be incoherent with the committed
    // records. Only discard the unusable backup once the live head has also been
    // cross-checked against the actual chain; otherwise fail closed and preserve.
    if (records === null || verifyChain(records, primary.metadata).length !== 0) {
      throw new EvidenceStoreError(
        "STORE_INVALID",
        "live metadata head is schema-valid but not coherent with the committed records and the backup is invalid; backup preserved",
      );
    }
    try {
      io.remove(backupPath);
    } catch {
      // best effort
    }
    return;
  }

  // Both valid: choose from the actual record chain, never from numeric order.
  const selection = selectMetadataHead(primary.metadata, backup.metadata, records);
  if (selection.decision === "primary") {
    try {
      io.remove(backupPath);
    } catch {
      // best effort
    }
    return;
  }
  if (selection.decision === "restore-backup") {
    restoreMetadataBackup(storePath, backupPath, io);
    return;
  }
  throw new EvidenceStoreError(
    "STORE_INVALID",
    `live metadata head and backup are both valid but incoherent (${selection.reason}); refusing to choose and preserving the backup`,
  );
}

/**
 * Atomic, collision-safe exclusive commit. A private temp file is written and
 * then hard-linked into place; `link` fails with `EEXIST` rather than
 * overwriting, so two racers can never both commit the same destination. (A
 * plain `exists`-then-`rename` would overwrite the loser's record.)
 *
 * If the atomic primitive is unavailable (e.g. a filesystem without hard
 * links), the operation **fails closed** with `ATOMIC_UNAVAILABLE` rather than
 * falling back to a direct write that could publish half-written JSON as final.
 * Availability is sacrificed deliberately to avoid advertising a non-atomic
 * write as an atomic one.
 */
function writeJsonExclusive(
  io: EvidenceStoreIo,
  path: string,
  value: unknown,
  code: EvidenceStoreErrorCode,
): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = nextTmp(path);
  io.writeFileExclusive(tmp, serialized);
  try {
    io.link(tmp, path);
  } catch (error) {
    try {
      io.remove(tmp);
    } catch {
      // best effort
    }
    if (isEexist(error)) {
      throw new EvidenceStoreError(code, `destination already exists: ${path}`);
    }
    throw new EvidenceStoreError(
      "ATOMIC_UNAVAILABLE",
      `atomic exclusive commit is unavailable on this filesystem: ${path}`,
    );
  }
  try {
    io.remove(tmp);
  } catch {
    // best effort
  }
}

/**
 * Publish the metadata head. The preferred path is a single atomic `rename` of a
 * fully-written temp file over the destination, retried briefly on transient
 * errors. There is deliberately **no** delete-then-rename and **no** direct
 * in-place rewrite.
 *
 * Some environments refuse `rename` when the destination exists (a security
 * policy, not a transient lock) while still allowing the destination to be moved
 * aside. For that case only, a best-effort **crash-recoverable swap** is used:
 * move the old head to `<store.json>.bak`, publish the new head, then remove the
 * backup. This is neither an atomic multi-file replacement nor durable without
 * an fsync. If the swap fails the old head is restored and the caller gets
 * `ATOMIC_REPLACE_FAILED` — the append is never reported as a success. If the
 * process crashes mid-swap the backup is reconciled on the next read by
 * `recoverInterruptedReplace`, which validates both candidates before it
 * discards or promotes anything.
 */
function writeJsonReplace(io: EvidenceStoreIo, path: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = nextTmp(path);
  try {
    io.writeFileExclusive(tmp, serialized);
  } catch (error) {
    throw new EvidenceStoreError(
      "ATOMIC_REPLACE_FAILED",
      `metadata temp write failed (${replaceErrorDetail(error)}); the previous metadata is preserved: ${path}`,
    );
  }

  let primaryError: unknown;
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      io.rename(tmp, path);
      return;
    } catch (error) {
      primaryError = error;
      if (!isTransientRenameError(error)) {
        try {
          io.remove(tmp);
        } catch {
          // best effort
        }
        throw new EvidenceStoreError(
          "ATOMIC_REPLACE_FAILED",
          `atomic metadata replace failed (${replaceErrorDetail(error)}); the previous metadata is preserved: ${path}`,
        );
      }
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }

  const backup = metadataBackupPath(path);
  let movedAside = false;
  try {
    if (io.exists(path)) {
      // Clear any stale backup first: on a host that refuses replace-existing,
      // moving onto an existing backup would fail. Only a backup is removed.
      if (io.exists(backup)) io.remove(backup);
      io.rename(path, backup);
      movedAside = true;
    }
    io.rename(tmp, path);
  } catch (error) {
    try {
      if (movedAside) {
        if (io.exists(path)) io.remove(path);
        io.rename(backup, path);
      }
    } catch {
      // best effort: leave the backup for recoverInterruptedReplace
    }
    try {
      io.remove(tmp);
    } catch {
      // best effort
    }
    throw new EvidenceStoreError(
      "ATOMIC_REPLACE_FAILED",
      `atomic metadata replace failed (${replaceErrorDetail(error ?? primaryError)}); the previous metadata is preserved: ${path}`,
    );
  }
  if (movedAside) {
    try {
      io.remove(backup);
    } catch {
      // best effort; a stale backup is discarded on the next read
    }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readStoreMetadata(root: string, io: EvidenceStoreIo): StoreMetadata {
  // Reconcile an interrupted metadata swap before reading. Recovery validates
  // both candidates first and never erases a valid backup; if the durable state
  // cannot be proven it fails closed rather than guessing at a head.
  recoverInterruptedReplace(root, io);
  const raw = readBoundedFile(root, ["store.json"], MAX_STORE_METADATA_BYTES, io, {
    missing: "STORE_NOT_FOUND",
    escape: "STORE_INVALID",
  }).toString("utf8");
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    throw new EvidenceStoreError("STORE_INVALID", "store metadata is not valid JSON");
  }
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && version !== EVIDENCE_STORE_SCHEMA_VERSION) {
    throw new EvidenceStoreError(
      "STORE_VERSION_UNSUPPORTED",
      `unsupported store schema version: ${version}`,
    );
  }
  const result = StoreMetadataSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvidenceStoreError("STORE_INVALID", "store metadata failed validation");
  }
  return result.data;
}

function bindingPath(root: string): string {
  return join(root, "binding.json");
}

function readBinding(
  root: string,
  io: EvidenceStoreIo,
  limits: ResolvedStoreLimits,
): BoundTask | null {
  let buffer: Buffer;
  try {
    buffer = readBoundedFile(root, ["binding.json"], limits.maxMetadataBytes, io, {
      missing: "NOT_BOUND",
      escape: "STORE_TAMPERED",
    });
  } catch (error) {
    if (error instanceof EvidenceStoreError && error.code === "NOT_BOUND") return null;
    throw error;
  }
  const parsed = parseJson(buffer.toString("utf8"));
  if (parsed === undefined) {
    throw new EvidenceStoreError("STORE_TAMPERED", "binding is not valid JSON");
  }
  const result = BoundTaskSchema.safeParse(parsed);
  if (!result.success) {
    throw new EvidenceStoreError("STORE_TAMPERED", "binding failed validation");
  }
  return result.data;
}

function requireBinding(
  root: string,
  io: EvidenceStoreIo,
  limits: ResolvedStoreLimits,
): BoundTask {
  const binding = readBinding(root, io, limits);
  if (!binding) throw new EvidenceStoreError("NOT_BOUND", "no task is bound to this store");
  return binding;
}

function resolveLimits(options: CreateStoreOptions): ResolvedStoreLimits {
  const merged = { ...DEFAULT_STORE_LIMITS, ...(options.limits ?? {}) };
  return ResolvedStoreLimitsSchema.parse(merged);
}

// ---------------------------------------------------------------------------
// Snapshot copy validation
// ---------------------------------------------------------------------------

interface CopyValidation {
  valid: boolean;
  errors: string[];
}

function validateSnapshotCopy(
  store: EvidenceStore,
  snapshot: SnapshotManifest,
  io: EvidenceStoreIo,
): CopyValidation {
  const errors: string[] = [];
  let copyReal: string;
  try {
    const components = componentsUnderRoot(store.root, snapshot.copyRoot);
    copyReal = resolveComponents(store.root, components, io, {
      missing: "SNAPSHOT_COPY_MISSING",
      escape: "SNAPSHOT_COPY_ESCAPE",
      requireDir: true,
    });
  } catch {
    return { valid: false, errors: ["SNAPSHOT_COPY_OUTSIDE_STORE"] };
  }
  for (const file of snapshot.files) {
    if (file.hash === null) continue; // deleted files are not copied
    let rel: string;
    try {
      rel = normalizeRelPath(file.path);
    } catch {
      errors.push(`SNAPSHOT_PATH_UNSAFE:${file.path}`);
      continue;
    }
    let buffer: Buffer;
    try {
      buffer = readBoundedFile(copyReal, rel.split("/"), store.limits.maxFileHashBytes, io, {
        missing: "SNAPSHOT_COPY_FILE_MISSING",
        escape: "SNAPSHOT_COPY_ESCAPE",
      });
    } catch (error) {
      const code = error instanceof EvidenceStoreError ? error.code : "SNAPSHOT_COPY_UNREADABLE";
      errors.push(`${code}:${rel}`);
      continue;
    }
    if (sha256Hex(buffer) !== file.hash) {
      errors.push(`SNAPSHOT_COPY_TAMPERED:${rel}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Probe a file beneath a canonical `base` without following any link, returning
 * whether it is a regular file, absent, or an unsafe (linked) path.
 */
function probeFileUnderBase(
  base: string,
  components: string[],
  io: EvidenceStoreIo,
): "file" | "absent" | "unsafe" {
  let current = base;
  for (let i = 0; i < components.length; i += 1) {
    current = join(current, components[i]!);
    let stats: EvidenceStoreStats;
    try {
      stats = io.lstat(current);
    } catch {
      return "absent";
    }
    if (stats.isSymbolicLink()) return "unsafe";
    const isLast = i === components.length - 1;
    if (!isLast && !stats.isDirectory()) return "unsafe";
    if (isLast) return stats.isFile() ? "file" : "unsafe";
  }
  return "absent";
}

type ArtifactEvaluation =
  | { status: "UNBOUND"; reason: string }
  | { status: "UNKNOWN_CRITERION"; criterionId: string }
  | { status: "MISMATCH"; reason: string }
  | { status: "UNREGISTERED"; path: string }
  | { status: "TAMPERED"; reason: string }
  | {
      status: "OBSERVED";
      completion: EvidenceCompletion;
      result: EvidenceResult;
      artifact: ArtifactRef;
    };

/**
 * Independently evaluate a byte-level artifact predicate for a set of criteria.
 *
 * A criterion only participates when it registers an explicit
 * `artifactExpectation` (path/presence/digest). The requested path must equal
 * the registered expectation and the observed bytes are hashed under full root
 * containment. A criterion without a predicate is `UNBOUND` and can never be
 * satisfied by static bytes.
 */
function evaluateArtifactPredicate(
  store: EvidenceStore,
  task: BoundTask,
  criterionIds: string[],
  requestedPath: string,
  io: EvidenceStoreIo,
): ArtifactEvaluation {
  let expectation: ArtifactExpectation | null = null;
  let expectedKey: string | null = null;
  for (const id of criterionIds) {
    const criterion = task.criteria.find((entry) => entry.id === id);
    if (!criterion) return { status: "UNKNOWN_CRITERION", criterionId: id };
    if (!criterion.artifactExpectation) {
      return { status: "UNBOUND", reason: `criterion ${id} registers no artifact expectation` };
    }
    let normalized: string;
    try {
      normalized = normalizeRelPath(criterion.artifactExpectation.path);
    } catch {
      return { status: "MISMATCH", reason: `criterion ${id} expectation path is unsafe` };
    }
    if (expectation === null) {
      expectation = criterion.artifactExpectation;
      expectedKey = canonicalKey(normalized);
      continue;
    }
    if (
      canonicalKey(normalized) !== expectedKey ||
      criterion.artifactExpectation.presence !== expectation.presence ||
      criterion.artifactExpectation.digest !== expectation.digest
    ) {
      return { status: "MISMATCH", reason: "criteria register inconsistent artifact expectations" };
    }
  }
  if (expectation === null || expectedKey === null) {
    return { status: "UNBOUND", reason: "no artifact expectation registered" };
  }
  let requested: string;
  try {
    requested = normalizeRelPath(requestedPath);
  } catch {
    return { status: "MISMATCH", reason: "requested artifact path is unsafe" };
  }
  if (canonicalKey(requested) !== expectedKey) {
    return {
      status: "MISMATCH",
      reason: "requested path does not match the registered artifact expectation",
    };
  }

  const entry = task.snapshot.files.find((file) => canonicalKey(file.path) === expectedKey);
  if (!entry) return { status: "UNREGISTERED", path: requested };

  let copyReal: string;
  try {
    const components = componentsUnderRoot(store.root, task.snapshot.copyRoot);
    copyReal = resolveComponents(store.root, components, io, {
      missing: "SNAPSHOT_COPY_TAMPERED",
      escape: "SNAPSHOT_COPY_TAMPERED",
      requireDir: true,
    });
  } catch {
    return { status: "TAMPERED", reason: "registered snapshot copy is unavailable" };
  }

  const fileComponents = requested.split("/");
  if (expectation.presence === "present") {
    if (entry.hash === null || entry.hash !== expectation.digest) {
      return {
        status: "OBSERVED",
        completion: "BLOCKED",
        result: "UNKNOWN",
        artifact: { path: requested, digest: null, size: null },
      };
    }
    let buffer: Buffer;
    try {
      buffer = readBoundedFile(copyReal, fileComponents, store.limits.maxFileHashBytes, io, {
        missing: "SNAPSHOT_COPY_TAMPERED",
        escape: "SNAPSHOT_COPY_TAMPERED",
      });
    } catch {
      return { status: "TAMPERED", reason: "expected artifact is missing or unsafe" };
    }
    if (sha256Hex(buffer) !== expectation.digest) {
      return { status: "TAMPERED", reason: "registered artifact bytes do not match the expectation" };
    }
    return {
      status: "OBSERVED",
      completion: "COMPLETED",
      result: "PASS",
      artifact: { path: requested, digest: expectation.digest, size: buffer.byteLength },
    };
  }

  // presence "absent"
  if (entry.hash !== null) {
    return {
      status: "OBSERVED",
      completion: "BLOCKED",
      result: "UNKNOWN",
      artifact: { path: requested, digest: null, size: null },
    };
  }
  const probe = probeFileUnderBase(copyReal, fileComponents, io);
  if (probe !== "absent") {
    return {
      status: "OBSERVED",
      completion: "BLOCKED",
      result: "UNKNOWN",
      artifact: { path: requested, digest: null, size: null },
    };
  }
  return {
    status: "OBSERVED",
    completion: "COMPLETED",
    result: "PASS",
    artifact: { path: requested, digest: null, size: null },
  };
}

/**
 * Reconstruct trust for a stored `CAPTURED` artifact record on reopen. The
 * record is trusted only when an independent re-evaluation of the registered
 * snapshot against the criterion predicate reproduces the record's exact
 * completion/result/identity. A forged record (arbitrary path, stale digest or
 * a criterion with no predicate) can never be trusted.
 */
function revalidateArtifactCapture(
  store: EvidenceStore,
  task: BoundTask | null,
  record: StoredRecord,
  io: EvidenceStoreIo,
): boolean {
  if (!task || !record.artifact || record.kind !== "ARTIFACT") return false;
  const evaluation = evaluateArtifactPredicate(
    store,
    task,
    record.criterionIds,
    record.artifact.path,
    io,
  );
  if (evaluation.status !== "OBSERVED") return false;
  if (evaluation.completion !== record.completion || evaluation.result !== record.result) return false;
  if (canonicalKey(evaluation.artifact.path) !== canonicalKey(record.artifact.path)) return false;
  if ((evaluation.artifact.digest ?? null) !== (record.artifact.digest ?? null)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

/**
 * Canonical process-wide identity of each handle, keyed by the canonical store
 * root (not the handle object). Two handles reopened for the same root share
 * one mutex, so they cannot lose metadata updates to each other.
 */
const storeRootKeys = new WeakMap<EvidenceStore, string>();

function makeHandle(
  root: string,
  metadata: StoreMetadata,
  createdInSession: boolean,
): EvidenceStore {
  const handle: EvidenceStore = {
    root,
    storeId: metadata.storeId,
    schemaVersion: metadata.schemaVersion,
    policyVersion: metadata.policyVersion,
    limits: metadata.limits,
    createdInSession,
  };
  storeRootKeys.set(handle, canonicalKey(root));
  return handle;
}

export async function createEvidenceStore(
  options: CreateStoreOptions,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<EvidenceStore> {
  const result = CreateStoreOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new EvidenceStoreError("INVALID_OPTIONS", "invalid createEvidenceStore options");
  }
  const root = resolve(result.data.root);
  if (io.exists(root)) {
    throw new EvidenceStoreError("STORE_EXISTS", `store root already exists: ${root}`);
  }
  const limits = resolveLimits(result.data);
  io.mkdirp(dirname(root));
  try {
    io.mkdirExclusive(root);
  } catch (error) {
    if (isEexist(error)) {
      throw new EvidenceStoreError("STORE_EXISTS", `store root already exists: ${root}`);
    }
    throw error;
  }
  io.mkdirExclusive(join(root, "records"));
  io.mkdirExclusive(join(root, "outputs"));
  const metadata: StoreMetadata = {
    schemaVersion: EVIDENCE_STORE_SCHEMA_VERSION,
    policyVersion: STORE_POLICY_VERSION,
    storeId: `store-${randomHex(8)}`,
    createdAt: new Date().toISOString(),
    limits,
    lifecycle: "OPEN",
    chain: { head: GENESIS_HASH, length: 0 },
  };
  writeJsonExclusive(io, join(root, "store.json"), metadata, "STORE_EXISTS");
  const rootReal = io.realpath(root);
  return makeHandle(rootReal, metadata, true);
}

export async function openEvidenceStore(
  options: OpenStoreOptions,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<EvidenceStore> {
  const result = OpenStoreOptionsSchema.safeParse(options);
  if (!result.success) {
    throw new EvidenceStoreError("INVALID_OPTIONS", "invalid openEvidenceStore options");
  }
  const root = resolve(result.data.root);
  if (!io.exists(root)) {
    throw new EvidenceStoreError("STORE_NOT_FOUND", `store root does not exist: ${root}`);
  }
  const stats = io.lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new EvidenceStoreError("STORE_INVALID", `store root is not a real directory: ${root}`);
  }
  const rootReal = io.realpath(root);
  const metadata = readStoreMetadata(rootReal, io);
  const handle = makeHandle(rootReal, metadata, false);
  // The records and outputs directories are part of the reserved layout; refuse
  // an opened root whose directories have been replaced with links.
  resolveComponents(rootReal, ["records"], io, {
    missing: "STORE_INVALID",
    escape: "STORE_INVALID",
    requireDir: true,
  });
  resolveComponents(rootReal, ["outputs"], io, {
    missing: "STORE_INVALID",
    escape: "STORE_INVALID",
    requireDir: true,
  });
  return handle;
}

// ---------------------------------------------------------------------------
// Task binding
// ---------------------------------------------------------------------------

function invalidBinding(message: string): EvidenceStoreError {
  return new EvidenceStoreError("TASK_BINDING_INVALID", message);
}

export async function bindTask(
  store: EvidenceStore,
  binding: TaskBinding,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<BoundTask> {
  const parsedResult = TaskBindingSchema.safeParse(binding);
  if (!parsedResult.success) {
    throw invalidBinding("task binding failed schema validation");
  }
  const parsed = parsedResult.data;

  // Reuse the contracts boundary for duplicate-ID and dangling-reference checks.
  try {
    parseAuditInput({
      schemaVersion: AUDIT_SCHEMA_VERSION,
      taskId: parsed.taskId,
      taskRevision: parsed.taskRevision,
      candidateId: parsed.candidateId,
      scope: parsed.scope,
      criteria: parsed.criteria,
      claims: parsed.claims,
      evidence: [],
      waivers: [],
    });
  } catch (error) {
    const detail = error instanceof AuditValidationError ? JSON.stringify(error.issues) : String(error);
    throw invalidBinding(`task binding failed reference validation: ${detail}`);
  }

  // Reject secret-bearing predicate paths before anything is persisted.
  assertPredicatePathsSecretFree(parsed.criteria, "task binding");

  if (parsed.snapshot.candidateId !== parsed.candidateId) {
    throw new EvidenceStoreError("IDENTITY_MISMATCH", "snapshot candidateId does not match binding");
  }
  if (parsed.snapshot.taskId !== parsed.taskId || parsed.snapshot.taskRevision !== parsed.taskRevision) {
    throw new EvidenceStoreError("IDENTITY_MISMATCH", "snapshot task identity does not match binding");
  }
  if (parsed.snapshot.files.length > store.limits.maxSnapshotFiles) {
    throw new EvidenceStoreError("LIMIT_EXCEEDED", "snapshot declares too many files");
  }

  return withLock(store, async () => {
    if (io.exists(bindingPath(store.root))) {
      throw new EvidenceStoreError("TASK_COLLISION", "a task is already bound to this store");
    }
    try {
      componentsUnderRoot(store.root, parsed.snapshot.copyRoot);
    } catch {
      throw new EvidenceStoreError(
        "SNAPSHOT_UNREGISTERED",
        "snapshot copy root must live inside the verifier-owned store root",
      );
    }
    const copy = validateSnapshotCopy(store, parsed.snapshot, io);
    if (!copy.valid) {
      throw new EvidenceStoreError(
        "SNAPSHOT_COPY_TAMPERED",
        `snapshot copy failed hash validation: ${copy.errors.join(", ")}`,
      );
    }

    const statement = redactText(parsed.statement).text;
    if (statement.length > store.limits.maxStatementChars) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "task statement exceeds the configured bound");
    }
    const criteria = parsed.criteria.map(redactCriterion);
    const claims = parsed.claims.map(redactClaim);

    const bound: BoundTask = {
      schemaVersion: EVIDENCE_STORE_SCHEMA_VERSION,
      taskId: parsed.taskId,
      taskRevision: parsed.taskRevision,
      candidateId: parsed.candidateId,
      scope: redactScope(parsed.scope),
      statement,
      criteria,
      claims,
      snapshot: parsed.snapshot,
      boundAt: new Date().toISOString(),
    };
    // Redaction must never produce an invalid binding.
    const check = BoundTaskSchema.safeParse(bound);
    if (!check.success) {
      throw invalidBinding("redacted task binding failed validation");
    }
    writeJsonExclusive(io, bindingPath(store.root), bound, "TASK_COLLISION");
    return bound;
  });
}

// ---------------------------------------------------------------------------
// Mutex (keyed by canonical store root, so two reopened handles serialise)
// ---------------------------------------------------------------------------

const storeLocks = new Map<string, Promise<void>>();

function lockKey(store: EvidenceStore): string {
  return storeRootKeys.get(store) ?? canonicalKey(store.root);
}

/**
 * Serialise mutating operations for a canonical store root **within this
 * process**. Keying by the store object (rather than its canonical root) used
 * to let two handles reopened for the same root race and lose metadata updates.
 * Cross-process concurrency is not claimed; the store root stays single-writer
 * by the stated trust assumption.
 */
async function withLock<T>(store: EvidenceStore, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(store);
  const previous = storeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const chained = previous.then(() => gate);
  storeLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (storeLocks.get(key) === chained) storeLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Output refs (resolve only inside the store)
// ---------------------------------------------------------------------------

function assertRefShape(ref: string): void {
  if (!ID_PATTERN.test(ref)) {
    throw new EvidenceStoreError("REF_ESCAPE", `output ref is not a safe opaque token: ${ref}`);
  }
}

function outputComponents(ref: string): string[] {
  assertRefShape(ref);
  return ["outputs", `${ref}.txt`];
}

function resolveOutputPath(store: EvidenceStore, ref: string, io: EvidenceStoreIo): string {
  return resolveComponents(store.root, outputComponents(ref), io, {
    missing: "UNKNOWN_REF",
    escape: "REF_ESCAPE",
  });
}

function writeOutput(store: EvidenceStore, ref: string, text: string, io: EvidenceStoreIo): void {
  const outputsDir = resolveComponents(store.root, ["outputs"], io, {
    missing: "STORE_TAMPERED",
    escape: "REF_ESCAPE",
    requireDir: true,
  });
  const file = join(outputsDir, `${ref}.txt`);
  let existing: EvidenceStoreStats | null = null;
  try {
    existing = io.lstat(file);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new EvidenceStoreError("REF_ESCAPE", `output ref path is not a regular file: ${ref}`);
    }
    const real = io.realpath(file);
    if (!isWithin(real, outputsDir)) {
      throw new EvidenceStoreError("REF_ESCAPE", `output ref escapes the store: ${ref}`);
    }
    return;
  }
  io.writeFileExclusive(file, text);
  const written = io.realpath(file);
  if (!isWithin(written, outputsDir)) {
    throw new EvidenceStoreError("REF_ESCAPE", `output ref escaped the store: ${ref}`);
  }
}

export async function readOutputRef(
  store: EvidenceStore,
  ref: string,
  expectedDigest?: string,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<OutputRefResolution> {
  const buffer = readBoundedFile(store.root, outputComponents(ref), store.limits.maxRefBytes, io, {
    missing: "UNKNOWN_REF",
    escape: "REF_ESCAPE",
  });
  const digest = sha256Hex(buffer);
  if (expectedDigest !== undefined && expectedDigest !== digest) {
    throw new EvidenceStoreError("REF_DIGEST_MISMATCH", `output ref digest mismatch: ${ref}`);
  }
  return { ref, digest, size: buffer.byteLength, text: buffer.toString("utf8") };
}

// ---------------------------------------------------------------------------
// Capture authority (module-private; never exported, never mintable externally)
// ---------------------------------------------------------------------------

const captureAuthorities = new WeakSet<object>();

function makeCaptureAuthority(): object {
  const authority: object = {};
  captureAuthorities.add(authority);
  return authority;
}

/** The single in-process authority reserved for a future verifier-owned runner. */
const RUNNER_AUTHORITY = makeCaptureAuthority();

function hasCaptureAuthority(value: unknown): boolean {
  return typeof value === "object" && value !== null && captureAuthorities.has(value);
}

// ---------------------------------------------------------------------------
// Append (public import path always downgrades)
// ---------------------------------------------------------------------------

interface RecordCore {
  [key: string]: unknown;
}

/**
 * Refuse to mutate a store whose persisted head disagrees with the committed
 * record set. A crash (or injected failure) between committing a record file
 * and replacing `store.json`'s head leaves a valid *orphan* record ahead of the
 * head. Appending again would fork the chain, so the store fails closed with
 * `STORE_INCONSISTENT` until the inconsistency is reconciled out-of-band. The
 * receipt is never silently dropped: the orphan stays on disk and `readAudit`
 * surfaces it as an explicit chain error.
 */
function assertChainMatchesRecords(
  store: EvidenceStore,
  metadata: StoreMetadata,
  io: EvidenceStoreIo,
): void {
  const recordsDir = resolveComponents(store.root, ["records"], io, {
    missing: "STORE_TAMPERED",
    escape: "STORE_TAMPERED",
    requireDir: true,
  });
  const onDisk = io.readdir(recordsDir).filter((name) => name.endsWith(".json")).length;
  if (onDisk !== metadata.chain.length) {
    throw new EvidenceStoreError(
      "STORE_INCONSISTENT",
      `persisted chain head (${metadata.chain.length}) disagrees with committed records (${onDisk}); refusing to append`,
    );
  }
}

async function appendCheckInternal(
  store: EvidenceStore,
  receipt: unknown,
  authority: object | null,
  io: EvidenceStoreIo,
  internalArtifact?: ArtifactRef,
): Promise<void> {
  const parsedResult = CheckReceiptSchema.safeParse(receipt);
  if (!parsedResult.success) {
    throw new EvidenceStoreError("RECEIPT_INVALID", "check receipt failed schema validation");
  }
  const parsed = parsedResult.data;

  await withLock(store, async () => {
    const metadata = readStoreMetadata(store.root, io);
    if (metadata.lifecycle === "CANCELLED") {
      throw new EvidenceStoreError(
        "TERMINAL_STATE",
        "this store's lifecycle is terminal (a check was cancelled); no further checks may be appended",
      );
    }
    // An interrupted head replacement leaves a committed orphan record; never
    // compound it by forking the chain.
    assertChainMatchesRecords(store, metadata, io);
    const binding = requireBinding(store.root, io, store.limits);

    if (
      parsed.taskId !== binding.taskId ||
      parsed.taskRevision !== binding.taskRevision ||
      parsed.candidateId !== binding.candidateId
    ) {
      throw new EvidenceStoreError(
        "IDENTITY_MISMATCH",
        "receipt identity does not match the bound task",
      );
    }
    if (parsed.snapshotRef && parsed.snapshotRef.candidateId !== binding.candidateId) {
      throw new EvidenceStoreError(
        "IDENTITY_MISMATCH",
        "receipt snapshot does not match the bound candidate",
      );
    }
    const knownCriteria = new Set(binding.criteria.map((criterion) => criterion.id));
    for (const ref of parsed.criterionIds) {
      if (!knownCriteria.has(ref)) {
        throw new EvidenceStoreError("UNKNOWN_CRITERION", `unknown criterion reference: ${ref}`);
      }
    }

    const recordFile = join(store.root, "records", `${parsed.checkId}.json`);
    if (io.exists(recordFile)) {
      throw new EvidenceStoreError("DUPLICATE_RECORD", `check id already recorded: ${parsed.checkId}`);
    }

    // Bounds are enforced *before* any redaction or persistence.
    if (parsed.argv && parsed.argv.length > store.limits.maxArgv) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "argv exceeds the configured bound");
    }
    if (parsed.argv) {
      for (const arg of parsed.argv) {
        if (arg.length > store.limits.maxArgLength) {
          throw new EvidenceStoreError("LIMIT_EXCEEDED", "argv element exceeds the configured bound");
        }
      }
    }
    if (parsed.environment && Object.keys(parsed.environment).length > store.limits.maxEnvKeys) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "environment exceeds the configured bound");
    }
    if (parsed.output !== undefined && parsed.output.length > store.limits.maxOutputInputChars) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "output exceeds the configured input bound");
    }
    if (parsed.outputRefs && parsed.outputRefs.length > store.limits.maxOutputRefs) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "too many output refs");
    }
    for (const ref of parsed.outputRefs ?? []) {
      resolveOutputPath(store, ref, io);
    }

    const redactions = new Set<string>();
    const redact = (value: string): string => {
      const result = redactText(value);
      for (const label of result.labels) redactions.add(label);
      return result.text;
    };

    const argvRedaction = redactArgv(parsed.argv ?? []);
    for (const label of argvRedaction.labels) redactions.add(label);
    const argv = argvRedaction.argv;
    const cwd = parsed.cwd !== undefined ? redact(parsed.cwd) : undefined;
    const runner = parsed.runner !== undefined ? redact(parsed.runner) : undefined;
    const source = parsed.source !== undefined ? redact(parsed.source) : undefined;
    const signal = parsed.signal !== undefined ? redact(parsed.signal) : undefined;
    const startedAt = parsed.startedAt !== undefined ? redact(parsed.startedAt) : undefined;
    const endedAt = parsed.endedAt !== undefined ? redact(parsed.endedAt) : undefined;
    const limitations = (parsed.limitations ?? []).map(redact);
    const environmentRedaction = redactEnvironment(parsed.environment ?? {});
    for (const label of environmentRedaction.labels) redactions.add(label);
    const environment = environmentRedaction.environment;

    let output: RecordOutput | null = null;
    if (parsed.output !== undefined) {
      const redacted = redactText(parsed.output);
      for (const label of redacted.labels) redactions.add(label);
      const bounded = boundText(redacted.text, store.limits.maxOutputChars);
      const digest = sha256Hex(bounded.text);
      const ref = `out-${digest.slice(0, 32)}`;
      writeOutput(store, ref, bounded.text, io);
      output = {
        ref,
        digest,
        size: Buffer.byteLength(bounded.text),
        truncated: bounded.truncated,
        redactions: [...redacted.labels],
        preview: bounded.text,
      };
    }

    // Capture authority is module-private; a public receipt can never set it.
    const captured =
      authority !== null &&
      hasCaptureAuthority(authority) &&
      parsed.kind === "ARTIFACT" &&
      internalArtifact !== undefined;

    if (metadata.chain.length >= store.limits.maxRecords) {
      throw new EvidenceStoreError("LIMIT_EXCEEDED", "record count exceeds the configured bound");
    }
    const terminal = parsed.completion === "CANCELLED";
    const previousHash = metadata.chain.head;
    const withoutHash: RecordCore = {
      schemaVersion: EVIDENCE_STORE_SCHEMA_VERSION,
      sequence: metadata.chain.length,
      checkId: parsed.checkId,
      taskId: parsed.taskId,
      taskRevision: parsed.taskRevision,
      candidateId: parsed.candidateId,
      criterionIds: [...parsed.criterionIds],
      kind: parsed.kind,
      claimedOrigin: parsed.origin,
      provenance: captured ? "CAPTURED" : "IMPORTED",
      completion: parsed.completion,
      result: parsed.result,
      discovery: parsed.discovery,
      exitCode: parsed.exitCode,
      signal,
      argv,
      cwd,
      startedAt,
      endedAt,
      runner,
      snapshotCandidateId: parsed.snapshotRef?.candidateId,
      artifact: internalArtifact,
      output,
      referencedOutputs: [...(parsed.outputRefs ?? [])],
      environment,
      source,
      limitations,
      redactions: [...redactions].sort(),
      terminal,
      terminalReason: terminal ? "CANCELLED" : undefined,
      recordedAt: new Date().toISOString(),
      previousHash,
    };
    const record = { ...withoutHash, hash: hashRecord(withoutHash) };
    const check = StoredRecordSchema.safeParse(record);
    if (!check.success) {
      throw new EvidenceStoreError("RECEIPT_INVALID", "redacted record failed validation");
    }
    writeJsonExclusive(io, recordFile, record, "DUPLICATE_RECORD");
    metadata.chain = { head: record.hash, length: metadata.chain.length + 1 };
    if (terminal) metadata.lifecycle = "CANCELLED";
    writeJsonReplace(io, join(store.root, "store.json"), metadata);
  });
}

/**
 * Import/append a check receipt. This is the public boundary: the receipt is
 * untrusted and is **always** stored with provenance `IMPORTED`, regardless of
 * any `origin` it claims. It can never certify execution.
 */
export async function appendCheck(
  store: EvidenceStore,
  receipt: CheckReceipt,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<void> {
  await appendCheckInternal(store, receipt, null, io);
}

/**
 * Collect a static artifact observation from the registered snapshot copy.
 *
 * This is verifier-owned capture: the store itself re-reads and re-hashes the
 * bytes, so it records provenance `CAPTURED` (kind `ARTIFACT`) via the private
 * authority. It attests byte-level presence/hash only. A path absent from the
 * registered snapshot is refused (no arbitrary reads); a declared-missing file
 * is recorded as `BLOCKED`, never as a synthetic `PASS`.
 */
export async function collectArtifactObservation(
  store: EvidenceStore,
  request: ArtifactObservationRequest,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<string> {
  const parsedResult = ArtifactObservationRequestSchema.safeParse(request);
  if (!parsedResult.success) {
    throw new EvidenceStoreError("RECEIPT_INVALID", "invalid artifact observation request");
  }
  const parsed = parsedResult.data;
  const binding = requireBinding(store.root, io, store.limits);

  const evaluation = evaluateArtifactPredicate(store, binding, parsed.criterionIds, parsed.path, io);
  if (evaluation.status === "UNKNOWN_CRITERION") {
    throw new EvidenceStoreError(
      "UNKNOWN_CRITERION",
      `unknown criterion reference: ${evaluation.criterionId}`,
    );
  }
  if (evaluation.status === "UNBOUND") {
    throw new EvidenceStoreError(
      "ARTIFACT_NOT_BOUND",
      `no byte-level artifact predicate is registered: ${evaluation.reason}`,
    );
  }
  if (evaluation.status === "MISMATCH") {
    throw new EvidenceStoreError("ARTIFACT_PREDICATE_MISMATCH", evaluation.reason);
  }
  if (evaluation.status === "UNREGISTERED") {
    throw new EvidenceStoreError(
      "SNAPSHOT_UNREGISTERED",
      `artifact path is not part of the registered snapshot: ${evaluation.path}`,
    );
  }
  if (evaluation.status === "TAMPERED") {
    throw new EvidenceStoreError("SNAPSHOT_COPY_TAMPERED", evaluation.reason);
  }

  const checkId =
    parsed.observationId ??
    `art-${sha256Hex(`${binding.candidateId}:${evaluation.artifact.path}`).slice(0, 24)}`;
  const receipt: CheckReceipt = {
    checkId,
    taskId: binding.taskId,
    taskRevision: binding.taskRevision,
    candidateId: binding.candidateId,
    criterionIds: [...parsed.criterionIds],
    kind: "ARTIFACT",
    origin: "RUNNER_CAPTURED",
    completion: evaluation.completion,
    result: evaluation.result,
    snapshotRef: { candidateId: binding.candidateId, baseRevision: binding.snapshot.base.revision },
    limitations: [
      "store-owned static artifact observation: attests the registered byte-level predicate (path/presence/hash) within the snapshot copy, not semantic satisfaction",
    ],
  };
  await appendCheckInternal(store, receipt, RUNNER_AUTHORITY, io, evaluation.artifact);
  return checkId;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read every committed record with bounded, link-safe reads and strict schema
 * validation. Takes the canonical root and resolved limits directly (rather than
 * a store handle) so the best-effort metadata recovery path can independently
 * re-derive a chain from raw records **without recursing** through
 * `readStoreMetadata`/`recoverInterruptedReplace`.
 */
function readStoredRecords(
  root: string,
  limits: ResolvedStoreLimits,
  io: EvidenceStoreIo,
): StoredRecord[] {
  const recordsDir = resolveComponents(root, ["records"], io, {
    missing: "STORE_TAMPERED",
    escape: "STORE_TAMPERED",
    requireDir: true,
  });
  const names = io.readdir(recordsDir).filter((name) => name.endsWith(".json"));
  // Reject an over-large record set *before* reading any of it into memory.
  if (names.length > limits.maxRecords) {
    throw new EvidenceStoreError("LIMIT_EXCEEDED", "record count exceeds the configured bound");
  }
  const records: StoredRecord[] = [];
  for (const name of names) {
    if (!ID_PATTERN.test(name.slice(0, -".json".length))) {
      throw new EvidenceStoreError("STORE_TAMPERED", `record name is not a safe id: ${name}`);
    }
    let buffer: Buffer;
    try {
      buffer = readBoundedFile(recordsDir, [name], limits.maxRecordBytes, io, {
        missing: "STORE_TAMPERED",
        escape: "STORE_TAMPERED",
      });
    } catch (error) {
      if (error instanceof EvidenceStoreError) throw error;
      throw new EvidenceStoreError("STORE_TAMPERED", `record is unreadable: ${name}`);
    }
    const parsed = parseJson(buffer.toString("utf8"));
    if (parsed === undefined) {
      throw new EvidenceStoreError("STORE_TAMPERED", `record is not valid JSON: ${name}`);
    }
    const result = StoredRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new EvidenceStoreError("STORE_TAMPERED", `record failed validation: ${name}`);
    }
    records.push(result.data);
  }
  records.sort((a, b) =>
    a.sequence !== b.sequence
      ? a.sequence - b.sequence
      : a.checkId < b.checkId
        ? -1
        : a.checkId > b.checkId
          ? 1
          : 0,
  );
  return records;
}

function verifyChain(records: StoredRecord[], metadata: StoreMetadata): string[] {
  const errors: string[] = [];
  let previous = GENESIS_HASH;
  let expectedSequence = 0;
  for (const record of records) {
    if (record.sequence !== expectedSequence) {
      errors.push(`SEQUENCE_GAP:${record.checkId}`);
    }
    if (record.previousHash !== previous) {
      errors.push(`PREV_HASH_MISMATCH:${record.checkId}`);
    }
    const { hash, ...withoutHash } = record;
    if (hashRecord(withoutHash) !== hash) {
      errors.push(`HASH_MISMATCH:${record.checkId}`);
    }
    previous = record.hash;
    expectedSequence = record.sequence + 1;
  }
  if (records.length > metadata.chain.length) {
    // A committed record ahead of the persisted head is an orphan from an
    // interrupted head replacement. Report it explicitly rather than dropping
    // the receipt or silently accepting a forked chain.
    for (const record of records.slice(metadata.chain.length)) {
      errors.push(`ORPHAN_RECORD:${record.checkId}`);
    }
  } else if (records.length < metadata.chain.length) {
    errors.push("RECORDS_MISSING");
  }
  if (records.length !== metadata.chain.length) {
    errors.push("CHAIN_LENGTH_MISMATCH");
  }
  const expectedHead = records.length === 0 ? GENESIS_HASH : records[records.length - 1]!.hash;
  if (expectedHead !== metadata.chain.head) {
    errors.push("CHAIN_HEAD_MISMATCH");
  }
  return errors;
}

export async function readAudit(
  store: EvidenceStore,
  io: EvidenceStoreIo = nodeEvidenceStoreIo,
): Promise<AuditRecords> {
  return withLock(store, async () => {
    const metadata = readStoreMetadata(store.root, io);
    const task = readBinding(store.root, io, store.limits);
    const stored = readStoredRecords(store.root, store.limits, io);
    const chainErrors = verifyChain(stored, metadata);
    const chainValid = chainErrors.length === 0;

    let copyValid = false;
    const copyErrors: string[] = [];
    if (task) {
      try {
        componentsUnderRoot(store.root, task.snapshot.copyRoot);
        const copy = validateSnapshotCopy(store, task.snapshot, io);
        copyValid = copy.valid;
        copyErrors.push(...copy.errors);
      } catch {
        copyErrors.push("SNAPSHOT_COPY_OUTSIDE_STORE");
      }
    }

    const records: StoredRecordView[] = stored.map((record) => {
      const trustReasons: string[] = [];
      let trusted = false;
      if (record.provenance === "CAPTURED") {
        if (record.kind === "EXECUTION") {
          trustReasons.push("CAPTURED_EXECUTION_UNSUPPORTED");
        } else if (record.artifact && copyValid) {
          trusted = revalidateArtifactCapture(store, task, record, io);
          if (!trusted) trustReasons.push("TRUST_UNRECONSTRUCTED");
        } else {
          trustReasons.push("TRUST_UNRECONSTRUCTED");
        }
      }
      const effectiveOrigin: EvidenceOrigin = trusted
        ? "RUNNER_CAPTURED"
        : record.claimedOrigin === "MODEL_ASSERTED"
          ? "MODEL_ASSERTED"
          : "IMPORTED";
      return { ...record, trusted, effectiveOrigin, trustReasons };
    });

    return {
      schemaVersion: metadata.schemaVersion,
      policyVersion: metadata.policyVersion,
      storeId: metadata.storeId,
      session: {
        createdInSession: store.createdInSession,
        reconstruction: store.createdInSession ? "created" : "reopened",
      },
      lifecycle: metadata.lifecycle,
      task,
      records,
      integrity: {
        chainValid,
        chainLength: metadata.chain.length,
        chainHead: metadata.chain.head,
        copyValid,
        errors: [...chainErrors, ...copyErrors],
        limitations: [],
      },
      limitations: [STORE_TRUST_ASSUMPTION],
      errors: [],
    };
  });
}
