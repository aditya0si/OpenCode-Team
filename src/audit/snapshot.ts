/**
 * Task 2 — immutable, bounded candidate snapshots and freshness.
 *
 * `captureSnapshot` observes a real Git working tree (including staged,
 * unstaged, untracked and deleted paths), copies the exact bytes of the scoped
 * candidate deltas into a verifier-owned location, and returns a validated
 * manifest. `checkFreshness` re-observes the same scope and reports whether the
 * observed content and base revision still match the manifest.
 *
 * Safety posture (honest limits):
 *   - the source tree is only *read*: no reset/clean/stash/commit is ever run,
 *     and the index is protected from optional-lock writes (`GIT_OPTIONAL_LOCKS=0`);
 *   - only trusted `git` metadata plumbing is executed, via argv arrays with a
 *     hard timeout and output cap; candidate commands are never executed;
 *   - secret-bearing, dependency/generated and verifier-storage paths are denied
 *     by policy and recorded as explicit exclusions. A caller/candidate scope
 *     can only narrow the capture; it can never widen policy;
 *   - absolute, traversal and control-character paths are rejected. Every
 *     component of a selected path is `lstat`-checked and *any* symlink or
 *     junction (even one that resolves inside the root) is rejected before a
 *     byte is read, so an innocuously named in-root alias cannot smuggle a
 *     secret's bytes past the name-based policy;
 *   - unsafe paths reported by `git` fail the capture (`PATH_UNSAFE`) rather than
 *     being silently skipped, so a relevant path is never quietly omitted;
 *   - the output location is canonically resolved via its nearest existing
 *     ancestor, and every component created below that anchor is made with an
 *     exclusive `mkdir` followed by a before/after component re-check, so a
 *     preexisting file/link is refused and a symlink/junction swapped into the
 *     output tail (including one inserted under the copy root before a file is
 *     written) is rejected rather than followed. This is a best-effort,
 *     non-atomic guard that assumes a **trusted, verifier-owned output parent**;
 *     it is not sandbox-grade containment and cannot defend against a concurrent
 *     hostile filesystem that races the checks;
 *   - resource limits are enforced against hard ceilings *and* incrementally,
 *     before each file is read/retained, so an oversized selection fails without
 *     first buffering it;
 *   - a file that changes during read, a repository whose status or `HEAD`
 *     changes mid-capture, or an already-selected file whose bytes change after
 *     it was read, all fail the capture instead of publishing a mixed snapshot;
 *   - `candidateId` is a deterministic SHA-256 over the observed scoped content
 *     plus base revision, task identity, scope and policy version — not a bare
 *     commit SHA — so dirty edits are part of the identity.
 *
 * The manifest is an integrity/identity record, not an authenticated
 * attestation: it is self-consistent (`candidateId` recomputes from its own
 * fields) but unsigned, so a caller that can rewrite every field can forge a
 * fresh-looking manifest. Binding manifests to a trusted store is a later task.
 *
 * Capture is a *delta* scope: it records only the paths Git reports as changed
 * (plus selected untracked paths). It never observes unchanged tracked bytes and
 * is not an atomic filesystem transaction. The revalidation pass re-checks every
 * path component before and after each re-read, but narrows rather than
 * mathematically eliminates the window between the last read and the final
 * publish; the portable filesystem API establishes no cross-file atomicity and
 * exposes no `O_NOFOLLOW`/`openat` equivalent, so no sandbox-grade follow
 * guarantee is offered. Output must live under a trusted, verifier-owned parent;
 * a caller-supplied, candidate-controlled output parent is explicitly unsupported.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ID_PATTERN, LIMITS } from "./contracts.js";

/**
 * Bumped whenever the manifest shape changes incompatibly.
 *
 * v2 (round-1 repair): the scope carries an explicit `delta: true` marker, so a
 * consumer can never read a snapshot as a whole-tree observation.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/**
 * Version of the exclusion/selection policy encoded below.
 *
 * v2 (round-1 repair): component-level symlink/junction rejection and fail-closed
 * handling of unsafe Git paths.
 *
 * v3 (round-2 repair): every existing output ancestor is re-checked for
 * symlink/junction redirection immediately before and after each directory
 * creation and each file write, and the publish-time source re-read re-checks
 * every path component rather than only the final file.
 */
export const POLICY_VERSION = 3;

export const DEFAULT_SNAPSHOT_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
} as const;

/**
 * Hard ceilings a caller may not raise `limits` beyond. A manifest that declares
 * limits above these is rejected on import, so an untrusted manifest cannot
 * claim an unbounded capture.
 */
export const HARD_SNAPSHOT_LIMITS = {
  maxFiles: 100_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
} as const;

const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BYTES = 8 * 1024 * 1024;

export type SnapshotErrorCode =
  | "INVALID_OPTIONS"
  | "INVALID_PATH"
  | "ABSOLUTE_PATH"
  | "CONTROL_CHARACTER"
  | "PATH_TRAVERSAL"
  | "PATH_UNSAFE"
  | "OUTPUT_OVERLAP"
  | "OUTPUT_EXISTS"
  | "OUTPUT_COLLISION"
  | "SOURCE_NOT_FOUND"
  | "NOT_A_REPOSITORY"
  | "SYMLINK_ESCAPE"
  | "RACE_DETECTED"
  | "LIMIT_EXCEEDED"
  | "GIT_FAILED"
  | "MANIFEST_INVALID"
  | "MANIFEST_TAMPERED";

/** A single, reportable validation problem in imported input. */
export interface SnapshotValidationIssue {
  path: string;
  code: string;
  message: string;
}

export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

export class SnapshotValidationError extends Error {
  readonly issues: SnapshotValidationIssue[];

  constructor(issues: SnapshotValidationIssue[]) {
    super(`snapshot input failed validation (${issues.length} issue(s))`);
    this.name = "SnapshotValidationError";
    this.issues = issues;
  }
}

const IdSchema = z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN, {
  message: "id must match [A-Za-z0-9][A-Za-z0-9._:-]*",
});

const PathStringSchema = z.string().min(1).max(LIMITS.maxPathLength);

export const SnapshotLimitsOptionsSchema = z
  .object({
    maxFiles: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxFiles).optional(),
    maxFileBytes: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxFileBytes).optional(),
    maxTotalBytes: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxTotalBytes).optional(),
  })
  .strict();

export const SnapshotScopeOptionsSchema = z
  .object({
    paths: z.array(PathStringSchema).max(LIMITS.maxPaths).optional(),
    exclusions: z.array(PathStringSchema).max(LIMITS.maxPaths).optional(),
  })
  .strict();

export const SnapshotOptionsSchema = z
  .object({
    taskId: IdSchema,
    taskRevision: IdSchema,
    sourceRoot: z.string().min(1).max(LIMITS.maxPathLength),
    outputRoot: z.string().min(1).max(LIMITS.maxPathLength),
    scope: SnapshotScopeOptionsSchema.optional(),
    limits: SnapshotLimitsOptionsSchema.optional(),
  })
  .strict();

export type SnapshotOptions = z.infer<typeof SnapshotOptionsSchema>;

export const SnapshotFileStatusSchema = z.enum(["added", "modified", "deleted", "untracked"]);

export const SnapshotFileSchema = z
  .object({
    path: PathStringSchema,
    status: SnapshotFileStatusSchema,
    staged: z.boolean(),
    unstaged: z.boolean(),
    hash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    size: z.number().int().min(0).nullable(),
  })
  .strict();

export const ExclusionReasonSchema = z.enum([
  "POLICY_DIRECTORY",
  "SECRET",
  "VERIFIER_STORAGE",
  "SCOPE",
  "OVERSIZED",
]);

export const ExclusionRecordSchema = z
  .object({
    path: PathStringSchema,
    reason: ExclusionReasonSchema,
    detail: z.string().min(1).max(256).optional(),
    size: z.number().int().min(0).optional(),
  })
  .strict();

export const SnapshotScopeSchema = z
  .object({
    paths: z.array(PathStringSchema).max(LIMITS.maxPaths),
    exclusions: z.array(PathStringSchema).max(LIMITS.maxPaths),
    partial: z.boolean(),
    /** Always true: a capture observes Git-reported deltas, never whole tree. */
    delta: z.literal(true),
  })
  .strict();

export const SnapshotBaseSchema = z
  .object({
    revision: z.string().regex(/^[0-9a-f]{7,64}$/).nullable(),
  })
  .strict();

export const SnapshotLimitsSchema = z
  .object({
    maxFiles: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxFiles),
    maxFileBytes: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxFileBytes),
    maxTotalBytes: z.number().int().min(1).max(HARD_SNAPSHOT_LIMITS.maxTotalBytes),
  })
  .strict();

export const SnapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    base: SnapshotBaseSchema,
    scope: SnapshotScopeSchema,
    sourceRoot: z.string().min(1).max(LIMITS.maxPathLength),
    outputRoot: z.string().min(1).max(LIMITS.maxPathLength),
    copyRoot: z.string().min(1).max(LIMITS.maxPathLength),
    files: z.array(SnapshotFileSchema).max(1_000_000),
    exclusions: z.array(ExclusionRecordSchema).max(1_000_000),
    limits: SnapshotLimitsSchema,
    policyVersion: z.number().int().min(1),
  })
  .strict();

export type SnapshotFileStatus = z.infer<typeof SnapshotFileStatusSchema>;
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;
export type ExclusionReason = z.infer<typeof ExclusionReasonSchema>;
export type ExclusionRecord = z.infer<typeof ExclusionRecordSchema>;
export type SnapshotScope = z.infer<typeof SnapshotScopeSchema>;
export type SnapshotBase = z.infer<typeof SnapshotBaseSchema>;
export type SnapshotLimits = z.infer<typeof SnapshotLimitsSchema>;
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export interface FreshnessResult {
  manifestVersion: number;
  fresh: boolean;
  candidateId: string;
  currentCandidateId: string | null;
  base: { matches: boolean; expected: string | null; actual: string | null };
  changed: string[];
  added: string[];
  deleted: string[];
  scope: SnapshotScope;
  /**
   * Always `false`: a capture observes only Git-reported deltas for the declared
   * scope, so it never includes excluded paths or unchanged tracked bytes. Use
   * `scope.delta`, `scope.partial` and `exclusions` to reason about coverage.
   */
  scopeComplete: boolean;
  exclusions: ExclusionRecord[];
  reasons: string[];
  errors: string[];
}

/** Minimal filesystem seam so reads can be exercised deterministically. */
export interface SnapshotStats {
  size: number;
  mtimeMs: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SnapshotIo {
  exists(path: string): boolean;
  realpath(path: string): string;
  lstat(path: string): SnapshotStats;
  stat(path: string): SnapshotStats;
  readFile(path: string): Buffer;
  mkdirp(path: string): void;
  /** Exclusive directory creation; throws with `.code === "EEXIST"` if present. */
  mkdirExclusive(path: string): void;
  /**
   * Exclusive file creation (`wx`); throws with `.code === "EEXIST"` rather than
   * overwriting or following a preexisting file/symlink.
   */
  writeFileExclusive(path: string, data: Buffer | string): void;
  /** Trusted Git metadata call; returns stdout and throws on failure. */
  git(cwd: string, args: string[]): string;
}

export const nodeSnapshotIo: SnapshotIo = {
  exists: (path) => existsSync(path),
  realpath: (path) => realpathSync(path),
  lstat: (path) => lstatSync(path),
  stat: (path) => statSync(path),
  readFile: (path) => readFileSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  mkdirExclusive: (path) => {
    mkdirSync(path);
  },
  writeFileExclusive: (path, data) => {
    writeFileSync(path, data, { flag: "wx" });
  },
  git: (cwd, args) => realGitStdout(cwd, args),
};

// ---------------------------------------------------------------------------
// Exclusion policy (candidate scope can narrow, never widen)
// ---------------------------------------------------------------------------

const VERIFIER_DIRECTORIES = new Set([
  "audit-build",
  "audit-evidence",
  ".audit",
  ".audit-build",
  ".teamwork-audit",
]);

const SECRET_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".docker"]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "output",
  "target",
  "obj",
  "bin",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
]);

function secretFileReason(relPath: string): string | null {
  const lower = relPath.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (base === ".env" || base.startsWith(".env.")) return ".env";
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base)) return "private-key";
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return "ssh-private-key";
  if (base === ".npmrc" || base === ".netrc" || base === ".git-credentials" || base === ".htpasswd") {
    return "auth-file";
  }
  if (
    base === "credentials" ||
    base === "credentials.json" ||
    base === "secrets.json" ||
    base === "secrets.yaml" ||
    base === "secrets.yml"
  ) {
    return "credentials";
  }
  if (/^service-account.*\.json$/.test(base)) return "service-account";
  return null;
}

/** Returns the policy exclusion for a repo-relative path, if any. */
function policyExclusion(relPath: string): { reason: ExclusionReason; detail: string } | null {
  const segments = relPath.split("/");
  for (const segment of segments) {
    const key = process.platform === "win32" ? segment.toLowerCase() : segment;
    if (VERIFIER_DIRECTORIES.has(key)) return { reason: "VERIFIER_STORAGE", detail: key };
    if (SECRET_DIRECTORIES.has(key)) return { reason: "SECRET", detail: key };
    if (EXCLUDED_DIRECTORIES.has(key)) return { reason: "POLICY_DIRECTORY", detail: key };
  }
  const secret = secretFileReason(relPath);
  if (secret) return { reason: "SECRET", detail: secret };
  return null;
}

// ---------------------------------------------------------------------------
// Path helpers
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

/** True when an `fs`-style error is an `EEXIST` collision. */
function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

/** `lstat`-based existence, so a broken symlink/junction counts as present. */
function pathEntryExists(path: string, io: SnapshotIo): boolean {
  try {
    io.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a prospective path into its deepest existing ancestor (`anchor`,
 * `realpath`-resolved so no symlink remains in it) and the ordered tail of
 * component names that do not exist yet. Used to canonicalize a path that does
 * not exist without following a parent symlink/junction.
 */
function splitProspectivePath(
  path: string,
  io: SnapshotIo,
): { anchor: string; tail: string[] } {
  let current = resolve(path);
  const tail: string[] = [];
  while (!io.exists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  let anchor: string;
  try {
    anchor = io.realpath(current);
  } catch {
    anchor = current;
  }
  return { anchor, tail };
}

/**
 * Split `to` into components relative to `from`; throws `OUTPUT_COLLISION` when
 * `to` is not lexically nested under `from`.
 */
function relativeComponents(from: string, to: string): string[] {
  const rel = relative(from, to);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new SnapshotError(
      "OUTPUT_COLLISION",
      `output path escapes its reserved root: ${to}`,
    );
  }
  return rel.split(/[\\/]/).filter((segment) => segment !== "");
}

/**
 * Re-check every existing component of `target` from a trusted canonical
 * `anchor` down, refusing any symlink/junction/non-directory and any component
 * whose canonical location has drifted outside `anchor`. Called immediately
 * before and after output directories are created and before each file write so
 * a link swapped into the output tail is rejected, not followed.
 */
function assertNoOutputLinks(target: string, anchor: string, io: SnapshotIo): void {
  let anchorStats: SnapshotStats;
  try {
    anchorStats = io.lstat(anchor);
  } catch {
    throw new SnapshotError("OUTPUT_COLLISION", `output anchor disappeared: ${anchor}`);
  }
  if (anchorStats.isSymbolicLink() || !anchorStats.isDirectory()) {
    throw new SnapshotError("OUTPUT_COLLISION", `output anchor is not a real directory: ${anchor}`);
  }
  let current = anchor;
  for (const segment of relativeComponents(anchor, target)) {
    current = join(current, segment);
    if (!pathEntryExists(current, io)) break;
    const stats = io.lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SnapshotError(
        "OUTPUT_COLLISION",
        `output path traverses a symlink or is not a directory: ${current}`,
      );
    }
    let real: string;
    try {
      real = io.realpath(current);
    } catch {
      throw new SnapshotError("OUTPUT_COLLISION", `output path cannot be resolved: ${current}`);
    }
    if (canonicalKey(real) !== canonicalKey(current) || !isWithin(real, anchor)) {
      throw new SnapshotError(
        "OUTPUT_COLLISION",
        `output path is redirected outside its reserved root: ${current}`,
      );
    }
  }
}

/**
 * Create `absolute` and every missing parent down from the trusted canonical
 * `anchor` as real directories, one component at a time. Each missing component
 * is created with an exclusive `mkdir` (so a preexisting entry, including a
 * link, is refused) and then re-validated as a real directory whose canonical
 * location is still inside `anchor`; the existing prefix is re-checked for links
 * immediately before each creation.
 */
function createDirectoriesExclusive(absolute: string, anchor: string, io: SnapshotIo): void {
  let current = anchor;
  for (const segment of relativeComponents(anchor, absolute)) {
    current = join(current, segment);
    if (pathEntryExists(current, io)) {
      const existing = io.lstat(current);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new SnapshotError(
          "OUTPUT_COLLISION",
          `output path already exists and is not a real directory: ${current}`,
        );
      }
      continue;
    }
    // A junction can be swapped into an already-created ancestor between
    // iterations; re-check the existing prefix before creating the next one.
    assertNoOutputLinks(dirname(current), anchor, io);
    try {
      io.mkdirExclusive(current);
    } catch (error) {
      if (isEexist(error)) {
        throw new SnapshotError(
          "OUTPUT_COLLISION",
          `output path was created concurrently: ${current}`,
        );
      }
      throw error;
    }
    const created = io.lstat(current);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new SnapshotError("OUTPUT_COLLISION", `output path is not a real directory: ${current}`);
    }
    let real: string;
    try {
      real = io.realpath(current);
    } catch {
      throw new SnapshotError("OUTPUT_COLLISION", `output path cannot be resolved: ${current}`);
    }
    if (canonicalKey(real) !== canonicalKey(current) || !isWithin(real, anchor)) {
      throw new SnapshotError(
        "OUTPUT_COLLISION",
        `output path was redirected outside its reserved root: ${current}`,
      );
    }
  }
}

/** Validates and normalizes a repo-relative path; throws a coded error. */
export function normalizeRelPath(raw: string): string {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new SnapshotError("CONTROL_CHARACTER", "path contains control characters");
  }
  const replaced = raw.replace(/\\/g, "/");
  if (replaced.startsWith("/") || replaced.startsWith("//") || /^[A-Za-z]:/.test(replaced)) {
    throw new SnapshotError("ABSOLUTE_PATH", `absolute paths are not allowed: ${raw}`);
  }
  const parts: string[] = [];
  for (const part of replaced.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new SnapshotError("PATH_TRAVERSAL", `path traversal is not allowed: ${raw}`);
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    throw new SnapshotError("INVALID_PATH", `path is empty after normalization: ${raw}`);
  }
  return parts.join("/");
}

function normalizeList(paths: string[] | undefined, kind: string): string[] {
  if (!paths) return [];
  const normalized = paths.map((path) => normalizeRelPath(path));
  const seen = new Set<string>();
  for (const path of normalized) {
    const key = canonicalKey(path);
    if (seen.has(key)) {
      throw new SnapshotError("INVALID_OPTIONS", `duplicate ${kind} path: ${path}`);
    }
    seen.add(key);
  }
  return normalized.sort((a, b) => (canonicalKey(a) < canonicalKey(b) ? -1 : 1));
}

function matchesAny(relPath: string, list: string[]): boolean {
  const key = canonicalKey(relPath);
  return list.some((entry) => {
    const entryKey = canonicalKey(entry);
    return key === entryKey || key.startsWith(`${entryKey}/`);
  });
}

// ---------------------------------------------------------------------------
// Git metadata capture (trusted plumbing, bounded)
// ---------------------------------------------------------------------------

interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function runGit(cwd: string, args: string[]): GitResult {
  return spawnSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BYTES,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
      },
    },
  );
}

function realGitStdout(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.error || result.status !== 0) {
    throw new SnapshotError(
      "GIT_FAILED",
      `git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

interface GitStatusEntry {
  path: string;
  status: SnapshotFileStatus;
  staged: boolean;
  unstaged: boolean;
}

function parseStatus(raw: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const chunk of raw.split("\0")) {
    if (chunk.length < 4) continue;
    const x = chunk.charAt(0);
    const y = chunk.charAt(1);
    const path = chunk.slice(3);
    let status: SnapshotFileStatus;
    if (x === "?" && y === "?") status = "untracked";
    else if (x === "D" || y === "D") status = "deleted";
    else if (x === "A") status = "added";
    else status = "modified";
    entries.push({
      path,
      status,
      staged: x !== " " && x !== "?",
      unstaged: y !== " " && y !== "?",
    });
  }
  return entries;
}

function readStatus(cwd: string, io: SnapshotIo): string {
  return io.git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
}

function readHead(cwd: string, io: SnapshotIo): string | null {
  let stdout: string;
  try {
    stdout = io.git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return null;
  }
  const revision = stdout.trim();
  return revision.length > 0 ? revision : null;
}

// ---------------------------------------------------------------------------
// Candidate identity
// ---------------------------------------------------------------------------

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function computeCandidateId(
  taskId: string,
  taskRevision: string,
  baseRevision: string | null,
  scope: SnapshotScope,
  files: SnapshotFile[],
): string {
  const payload = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    policyVersion: POLICY_VERSION,
    taskId,
    taskRevision,
    baseRevision,
    scope: {
      paths: [...scope.paths].sort((a, b) => (canonicalKey(a) < canonicalKey(b) ? -1 : 1)),
      exclusions: [...scope.exclusions].sort((a, b) => (canonicalKey(a) < canonicalKey(b) ? -1 : 1)),
      partial: scope.partial,
      delta: scope.delta,
    },
    files: [...files]
      .sort((a, b) => (canonicalKey(a.path) < canonicalKey(b.path) ? -1 : 1))
      .map((file) => [file.path, file.status, file.staged, file.unstaged, file.hash, file.size]),
  };
  return `sha256:${sha256(JSON.stringify(payload))}`;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

interface Observation {
  base: SnapshotBase;
  scope: SnapshotScope;
  files: SnapshotFile[];
  exclusions: ExclusionRecord[];
  contents: Map<string, Buffer>;
  limits: SnapshotLimits;
}

function resolveSourceRoot(sourceRoot: string, io: SnapshotIo): string {
  const absolute = resolve(sourceRoot);
  if (!io.exists(absolute)) {
    throw new SnapshotError("SOURCE_NOT_FOUND", `source root does not exist: ${sourceRoot}`);
  }
  let real: string;
  try {
    real = io.realpath(absolute);
  } catch {
    throw new SnapshotError("SOURCE_NOT_FOUND", `source root cannot be resolved: ${sourceRoot}`);
  }
  if (!io.stat(real).isDirectory()) {
    throw new SnapshotError("SOURCE_NOT_FOUND", `source root is not a directory: ${sourceRoot}`);
  }
  return real;
}

/**
 * `lstat` every component of `rel` under `sourceRoot` and reject any symlink or
 * junction — even one whose target stays inside the root. Returns the `lstat` of
 * the final component so the caller can inspect the file itself.
 */
function lstatComponents(sourceRoot: string, rel: string, io: SnapshotIo): SnapshotStats {
  let current = sourceRoot;
  let stats: SnapshotStats | null = null;
  for (const segment of rel.split("/")) {
    current = join(current, segment);
    try {
      stats = io.lstat(current);
    } catch {
      throw new SnapshotError("RACE_DETECTED", `path component disappeared during capture: ${rel}`);
    }
    if (stats.isSymbolicLink()) {
      throw new SnapshotError("SYMLINK_ESCAPE", `path traverses a symlink or junction: ${rel}`);
    }
  }
  return stats as SnapshotStats;
}

function observe(
  sourceRoot: string,
  scopePaths: string[],
  scopeExclusions: string[],
  limits: SnapshotLimits,
  io: SnapshotIo,
): Observation {
  let topLevel: string;
  try {
    topLevel = io.git(sourceRoot, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new SnapshotError("NOT_A_REPOSITORY", `source root is not a Git repository: ${sourceRoot}`);
  }
  if (canonicalKey(topLevel) !== canonicalKey(sourceRoot)) {
    throw new SnapshotError("NOT_A_REPOSITORY", `source root is not a Git repository root: ${sourceRoot}`);
  }

  const baseRevision = readHead(sourceRoot, io);
  const statusBefore = readStatus(sourceRoot, io);
  const entries = parseStatus(statusBefore);
  const scope: SnapshotScope = {
    paths: scopePaths,
    exclusions: scopeExclusions,
    partial: scopePaths.length > 0 || scopeExclusions.length > 0,
    delta: true,
  };

  const files: SnapshotFile[] = [];
  const exclusions: ExclusionRecord[] = [];
  const contents = new Map<string, Buffer>();
  let totalBytes = 0;

  const ordered = [...entries].sort((a, b) =>
    canonicalKey(a.path) < canonicalKey(b.path) ? -1 : 1,
  );

  for (const entry of ordered) {
    let rel: string;
    try {
      rel = normalizeRelPath(entry.path);
    } catch {
      // A path Git reports that we cannot safely handle fails the capture
      // rather than being silently omitted from the snapshot.
      throw new SnapshotError(
        "PATH_UNSAFE",
        `unsafe path reported by git status: ${JSON.stringify(entry.path)}`,
      );
    }
    if (scopePaths.length > 0 && !matchesAny(rel, scopePaths)) continue;

    const policy = policyExclusion(rel);
    if (policy) {
      exclusions.push({ path: rel, reason: policy.reason, detail: policy.detail });
      continue;
    }
    if (matchesAny(rel, scopeExclusions)) {
      exclusions.push({ path: rel, reason: "SCOPE" });
      continue;
    }

    // Enforce the file-count bound before retaining this entry.
    if (files.length + 1 > limits.maxFiles) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        `selected files exceed maxFiles (${limits.maxFiles})`,
      );
    }

    if (entry.status === "deleted") {
      files.push({
        path: rel,
        status: "deleted",
        staged: entry.staged,
        unstaged: entry.unstaged,
        hash: null,
        size: null,
      });
      continue;
    }

    const absolute = join(sourceRoot, ...rel.split("/"));
    const before = lstatComponents(sourceRoot, rel, io);
    if (!before.isFile()) continue;

    let real: string;
    try {
      real = io.realpath(absolute);
    } catch {
      throw new SnapshotError("PATH_UNSAFE", `path cannot be resolved safely: ${rel}`);
    }
    if (!isWithin(real, sourceRoot)) {
      throw new SnapshotError("SYMLINK_ESCAPE", `path escapes the source root: ${rel}`);
    }

    if (before.size > limits.maxFileBytes) {
      exclusions.push({ path: rel, reason: "OVERSIZED", size: before.size });
      continue;
    }
    // Enforce the byte bound before reading/retaining this file.
    if (totalBytes + before.size > limits.maxTotalBytes) {
      throw new SnapshotError(
        "LIMIT_EXCEEDED",
        `selected bytes exceed maxTotalBytes (${limits.maxTotalBytes})`,
      );
    }

    const buffer = io.readFile(absolute);
    const after = io.lstat(absolute);
    if (
      after.isSymbolicLink() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      buffer.byteLength !== before.size
    ) {
      throw new SnapshotError("RACE_DETECTED", `file changed during read: ${rel}`);
    }

    totalBytes += buffer.byteLength;
    files.push({
      path: rel,
      status: entry.status,
      staged: entry.staged,
      unstaged: entry.unstaged,
      hash: sha256(buffer),
      size: buffer.byteLength,
    });
    contents.set(rel, buffer);
  }

  // Publish-time revalidation: every already-selected file's bytes must still
  // match what was read, and the repository status/HEAD must be unchanged. The
  // re-read re-checks *every* path component (not only the final file), so a
  // parent directory swapped for a junction between the read and the re-read is
  // rejected instead of silently resolving to a same-named file elsewhere.
  for (const [rel, expected] of contents) {
    const absolute = join(sourceRoot, ...rel.split("/"));
    let check: SnapshotStats;
    try {
      check = lstatComponents(sourceRoot, rel, io);
    } catch {
      throw new SnapshotError("RACE_DETECTED", `selected path changed before publish: ${rel}`);
    }
    if (check.isSymbolicLink() || !check.isFile()) {
      throw new SnapshotError("RACE_DETECTED", `selected file changed type before publish: ${rel}`);
    }
    let real: string;
    try {
      real = io.realpath(absolute);
    } catch {
      throw new SnapshotError("RACE_DETECTED", `selected file cannot be resolved before publish: ${rel}`);
    }
    if (!isWithin(real, sourceRoot)) {
      throw new SnapshotError(
        "RACE_DETECTED",
        `selected file escaped the source root before publish: ${rel}`,
      );
    }
    const again = io.readFile(absolute);
    if (!again.equals(expected)) {
      throw new SnapshotError("RACE_DETECTED", `selected file changed after read: ${rel}`);
    }
    let afterCheck: SnapshotStats;
    try {
      afterCheck = lstatComponents(sourceRoot, rel, io);
    } catch {
      throw new SnapshotError("RACE_DETECTED", `selected path changed after re-read: ${rel}`);
    }
    if (
      afterCheck.isSymbolicLink() ||
      afterCheck.size !== check.size ||
      afterCheck.mtimeMs !== check.mtimeMs ||
      afterCheck.ino !== check.ino
    ) {
      throw new SnapshotError("RACE_DETECTED", `selected file changed after read: ${rel}`);
    }
  }

  const statusAfter = readStatus(sourceRoot, io);
  if (statusAfter !== statusBefore) {
    throw new SnapshotError("RACE_DETECTED", "repository state changed during capture");
  }
  const headAfter = readHead(sourceRoot, io);
  if (headAfter !== baseRevision) {
    throw new SnapshotError("RACE_DETECTED", "repository HEAD changed during capture");
  }

  files.sort((a, b) => (canonicalKey(a.path) < canonicalKey(b.path) ? -1 : 1));
  exclusions.sort((a, b) => (canonicalKey(a.path) < canonicalKey(b.path) ? -1 : 1));

  return {
    base: { revision: baseRevision },
    scope,
    files,
    exclusions,
    contents,
    limits,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parseOptions(value: unknown): {
  taskId: string;
  taskRevision: string;
  sourceRoot: string;
  outputRoot: string;
  scopePaths: string[];
  scopeExclusions: string[];
  limits: SnapshotLimits;
} {
  const result = SnapshotOptionsSchema.safeParse(value);
  if (!result.success) {
    throw new SnapshotValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  const parsed = result.data;
  return {
    taskId: parsed.taskId,
    taskRevision: parsed.taskRevision,
    sourceRoot: parsed.sourceRoot,
    outputRoot: parsed.outputRoot,
    scopePaths: normalizeList(parsed.scope?.paths, "scope"),
    scopeExclusions: normalizeList(parsed.scope?.exclusions, "exclusion"),
    limits: { ...DEFAULT_SNAPSHOT_LIMITS, ...(parsed.limits ?? {}) },
  };
}

function resolveOutputRoot(
  outputRoot: string,
  sourceRoot: string,
  io: SnapshotIo,
): { canonical: string; anchor: string } {
  const absolute = resolve(outputRoot);
  // Canonicalize through the nearest existing ancestor so a parent
  // symlink/junction cannot redirect an external-looking path inside the source.
  const { anchor, tail } = splitProspectivePath(absolute, io);
  const canonical = tail.length > 0 ? join(anchor, ...tail) : anchor;
  const sourceKey = canonicalKey(sourceRoot);
  for (const candidate of [absolute, canonical]) {
    const key = canonicalKey(candidate);
    if (key === sourceKey || isWithin(key, sourceKey) || isWithin(sourceKey, key)) {
      throw new SnapshotError("OUTPUT_OVERLAP", "output root must not overlap the source root");
    }
  }
  if (pathEntryExists(absolute, io) || pathEntryExists(canonical, io)) {
    throw new SnapshotError("OUTPUT_EXISTS", `output root already exists: ${outputRoot}`);
  }
  // The anchor must be a real, canonical directory (no link in the existing
  // prefix); every tail component is created and verified below.
  const anchorStats = io.lstat(anchor);
  if (anchorStats.isSymbolicLink() || !anchorStats.isDirectory()) {
    throw new SnapshotError("OUTPUT_OVERLAP", `output anchor is not a real directory: ${anchor}`);
  }
  return { canonical, anchor };
}

/**
 * Capture an immutable, bounded snapshot of the scoped candidate deltas.
 *
 * The second parameter is an internal filesystem seam (defaults to the real
 * filesystem) used to exercise read-time races deterministically.
 */
export async function captureSnapshot(
  options: SnapshotOptions,
  io: SnapshotIo = nodeSnapshotIo,
): Promise<SnapshotManifest> {
  const parsed = parseOptions(options);
  const sourceRoot = resolveSourceRoot(parsed.sourceRoot, io);
  const { canonical: outputRoot, anchor: outputAnchor } = resolveOutputRoot(
    parsed.outputRoot,
    sourceRoot,
    io,
  );

  const observation = observe(
    sourceRoot,
    parsed.scopePaths,
    parsed.scopeExclusions,
    parsed.limits,
    io,
  );

  const copyRoot = join(outputRoot, "files");
  // Build the output tree one component at a time from the trusted canonical
  // anchor, refusing to follow any symlink/junction inserted below it.
  createDirectoriesExclusive(outputRoot, outputAnchor, io);
  createDirectoriesExclusive(copyRoot, outputRoot, io);
  for (const [rel, buffer] of observation.contents) {
    const destination = join(copyRoot, ...rel.split("/"));
    const destinationDir = dirname(destination);
    createDirectoriesExclusive(destinationDir, copyRoot, io);
    // Re-check the whole destination path for links immediately before writing.
    assertNoOutputLinks(destinationDir, copyRoot, io);
    try {
      io.writeFileExclusive(destination, buffer);
    } catch (error) {
      if (isEexist(error)) {
        throw new SnapshotError("OUTPUT_COLLISION", `output file already exists: ${rel}`);
      }
      throw error;
    }
    // A junction swapped into a parent between the check and the write would
    // make the created file resolve outside the reserved root; refuse it.
    assertNoOutputLinks(destinationDir, copyRoot, io);
    let written: string;
    try {
      written = io.realpath(destination);
    } catch {
      throw new SnapshotError("OUTPUT_COLLISION", `output file cannot be resolved: ${rel}`);
    }
    if (!isWithin(written, copyRoot)) {
      throw new SnapshotError("OUTPUT_COLLISION", `output file was redirected outside the root: ${rel}`);
    }
  }

  const candidateId = computeCandidateId(
    parsed.taskId,
    parsed.taskRevision,
    observation.base.revision,
    observation.scope,
    observation.files,
  );

  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    taskId: parsed.taskId,
    taskRevision: parsed.taskRevision,
    candidateId,
    base: observation.base,
    scope: observation.scope,
    sourceRoot,
    outputRoot,
    copyRoot,
    files: observation.files,
    exclusions: observation.exclusions,
    limits: observation.limits,
    policyVersion: POLICY_VERSION,
  };

  assertNoOutputLinks(outputRoot, outputAnchor, io);
  const manifestPath = join(outputRoot, "manifest.json");
  try {
    io.writeFileExclusive(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    if (isEexist(error)) {
      throw new SnapshotError("OUTPUT_COLLISION", "output manifest already exists");
    }
    throw error;
  }
  return manifest;
}

function parseManifest(value: unknown): SnapshotManifest {
  const result = SnapshotManifestSchema.safeParse(value);
  if (!result.success) {
    throw new SnapshotValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function baseResult(
  manifest: SnapshotManifest,
  error?: string,
): FreshnessResult {
  const reasons: string[] = ["DELTA_SCOPE"];
  const errors: string[] = [];
  if (manifest.scope.partial) reasons.push("PARTIAL_SCOPE");
  if (error) errors.push(error);
  return {
    manifestVersion: manifest.schemaVersion,
    fresh: false,
    candidateId: manifest.candidateId,
    currentCandidateId: null,
    base: { matches: false, expected: manifest.base.revision, actual: null },
    changed: [],
    added: [],
    deleted: [],
    scope: manifest.scope,
    scopeComplete: false,
    exclusions: [],
    reasons,
    errors,
  };
}

/**
 * Re-observe the manifest's declared scope and report whether the content and
 * base revision still match.
 *
 * A malformed manifest is rejected before any filesystem read; a manifest whose
 * own hash list no longer recomputes to its `candidateId` is rejected as
 * tampered. Freshness only speaks for the declared scope.
 */
export async function checkFreshness(
  manifest: SnapshotManifest,
  io: SnapshotIo = nodeSnapshotIo,
): Promise<FreshnessResult> {
  const parsed = parseManifest(manifest as unknown);

  const selfIdentity = computeCandidateId(
    parsed.taskId,
    parsed.taskRevision,
    parsed.base.revision,
    parsed.scope,
    parsed.files,
  );
  if (selfIdentity !== parsed.candidateId) {
    throw new SnapshotError("MANIFEST_TAMPERED", "manifest hash list does not match its candidateId");
  }

  let sourceRoot: string;
  try {
    sourceRoot = resolveSourceRoot(parsed.sourceRoot, io);
  } catch (error) {
    return baseResult(parsed, error instanceof SnapshotError ? error.code : String(error));
  }

  let observation: Observation;
  try {
    observation = observe(
      sourceRoot,
      parsed.scope.paths,
      parsed.scope.exclusions,
      parsed.limits,
      io,
    );
  } catch (error) {
    return baseResult(parsed, error instanceof SnapshotError ? error.code : String(error));
  }

  const oldByPath = new Map(parsed.files.map((file) => [canonicalKey(file.path), file]));
  const newByPath = new Map(observation.files.map((file) => [canonicalKey(file.path), file]));
  const addedKeys = new Set<string>();
  const deletedKeys = new Set<string>();
  const changedKeys = new Set<string>();

  for (const [key, file] of newByPath) {
    const previous = oldByPath.get(key);
    if (!previous) {
      addedKeys.add(key);
    } else if (previous.status !== "deleted" && file.status === "deleted") {
      deletedKeys.add(key);
    }
  }
  for (const key of oldByPath.keys()) {
    if (!newByPath.has(key) && !deletedKeys.has(key)) deletedKeys.add(key);
  }
  for (const [key, file] of newByPath) {
    if (addedKeys.has(key) || deletedKeys.has(key)) continue;
    const previous = oldByPath.get(key);
    if (!previous) continue;
    if (
      previous.hash !== file.hash ||
      previous.size !== file.size ||
      previous.status !== file.status
    ) {
      changedKeys.add(key);
    }
  }

  const pathOf = (key: string): string => (newByPath.get(key) ?? oldByPath.get(key))?.path ?? key;
  const changed = [...changedKeys].map(pathOf).sort();
  const added = [...addedKeys].map(pathOf).sort();
  const deleted = [...deletedKeys].map(pathOf).sort();

  const currentCandidateId = computeCandidateId(
    parsed.taskId,
    parsed.taskRevision,
    observation.base.revision,
    observation.scope,
    observation.files,
  );
  const baseMatches = observation.base.revision === parsed.base.revision;

  const reasons: string[] = ["DELTA_SCOPE"];
  if (!baseMatches) reasons.push("BASE_REVISION_CHANGED");
  if (added.length > 0) reasons.push("FILES_ADDED");
  if (deleted.length > 0) reasons.push("FILES_DELETED");
  if (changed.length > 0) reasons.push("FILES_CHANGED");
  if (parsed.scope.partial) reasons.push("PARTIAL_SCOPE");

  const candidateMatches = currentCandidateId === parsed.candidateId;
  if (!candidateMatches && reasons.length === 1) reasons.push("CANDIDATE_ID_MISMATCH");

  const fresh =
    baseMatches &&
    added.length === 0 &&
    deleted.length === 0 &&
    changed.length === 0 &&
    candidateMatches;

  return {
    manifestVersion: parsed.schemaVersion,
    fresh,
    candidateId: parsed.candidateId,
    currentCandidateId,
    base: { matches: baseMatches, expected: parsed.base.revision, actual: observation.base.revision },
    changed,
    added,
    deleted,
    scope: parsed.scope,
    scopeComplete: false,
    exclusions: observation.exclusions,
    reasons,
    errors: [],
  };
}
