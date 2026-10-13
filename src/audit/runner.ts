/**
 * Task 4 — optional authorized disposable execution: the bounded Docker runner.
 *
 * `runCheck` accepts execution only for an opaque `ApprovedCheck` produced by
 * `authorizeCheck` (see `policy.ts`). There is deliberately **no** native
 * candidate execution and **no** shell: the only external process started is the
 * trusted `docker` control CLI, always via an argv array. Candidate argv is
 * appended *after* the image, so it can never add Docker options; the container
 * configuration (network, rootfs, capabilities, user, resource/time/output
 * limits, tmpfs and the single input mount) is fixed by the verifier.
 *
 * ## Round-1 repair summary
 *
 *   1. **Identity-bound bytes.** An approval names one pinned input snapshot
 *      (root + digest). `runCheck` requires the context root to equal that exact
 *      root, re-collects the input, and refuses to launch when the materialized
 *      digest differs from the approved digest. A changed file or a different
 *      root can no longer wear the approved candidate identity.
 *   2. **Non-destructive owned scratch.** The runner never deletes a
 *      caller-supplied path. It exclusively reserves a fresh random directory
 *      under the work root, refuses overlapping input/work/store roots, and
 *      removes only that exact owned directory in `finally` (including after a
 *      partial materialization).
 *   3. **Nondecisive same-process discovery (round-2 repair).** The candidate
 *      module executes in the SAME Python process as the verifier harness, so it
 *      can forge the harness's counts (`os.write` + `os._exit` at import,
 *      monkeypatching `json.dumps`/`unittest.TestResult`/`sys.__stdout__`).
 *      Counts parsed from that process are therefore a **benign framework
 *      observation only**: they are recorded for diagnostics but are never
 *      decisive for suite completeness, and can never produce
 *      `COMPLETED/PASS` or `COMPLETED/FAIL`. A process exit only proves the
 *      process completed. A `"candidate"` adapter stays nondecisive too, skips
 *      stay policy-owned, and truncated output cannot certify a suite tail.
 *   4. **Verified cleanup.** Container removal is checked for success/absence and
 *      a cleanup failure downgrades any `COMPLETED` verdict to `BLOCKED`. The run
 *      force-settles under a hard upper bound even if the child never closes.
 *   5. **Real capability boundary.** `runCheck` accepts only a capability set
 *      produced and registered by the real-docker `probeDockerCapabilities` for
 *      the same pinned image; a caller-supplied JSON object cannot claim support.
 *      The probe treats a malformed observation as `unknown` (fail closed), so a
 *      missing `uid` is never mistaken for a non-root user.
 *
 * ## Honest limits
 *
 * Docker hardening on this host is a set of observed controls, not a universal
 * malicious-code sandbox. Capabilities are probed and required to be *supported*;
 * anything unknown/unsupported fails closed with no privileged or unconfined
 * fallback.
 *
 * Discovery trust boundary: because the harness shares a process with untrusted
 * candidate code, **no** test-suite count from this runner is decisive. Suite
 * completeness cannot be certified by this task; a criterion requiring it stays
 * `UNVERIFIED`. Capability registration is in-process: it stops a caller-supplied
 * JSON object from authorizing, but it is not a cross-process attestation. The
 * executor-injectable probe is a separate trusted-code/test-only seam
 * (`probeDockerCapabilitiesWithExecutor`) that the model-facing production path
 * must not import; the production `probeDockerCapabilities` always binds the
 * real Docker executor. That is a code/import boundary, not a string claim of
 * authenticity.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DiscoverySchema, type Discovery } from "./contracts.js";
import {
  RUN_USER,
  isApprovedCheck,
  type ApprovedCheck,
  type CapabilityState,
  type DockerCapabilities,
} from "./policy.js";
import {
  VERIFIER_HARNESS_DIR,
  VERIFIER_HARNESS_DIGEST,
  VERIFIER_HARNESS_FILENAME,
  VERIFIER_HARNESS_SOURCE,
} from "./harness.js";
import type { CheckReceipt } from "./evidence-store.js";

export type RunnerErrorCode =
  | "NOT_AUTHORIZED"
  | "INVALID_CONTEXT"
  | "INPUT_MISSING"
  | "INPUT_UNSAFE"
  | "INPUT_TOO_LARGE"
  | "INPUT_COPY_MISMATCH"
  | "INPUT_DIGEST_MISMATCH"
  | "WORKSPACE_EXISTS"
  | "WORKSPACE_UNSAFE"
  | "WORKSPACE_OVERLAP"
  | "HARNESS_DIGEST_MISMATCH"
  | "STORE_MOUNT_REFUSED";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;

  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = "RunnerError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filesystem seam (defaults to the real filesystem; used for deterministic tests)
// ---------------------------------------------------------------------------

export interface RunnerStats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface RunnerIo {
  exists(path: string): boolean;
  lstat(path: string): RunnerStats;
  readdir(path: string): string[];
  readFile(path: string): Buffer;
  realpath(path: string): string;
  mkdirp(path: string): void;
  /** Exclusive directory creation; throws `EEXIST` if the path exists. */
  mkdirExclusive(path: string): void;
  writeFileExclusive(path: string, data: Buffer | string): void;
  rmrf(path: string): void;
}

export const nodeRunnerIo: RunnerIo = {
  exists: (path) => existsSync(path),
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync(path),
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  mkdirExclusive: (path) => {
    mkdirSync(path);
  },
  writeFileExclusive: (path, data) => {
    writeFileSync(path, data, { flag: "wx" });
  },
  rmrf: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
};

function isEexist(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { code?: unknown }).code === "EEXIST" ||
      (error as { code?: unknown }).code === "ENOTEMPTY")
  );
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Recursively freeze a value so a holder cannot widen it after the fact. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function canonicalKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return canonicalKey(a) === canonicalKey(b);
}

function pathsOverlap(a: string, b: string): boolean {
  const ca = canonicalKey(a);
  const cb = canonicalKey(b);
  return ca === cb || ca.startsWith(`${cb}/`) || cb.startsWith(`${ca}/`);
}

// ---------------------------------------------------------------------------
// Input materialization
// ---------------------------------------------------------------------------

export interface InputLimitOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface MaterializeOptions extends InputLimitOptions {
  /** When set, the collected manifest digest must equal this or the copy fails. */
  expectedDigest?: string;
}

const DEFAULT_INPUT_LIMITS = {
  maxFiles: 2048,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
} as const;

export interface CollectedInputFile {
  path: string;
  size: number;
  hash: string;
}

export interface CollectedInput {
  files: CollectedInputFile[];
  excluded: Array<{ path: string; reason: string }>;
  digest: string;
}

const VERIFIER_DIRECTORIES = new Set(["audit-build", "audit-output", ".audit", ".audit-build", ".teamwork-audit"]);
const SECRET_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".docker"]);
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
]);
/** Verifier-owned reserved directory; candidate snapshots may never supply it. */
const RESERVED_DIRECTORIES = new Set([VERIFIER_HARNESS_DIR]);

function secretFileReason(path: string): string | null {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (base === ".env" || base.startsWith(".env.")) return "env-file";
  if (/\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(base)) return "private-key";
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(base)) return "ssh-private-key";
  if (base === ".npmrc" || base === ".netrc" || base === ".git-credentials" || base === ".htpasswd") {
    return "auth-file";
  }
  if (base === "credentials" || base === "credentials.json" || base === "secrets.json" || base === "secrets.yaml") {
    return "credentials";
  }
  if (/^service-account.*\.json$/.test(base)) return "service-account";
  return null;
}

function inputExclusionReason(rel: string): string | null {
  if (rel === "") return null;
  for (const segment of rel.split("/")) {
    const key = process.platform === "win32" ? segment.toLowerCase() : segment;
    if (VERIFIER_DIRECTORIES.has(key)) return "verifier-storage";
    if (SECRET_DIRECTORIES.has(key)) return "secret-directory";
    if (EXCLUDED_DIRECTORIES.has(key)) return "policy-directory";
    if (RESERVED_DIRECTORIES.has(key)) return "verifier-reserved";
  }
  return secretFileReason(rel);
}

/**
 * Walk a verifier-owned input root and collect the regular files permitted to
 * enter the container. Any symlink/junction component fails closed; secrets,
 * VCS metadata, dependency/verifier directories and the verifier-reserved
 * harness directory are excluded visibly; size and count are bounded before
 * anything is read.
 */
export function collectInputFiles(
  root: string,
  options: InputLimitOptions = {},
  io: RunnerIo = nodeRunnerIo,
): CollectedInput {
  const maxFiles = options.maxFiles ?? DEFAULT_INPUT_LIMITS.maxFiles;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_INPUT_LIMITS.maxFileBytes;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_INPUT_LIMITS.maxTotalBytes;

  const files: CollectedInputFile[] = [];
  const excluded: Array<{ path: string; reason: string }> = [];
  let totalBytes = 0;

  const walk = (absolute: string, rel: string): void => {
    let stats: RunnerStats;
    try {
      stats = io.lstat(absolute);
    } catch {
      throw new RunnerError("INPUT_MISSING", `input path is unreadable: ${rel || "."}`);
    }
    if (stats.isSymbolicLink()) {
      throw new RunnerError("INPUT_UNSAFE", `input traverses a symlink or junction: ${rel || "."}`);
    }
    const reason = inputExclusionReason(rel);
    if (reason) {
      excluded.push({ path: rel, reason });
      return;
    }
    if (stats.isDirectory()) {
      for (const name of [...io.readdir(absolute)].sort()) {
        walk(join(absolute, name), rel === "" ? name : `${rel}/${name}`);
      }
      return;
    }
    if (!stats.isFile()) return;
    if (stats.size > maxFileBytes) {
      throw new RunnerError("INPUT_TOO_LARGE", `input file exceeds the per-file bound: ${rel}`);
    }
    if (files.length + 1 > maxFiles) {
      throw new RunnerError("INPUT_TOO_LARGE", `input exceeds the file-count bound (${maxFiles})`);
    }
    if (totalBytes + stats.size > maxTotalBytes) {
      throw new RunnerError("INPUT_TOO_LARGE", `input exceeds the total-size bound`);
    }
    const buffer = io.readFile(absolute);
    totalBytes += buffer.byteLength;
    files.push({ path: rel, size: buffer.byteLength, hash: sha256Hex(buffer) });
  };

  walk(resolve(root), "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = `sha256:${sha256Hex(JSON.stringify({ files: files.map((f) => [f.path, f.size, f.hash]) }))}`;
  return { files, excluded, digest };
}

/**
 * Copy the collected input into a fresh, exclusively-reserved directory and
 * re-hash every copied file. The destination is never deleted: if it already
 * exists this fails closed, and an optional `expectedDigest` is checked against
 * the collected manifest *before* anything is written.
 */
export function materializeInput(
  root: string,
  destination: string,
  options: MaterializeOptions = {},
  io: RunnerIo = nodeRunnerIo,
): CollectedInput {
  const collected = collectInputFiles(root, options, io);
  if (options.expectedDigest !== undefined && collected.digest !== options.expectedDigest) {
    throw new RunnerError(
      "INPUT_DIGEST_MISMATCH",
      "input content does not match the approved snapshot digest",
    );
  }
  io.mkdirp(dirname(destination));
  if (io.exists(destination)) {
    throw new RunnerError("WORKSPACE_EXISTS", `destination already exists: ${destination}`);
  }
  try {
    io.mkdirExclusive(destination);
  } catch (error) {
    if (isEexist(error)) {
      throw new RunnerError("WORKSPACE_EXISTS", `destination was created concurrently: ${destination}`);
    }
    throw error;
  }
  const sourceRoot = resolve(root);
  for (const file of collected.files) {
    const source = join(sourceRoot, ...file.path.split("/"));
    const buffer = io.readFile(source);
    const target = join(destination, ...file.path.split("/"));
    io.mkdirp(dirname(target));
    io.writeFileExclusive(target, buffer);
    if (sha256Hex(io.readFile(target)) !== file.hash) {
      throw new RunnerError("INPUT_COPY_MISMATCH", `copied input hash mismatch: ${file.path}`);
    }
  }
  return collected;
}

/**
 * Write the verifier-owned harness into the already-created input copy under the
 * reserved directory. Its bytes come from this process, never the candidate, and
 * the written digest is re-derived and compared.
 */
function writeVerifierHarness(copyRoot: string, expectedDigest: string | undefined): void {
  if (expectedDigest !== undefined && expectedDigest !== VERIFIER_HARNESS_DIGEST) {
    throw new RunnerError("HARNESS_DIGEST_MISMATCH", "approved harness digest does not match the verifier harness");
  }
  const dir = join(copyRoot, VERIFIER_HARNESS_DIR);
  nodeRunnerIo.mkdirp(dir);
  const target = join(dir, VERIFIER_HARNESS_FILENAME);
  nodeRunnerIo.writeFileExclusive(target, VERIFIER_HARNESS_SOURCE);
  const digest = `sha256:${sha256Hex(nodeRunnerIo.readFile(target))}`;
  if (digest !== VERIFIER_HARNESS_DIGEST) {
    throw new RunnerError("HARNESS_DIGEST_MISMATCH", "the written verifier harness digest did not match");
  }
}

// ---------------------------------------------------------------------------
// Environment sanitation
// ---------------------------------------------------------------------------

/**
 * Host env allowlist for the `docker` CLI subprocess. Only variables needed to
 * locate the executable and the daemon are forwarded; no secret-bearing name is
 * ever passed, regardless of value shape.
 */
const HOST_ENV_ALLOWLIST = new Set([
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "WINDIR",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
]);

export function sanitizeDockerEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    if (!HOST_ENV_ALLOWLIST.has(key)) continue;
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  // DOCKER_HOST may be required to reach a remote daemon; refuse credential-bearing forms.
  const dockerHost = source.DOCKER_HOST;
  if (dockerHost !== undefined && !dockerHost.includes("@") && !/(secret|token|password)/i.test(dockerHost)) {
    out.DOCKER_HOST = dockerHost;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Docker executor
// ---------------------------------------------------------------------------

export interface DockerRunRequest {
  args: string[];
  containerName: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface BoundedResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  spawnError?: string;
}

/** Outcome of a container-removal attempt. `ok` requires verified absence. */
export interface CleanupResult {
  ok: boolean;
  detail?: string;
}

/** A single `docker` probe's outcome, independent of the spawning mechanism. */
export interface RemovalProbe {
  error?: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
}

const NO_SUCH_CONTAINER = /no such (?:object|container)/i;

/**
 * Decide whether a container is verified absent. Removal is only `ok` when it
 * either succeeded or absence is *positively* established:
 *
 *   - a successful (`status === 0`) daemon query whose name list does not
 *     contain the exact container name, or
 *   - an inspect that the daemon genuinely answered with `no such
 *     object`/`no such container`.
 *
 * A nonzero or errored probe is **ambiguous**, not absence: a daemon outage, a
 * permission error or a spawn failure all produce nonzero exits and must never
 * be mistaken for "the container is gone". Such a result is `ok: false`, which
 * downgrades the run to BLOCKED.
 *
 * The `verify` argument is a *names* listing. For direct callers only, a nonzero
 * probe whose stderr explicitly reports `no such object`/`no such container` is
 * also accepted as positive absence; the executor's inspect fallback instead
 * routes through {@link classifyContainerInspectAbsence} because an inspect id is
 * not a container name.
 */
export function classifyContainerRemoval(
  name: string,
  rm: RemovalProbe,
  verify: RemovalProbe,
): CleanupResult {
  if (!rm.error && rm.status === 0) return { ok: true };
  if (!verify.error && verify.status === 0) {
    const present = verify.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === name);
    if (!present) return { ok: true, detail: "container is absent (verified by a successful daemon query)" };
    return { ok: false, detail: "container is still present after a failed removal" };
  }
  if (!verify.error && verify.status !== 0 && NO_SUCH_CONTAINER.test(verify.stderr)) {
    return { ok: true, detail: "container is absent (daemon reported no such container)" };
  }
  const detail = String(
    rm.error?.message ?? (rm.stderr || verify.stderr || "container removal was not verified"),
  )
    .trim()
    .slice(0, 200);
  return { ok: false, detail: detail === "" ? "container removal was not verified" : detail };
}

/**
 * Decide whether a *non-successful removal* is nonetheless verified absent using
 * an `inspect` result. An inspect id is **not** a container name: a successful
 * inspect returns the container's id, which means the container still exists, so
 * it is never absence. Only a nonzero inspect that the daemon explicitly answered
 * with `no such object`/`no such container` is positive absence; every other
 * error (daemon outage, permission denial, spawn failure) is ambiguous and fails
 * closed. This is deliberately separate from {@link classifyContainerRemoval},
 * whose `verify` argument is always a *names* listing.
 */
export function classifyContainerInspectAbsence(inspect: RemovalProbe): CleanupResult {
  if (!inspect.error && inspect.status === 0) {
    return { ok: false, detail: "container is still present after a failed removal" };
  }
  if (!inspect.error && inspect.status !== 0 && NO_SUCH_CONTAINER.test(inspect.stderr)) {
    return { ok: true, detail: "container is absent (daemon reported no such container)" };
  }
  return { ok: false, detail: "container absence could not be verified" };
}

export interface DockerExecutor {
  run(request: DockerRunRequest): Promise<BoundedResult>;
  removeContainer(name: string): Promise<CleanupResult>;
}

interface BoundedStream {
  chunks: Buffer[];
  length: number;
  total: number;
}

/** Hard grace after a timeout before the promise force-settles if the child hangs. */
const HARD_KILL_GRACE_MS = 10_000;

function attachBounded(stream: NodeJS.ReadableStream, state: BoundedStream, cap: number): void {
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.total += buffer.byteLength;
    if (state.length < cap) {
      const remaining = cap - state.length;
      const slice = buffer.byteLength <= remaining ? buffer : buffer.subarray(0, remaining);
      state.chunks.push(slice);
      state.length += slice.byteLength;
    }
  });
  stream.on("error", () => {
    // Never let a stream error reject the wait; the child close/error settles it.
  });
}

export const nodeDockerExecutor: DockerExecutor = {
  run(request: DockerRunRequest): Promise<BoundedResult> {
    return new Promise<BoundedResult>((resolveResult) => {
      const cap = request.maxOutputBytes;
      const stdoutState: BoundedStream = { chunks: [], length: 0, total: 0 };
      const stderrState: BoundedStream = { chunks: [], length: 0, total: 0 };
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("docker", request.args, {
          env: request.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolveResult({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          truncated: false,
          timedOut: false,
          cancelled: false,
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const finish = (exitCode: number | null, signal: string | null, spawnError?: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (hardTimer) clearTimeout(hardTimer);
        if (onAbort && request.signal) request.signal.removeEventListener("abort", onAbort);
        resolveResult({
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
          stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
          stdoutBytes: stdoutState.total,
          stderrBytes: stderrState.total,
          truncated: stdoutState.total > cap || stderrState.total > cap,
          timedOut,
          cancelled,
          ...(spawnError ? { spawnError } : {}),
        });
      };

      const stop = async (): Promise<void> => {
        try {
          await nodeDockerExecutor.removeContainer(request.containerName);
        } catch {
          // best effort
        }
        try {
          child.kill();
        } catch {
          // best effort
        }
      };

      if (child.stdout) attachBounded(child.stdout, stdoutState, cap);
      if (child.stderr) attachBounded(child.stderr, stderrState, cap);

      timer = setTimeout(() => {
        timedOut = true;
        void stop();
        // Hard upper bound: settle even if removal or the child close never fires.
        hardTimer = setTimeout(() => finish(null, "SIGKILL-UNRESPONSIVE"), HARD_KILL_GRACE_MS);
        if (typeof hardTimer.unref === "function") hardTimer.unref();
      }, request.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      if (request.signal) {
        if (request.signal.aborted) {
          cancelled = true;
          void stop();
          hardTimer = setTimeout(() => finish(null, "SIGKILL-UNRESPONSIVE"), HARD_KILL_GRACE_MS);
          if (typeof hardTimer.unref === "function") hardTimer.unref();
        } else {
          onAbort = () => {
            cancelled = true;
            void stop();
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.on("error", (error) => finish(null, null, error.message));
      child.on("close", (code, signal) => finish(code, signal));
    });
  },

  async removeContainer(name: string): Promise<CleanupResult> {
    const probe = (args: string[]): RemovalProbe => {
      const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: sanitizeDockerEnv(),
      });
      return {
        ...(result.error ? { error: result.error } : {}),
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
      };
    };
    const rm = probe(["rm", "-f", name]);
    if (!rm.error && rm.status === 0) return { ok: true };
    // Removal did not report success. Absence must be *positively* verified by a
    // successful `ps -a` names listing; only when that query is itself
    // unavailable do we fall back to an explicit inspect. A successful inspect
    // returns the container's id (the container exists), so it is never fed to
    // the names-list classifier and never mistaken for absence.
    const listing = probe(["ps", "-a", "--format", "{{.Names}}"]);
    if (!listing.error && listing.status === 0) {
      return classifyContainerRemoval(name, rm, listing);
    }
    return classifyContainerInspectAbsence(
      probe(["container", "inspect", "--format", "{{.Id}}", name]),
    );
  },
};

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  image: string;
  timeoutMs?: number;
  pids?: number;
  memoryMb?: number;
  cpus?: number;
  tmpfsMb?: number;
}

const PROBE_SCRIPT = [
  "import json,os,re",
  "r={}",
  "r['uid']=os.getuid()",
  "def rd(p):",
  "    try: return open(p).read().strip()",
  "    except Exception: return None",
  "st=rd('/proc/self/status') or ''",
  "m=re.search(r'NoNewPrivs:\\s*(\\d+)',st); r['nopriv']=m.group(1) if m else None",
  "m=re.search(r'CapEff:\\s*([0-9a-fA-F]+)',st); r['capEff']=m.group(1) if m else None",
  "try:",
  "    open('/probe-write','w').write('x'); r['rootWrite']='allowed'",
  "except Exception: r['rootWrite']='denied'",
  "try:",
  "    import socket; s=socket.socket(); s.settimeout(2); s.connect(('1.1.1.1',80)); r['net']='connected'",
  "except Exception: r['net']='blocked'",
  "r['pidsMax']=rd('/sys/fs/cgroup/pids.max')",
  "r['memMax']=rd('/sys/fs/cgroup/memory.max')",
  "r['cpuMax']=rd('/sys/fs/cgroup/cpu.max')",
  "r['tmpTmpfs']=' /tmp tmpfs ' in (rd('/proc/mounts') or '')",
  "print(json.dumps(r))",
].join("\n");

function probeSuffix(): string {
  return randomBytes(6).toString("hex");
}

function numericLimit(value: string | null): number | null {
  if (value === null) return null;
  if (value === "max") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Module-private registry of capability sets produced by a real probe. There is
 * no exported way to add to it, so a JSON object that merely claims all controls
 * are supported cannot authorize execution at the runner boundary.
 */
const probedCapabilities = new WeakSet<object>();

/** True only for a capability set actually returned by `probeDockerCapabilities`. */
export function isProbedCapabilities(value: unknown): value is DockerCapabilities {
  return typeof value === "object" && value !== null && probedCapabilities.has(value);
}

function registerCapabilities(capabilities: DockerCapabilities): DockerCapabilities {
  const frozen = deepFreeze(capabilities);
  probedCapabilities.add(frozen);
  return frozen;
}

function unknownControls(): {
  readOnlyRootfs: CapabilityState;
  capDropAll: CapabilityState;
  noNewPrivileges: CapabilityState;
  nonRootUser: CapabilityState;
  networkNone: CapabilityState;
  pidsLimit: CapabilityState;
  memoryLimit: CapabilityState;
  cpusLimit: CapabilityState;
  tmpfs: CapabilityState;
} {
  return {
    readOnlyRootfs: "unknown",
    capDropAll: "unknown",
    noNewPrivileges: "unknown",
    nonRootUser: "unknown",
    networkNone: "unknown",
    pidsLimit: "unknown",
    memoryLimit: "unknown",
    cpusLimit: "unknown",
    tmpfs: "unknown",
  };
}

/**
 * Internal probe body. The capability set it returns is frozen and registered
 * in this module's private registry, so `runCheck` can require that a real
 * probe produced it. It is deliberately NOT exported: the only intended callers
 * are the real-docker production wrapper and the trusted-code seam below.
 */
async function probeWithExecutor(
  executor: DockerExecutor,
  options: ProbeOptions,
): Promise<DockerCapabilities> {
  const env = sanitizeDockerEnv();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const notes: string[] = [];

  const versionName = `t4-probe-version-${probeSuffix()}`;
  let engine: DockerCapabilities["engine"] = { available: false };
  try {
    const versionRun = await executor.run({
      args: ["version", "--format", "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"],
      containerName: versionName,
      timeoutMs,
      maxOutputBytes: 4096,
      env,
    });
    if (!versionRun.spawnError && versionRun.exitCode === 0) {
      const [version, os, arch] = versionRun.stdout.trim().split("|");
      engine = { available: true, version, os, arch };
    } else {
      engine = {
        available: false,
        error: versionRun.spawnError ?? (versionRun.stderr.trim() || `exit ${versionRun.exitCode}`),
      };
    }
  } catch (error) {
    engine = { available: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await executor.removeContainer(versionName).catch(() => undefined);
  }

  if (!engine.available) {
    return registerCapabilities({
      probed: true,
      image: options.image,
      engine,
      ...unknownControls(),
      notes: ["engine unavailable; all containment controls are unknown (fail closed)"],
    });
  }

  const pids = options.pids ?? 64;
  const memoryMb = options.memoryMb ?? 128;
  const cpus = options.cpus ?? 1;
  const tmpfsMb = options.tmpfsMb ?? 8;
  const selfName = `t4-probe-self-${probeSuffix()}`;
  const args = [
    "run",
    "--name",
    selfName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    RUN_USER,
    "--pids-limit",
    String(pids),
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${tmpfsMb}m`,
    options.image,
    "python3",
    "-c",
    PROBE_SCRIPT,
  ];

  let observation: Record<string, unknown> | null = null;
  try {
    const selfRun = await executor.run({
      args,
      containerName: selfName,
      timeoutMs,
      maxOutputBytes: 16_384,
      env,
    });
    if (!selfRun.spawnError && selfRun.exitCode === 0) {
      const line = selfRun.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (line) {
        try {
          observation = JSON.parse(line) as Record<string, unknown>;
        } catch {
          notes.push("self-test output was not parseable JSON");
        }
      }
    } else {
      notes.push(`self-test container did not complete (exit ${selfRun.exitCode ?? selfRun.spawnError})`);
    }
  } catch (error) {
    notes.push(`self-test failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await executor.removeContainer(selfName).catch(() => undefined);
  }

  if (!observation) {
    return registerCapabilities({
      probed: true,
      image: options.image,
      engine,
      ...unknownControls(),
      notes: [...notes, "self-test observation unavailable; all controls unknown (fail closed)"],
    });
  }

  const pidsObserved = numericLimit(typeof observation.pidsMax === "string" ? observation.pidsMax : null);
  const memObserved = numericLimit(typeof observation.memMax === "string" ? observation.memMax : null);
  let cpuObserved: number | null = null;
  if (typeof observation.cpuMax === "string") {
    const [quota, period] = observation.cpuMax.split(/\s+/);
    const q = numericLimit(quota ?? null);
    const p = numericLimit(period ?? null);
    if (q !== null && p !== null) cpuObserved = q / p;
  }

  const supportedOr = (ok: boolean, detail: string): CapabilityState => {
    if (ok) return "supported";
    notes.push(detail);
    return "unsupported";
  };
  const unknownState = (detail: string): CapabilityState => {
    notes.push(detail);
    return "unknown";
  };

  return registerCapabilities({
    probed: true,
    image: options.image,
    engine,
    readOnlyRootfs:
      typeof observation.rootWrite === "string"
        ? supportedOr(observation.rootWrite === "denied", `rootfs write was ${observation.rootWrite}`)
        : unknownState("read-only rootfs observation was missing or malformed"),
    capDropAll:
      typeof observation.capEff === "string"
        ? supportedOr(observation.capEff === "0000000000000000", `CapEff was ${observation.capEff}`)
        : unknownState("CapEff observation was missing or malformed"),
    noNewPrivileges:
      typeof observation.nopriv === "string"
        ? supportedOr(observation.nopriv === "1", `NoNewPrivs was ${observation.nopriv}`)
        : unknownState("NoNewPrivs observation was missing or malformed"),
    // A malformed/missing uid is `unknown`; it must never be mistaken for a
    // non-root user because `undefined !== 0` is true.
    nonRootUser:
      typeof observation.uid === "number"
        ? supportedOr(observation.uid > 0, `uid was ${observation.uid}`)
        : unknownState("uid observation was missing or malformed"),
    networkNone:
      typeof observation.net === "string"
        ? supportedOr(observation.net === "blocked", `network was ${observation.net}`)
        : unknownState("network observation was missing or malformed"),
    pidsLimit:
      pidsObserved === null
        ? unknownState("pids cgroup limit was not observed")
        : supportedOr(pidsObserved <= pids, `pids limit was ${pidsObserved}`),
    memoryLimit:
      memObserved === null
        ? unknownState("memory cgroup limit was not observed")
        : supportedOr(memObserved <= memoryMb * 1024 * 1024, `memory limit was ${memObserved}`),
    cpusLimit:
      cpuObserved === null
        ? unknownState("cpu cgroup limit was not observed")
        : supportedOr(cpuObserved <= cpus + 0.001, `cpu limit was ${cpuObserved}`),
    tmpfs:
      typeof observation.tmpTmpfs === "boolean"
        ? supportedOr(observation.tmpTmpfs === true, "/tmp was not a tmpfs inside the probe")
        : unknownState("tmpfs observation was missing or malformed"),
    notes,
  });
}

/**
 * Probe the Docker engine and, if reachable, actually run a self-test container
 * under the exact hardening controls to observe whether they hold. This is the
 * **production / model-facing** probe: it always binds the real Docker executor
 * and exposes no executor injection, so a caller cannot feed it forged
 * observations to obtain a registered capability set. A control that cannot be
 * positively observed is `unknown`, which fails closed.
 *
 * The returned set is frozen and registered in an in-process registry so
 * `runCheck` can require that a real probe produced it. That registry is a
 * code/import boundary, not a cross-process attestation: trusted verifier code
 * that can import internal modules could bypass it, so no authenticity is
 * claimed beyond the code boundary.
 */
export async function probeDockerCapabilities(options: ProbeOptions): Promise<DockerCapabilities> {
  return probeWithExecutor(nodeDockerExecutor, options);
}

/**
 * @internal Trusted-code / test-only seam. Accepts an injected executor so the
 * probe can be exercised without a live Docker daemon. It is NOT part of the
 * model-facing production surface: production code must call the real-docker
 * `probeDockerCapabilities`. A caller that can import this internal seam is by
 * definition trusted code (it could monkeypatch this module just as easily), so
 * this is a code/import boundary, not a runtime authenticity proof — see the
 * module header.
 */
export async function probeDockerCapabilitiesWithExecutor(
  executor: DockerExecutor,
  options: ProbeOptions,
): Promise<DockerCapabilities> {
  return probeWithExecutor(executor, options);
}

// ---------------------------------------------------------------------------
// Discovery parsing (verifier-owned harness output only)
// ---------------------------------------------------------------------------

/**
 * A benign framework observation parsed from the same-process verifier harness.
 * It is deliberately NOT a decisive discovery: `overflow` records that the
 * harness's bounded sink discarded candidate output.
 */
export interface HarnessObservation {
  counts: Discovery;
  overflow: boolean;
}

function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Parse the last well-formed JSON line of the same-process verifier harness into
 * a benign observation. Counts are never decisive (see `mapOutcome`); the
 * `overflow` flag is surfaced so a candidate output flood inside the harness is
 * visible even though the harness sink is bounded and discards the excess.
 * `approvedSkips` is deliberately **not** read here: it is policy-owned, never
 * candidate-supplied.
 */
export function parseHarnessObservation(stdout: string): HarnessObservation | undefined {
  const record = lastJsonObject(stdout);
  if (!record) return undefined;
  const result = DiscoverySchema.safeParse({
    collected: record.collected,
    passed: record.passed,
    failed: record.failed,
    skipped: record.skipped,
  });
  if (!result.success) return undefined;
  return { counts: result.data, overflow: record.overflow === true };
}

/**
 * Parse reconciled counts from the last well-formed JSON line of the stdout of
 * the verifier-owned harness. Retained for callers that only want the counts.
 */
export function parseDiscoveryCounts(stdout: string): Discovery | undefined {
  return parseHarnessObservation(stdout)?.counts;
}

// ---------------------------------------------------------------------------
// runCheck
// ---------------------------------------------------------------------------

export interface RunnerContext {
  /** Verifier-owned input root; must equal the approved snapshot root exactly. */
  inputRoot: string;
  /** Verifier-owned parent under which a fresh owned scratch dir is reserved. */
  workRoot: string;
  /** Store root that must never overlap the input or the work root. */
  storeRoot?: string;
  /** Observed capability probe; must be a registered real probe. */
  capabilities: DockerCapabilities;
  docker?: DockerExecutor;
  signal?: AbortSignal;
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isWithin(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  const rel = relative(p, c);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isRealDirectory(path: string): boolean {
  try {
    const stats = nodeRunnerIo.lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    const real = nodeRunnerIo.realpath(path);
    return samePath(real, path);
  } catch {
    return false;
  }
}

/**
 * Reserve a fresh, exclusively-created, verifier-owned directory under the work
 * root. The name is random so two concurrent runs cannot collide or delete each
 * other's output; the directory is verified to be a real (non-link) directory
 * inside the work root immediately after creation.
 */
function reserveOwnedRoot(workReal: string): string | null {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const dir = join(workReal, `t4-run-${randomBytes(8).toString("hex")}`);
    try {
      nodeRunnerIo.mkdirExclusive(dir);
    } catch (error) {
      if (isEexist(error)) continue;
      throw error;
    }
    const real = realpathOrNull(dir);
    if (!real || !samePath(real, dir) || !isWithin(real, workReal)) {
      nodeRunnerIo.rmrf(dir);
      return null;
    }
    return dir;
  }
  return null;
}

function detectOverlap(input: string, work: string, store: string | undefined): string | null {
  const entries: Array<[string, string]> = [
    ["input", input],
    ["work", work],
  ];
  if (store !== undefined) entries.push(["store", store]);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      if (pathsOverlap(entries[i]![1], entries[j]![1])) {
        return `${entries[i]![0]} and ${entries[j]![0]}`;
      }
    }
  }
  return null;
}

type Completion = "COMPLETED" | "TIMEOUT" | "CANCELLED" | "FAILED" | "BLOCKED";
type Result = "PASS" | "FAIL" | "INCONCLUSIVE" | "UNKNOWN";

function requiredCapabilityProblems(capabilities: DockerCapabilities | undefined): string[] {
  if (!capabilities || capabilities.probed !== true) return ["CAPABILITY_NOT_PROBED"];
  const problems: string[] = [];
  if (!capabilities.engine?.available) problems.push("ENGINE_UNAVAILABLE");
  for (const key of [
    "readOnlyRootfs",
    "capDropAll",
    "noNewPrivileges",
    "nonRootUser",
    "networkNone",
    "pidsLimit",
    "memoryLimit",
    "cpusLimit",
    "tmpfs",
  ] as const) {
    if (capabilities[key] !== "supported") problems.push(`${key.toUpperCase()}:${capabilities[key]}`);
  }
  return problems;
}

function mapOutcome(
  result: BoundedResult,
  discoveryRequested: boolean,
): { completion: Completion; result: Result } {
  if (result.timedOut) return { completion: "TIMEOUT", result: "UNKNOWN" };
  if (result.cancelled) return { completion: "CANCELLED", result: "UNKNOWN" };
  if (result.spawnError) return { completion: "BLOCKED", result: "UNKNOWN" };
  if (result.signal) return { completion: "FAILED", result: "INCONCLUSIVE" };

  if (result.exitCode === 0) {
    // A clean process exit proves the process completed. Without a discovery
    // request that completion is the whole check and may be a PASS.
    if (!discoveryRequested) return { completion: "COMPLETED", result: "PASS" };
    // The only discovery channel is a same-process harness whose counts an
    // untrusted candidate can forge, so a suite run is never decisive: the
    // process completed, but suite completeness cannot be certified here.
    return { completion: "COMPLETED", result: "INCONCLUSIVE" };
  }

  // A nonzero process exit is a process failure attribution, not a requirement
  // contradiction. Same-process counts never manufacture a contradiction.
  return { completion: "FAILED", result: "INCONCLUSIVE" };
}

function boundOutput(result: BoundedResult, maxBytes: number): { text: string; truncated: boolean } {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const combined = stderr.length > 0 ? `${stdout}\n[stderr]\n${stderr}` : stdout;
  const encoder = Buffer.from(combined, "utf8");
  if (encoder.byteLength <= maxBytes) {
    return { text: combined, truncated: result.truncated };
  }
  const sliced = encoder.subarray(0, maxBytes).toString("utf8");
  return { text: sliced, truncated: true };
}

function baseReceipt(approved: ApprovedCheck): CheckReceipt {
  return {
    checkId: approved.checkId,
    taskId: approved.taskId,
    taskRevision: approved.taskRevision,
    candidateId: approved.candidateId,
    criterionIds: [...approved.criterionIds],
    kind: "EXECUTION",
    origin: "RUNNER_CAPTURED",
    completion: "BLOCKED",
    result: "UNKNOWN",
    argv: [...approved.argv],
    cwd: approved.cwd,
    runner: `docker image=${approved.image} network=none read-only cap-drop=ALL no-new-privileges user=${approved.user}`,
    environment: { ...approved.env },
    snapshotRef: { candidateId: approved.candidateId },
  };
}

function blockedReceipt(approved: ApprovedCheck, reason: string): CheckReceipt {
  const receipt = baseReceipt(approved);
  receipt.completion = "BLOCKED";
  receipt.result = "UNKNOWN";
  receipt.limitations = [reason, CONTAINMENT_DISCLAIMER];
  return receipt;
}

const CONTAINMENT_DISCLAIMER =
  "Docker hardening is a set of observed capability controls, not a certified sandbox; no universal malicious-code isolation is claimed.";

const SAME_PROCESS_DISCOVERY_LIMIT =
  "same-process discovery is a benign framework observation only: the candidate test module runs in the same Python process as the verifier harness and can forge these counts, so they are nondecisive for suite completeness and can never yield PASS/FAIL";

function buildReceipt(
  approved: ApprovedCheck,
  bounded: BoundedResult,
  collected: CollectedInput,
  startedAt: string,
): CheckReceipt {
  const discoveryRequested = approved.discovery !== undefined;
  // Only the verifier-owned harness is parsed, and even then only as an
  // observation. A raw candidate adapter is never parsed.
  const observational = approved.discovery?.source === "verifier-harness";
  const approvedSkips = approved.discovery?.approvedSkips ?? 0;
  const observation =
    discoveryRequested && observational && !bounded.truncated
      ? parseHarnessObservation(bounded.stdout)
      : undefined;
  const parsed = observation?.counts;
  const sinkOverflow = observation?.overflow ?? false;
  // The policy allowance can never exceed the observed skips (the discovery
  // schema requires `approvedSkips <= skipped`).
  const effectiveApprovedSkips = parsed ? Math.min(approvedSkips, parsed.skipped) : 0;
  const discovery = parsed
    ? { ...parsed, ...(effectiveApprovedSkips > 0 ? { approvedSkips: effectiveApprovedSkips } : {}) }
    : undefined;
  const outcome = mapOutcome(bounded, discoveryRequested);
  const output = boundOutput(bounded, approved.resources.maxOutputBytes);

  const limitations: string[] = [];
  if (approved.discovery) {
    limitations.push(
      `discovery adapter=${approved.discovery.adapterId} source=${approved.discovery.source} parser=${approved.discovery.parser}`,
    );
    if (approved.discovery.source === "candidate") {
      limitations.push("candidate-adapter discovery is nondecisive and can never prove a suite");
    } else {
      limitations.push(`NONDECISIVE_DISCOVERY: ${SAME_PROCESS_DISCOVERY_LIMIT}`);
    }
  }
  limitations.push(
    ...(sinkOverflow
      ? [
          "the same-process verifier harness reported an output overflow; its bounded sink discarded the excess candidate output (the container memory limit remains the last-resort bound)",
        ]
      : []),
    ...(bounded.truncated ? [`output was truncated at ${approved.resources.maxOutputBytes} bytes; a truncated stream cannot certify a suite tail`] : []),
    ...(output.truncated && !bounded.truncated ? [`output was truncated at ${approved.resources.maxOutputBytes} bytes`] : []),
    ...(collected.excluded.length > 0
      ? [`input excluded ${collected.excluded.length} path(s) (secrets/vcs/dependencies/verifier storage)`]
      : []),
    "output is bounded, candidate-controlled container text; the runner does not redact it, and redaction/bounds are applied when a receipt is imported into the evidence store",
    CONTAINMENT_DISCLAIMER,
  );

  return {
    ...baseReceipt(approved),
    completion: outcome.completion,
    result: outcome.result,
    ...(bounded.exitCode !== null ? { exitCode: bounded.exitCode } : {}),
    ...(bounded.signal !== null ? { signal: bounded.signal } : {}),
    startedAt,
    endedAt: new Date().toISOString(),
    ...(discovery ? { discovery } : {}),
    output: output.text,
    source: `fixture:${collected.digest} files=${collected.files.length} excluded=${collected.excluded.length}`,
    limitations,
  };
}

/**
 * Downgrade a verdict when container removal could not be verified: a run that
 * might have left an orphan container is never reported as complete.
 */
function markCleanupFailed(receipt: CheckReceipt, detail: string | undefined): CheckReceipt {
  const next: CheckReceipt = {
    ...receipt,
    limitations: [
      ...(receipt.limitations ?? []),
      `CLEANUP_FAILED: ${detail ?? "container removal was not verified"}`,
    ],
  };
  if (next.completion === "COMPLETED") {
    next.completion = "BLOCKED";
    next.result = "UNKNOWN";
  }
  return next;
}

async function removeOwnedContainer(docker: DockerExecutor, name: string): Promise<CleanupResult> {
  try {
    return await docker.removeContainer(name);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Run one approved check inside a disposable Docker container and return a
 * receipt that records only what was actually observed.
 */
export async function runCheck(approved: ApprovedCheck, context: RunnerContext): Promise<CheckReceipt> {
  if (!isApprovedCheck(approved)) {
    throw new RunnerError(
      "NOT_AUTHORIZED",
      "runCheck accepts only an opaque ApprovalResult from authorizeCheck",
    );
  }
  if (!context || typeof context.inputRoot !== "string" || typeof context.workRoot !== "string") {
    throw new RunnerError("INVALID_CONTEXT", "runner context inputRoot/workRoot are required");
  }

  const docker = context.docker ?? nodeDockerExecutor;
  const startedAt = new Date().toISOString();

  // The trusted runner boundary accepts only a capability set a real probe
  // produced and registered for the exact approved image.
  if (!isProbedCapabilities(context.capabilities)) {
    return blockedReceipt(approved, "capabilities were not produced by a real probe at this boundary");
  }
  const capProblems = requiredCapabilityProblems(context.capabilities);
  if (capProblems.length > 0) {
    return blockedReceipt(approved, `capability blocked: ${capProblems.join(", ")}`);
  }
  if (context.capabilities.image !== approved.image) {
    return blockedReceipt(approved, "probed capabilities do not match the approved pinned image");
  }

  const rootReal = realpathOrNull(context.inputRoot);
  if (!rootReal || !existsSync(rootReal)) {
    return blockedReceipt(approved, `input root is missing or unreadable: ${context.inputRoot}`);
  }
  const approvedRootReal = realpathOrNull(approved.inputRoot) ?? resolve(approved.inputRoot);
  if (!samePath(rootReal, approvedRootReal)) {
    return blockedReceipt(approved, "input root does not match the approved snapshot root exactly");
  }

  const workReal = realpathOrNull(context.workRoot);
  if (!workReal || !existsSync(workReal)) {
    return blockedReceipt(approved, `work root is missing or unreadable: ${context.workRoot}`);
  }
  if (!isRealDirectory(context.workRoot)) {
    return blockedReceipt(approved, "work root is not a real directory (symlink/junction refused)");
  }

  const storeReal = context.storeRoot
    ? realpathOrNull(context.storeRoot) ?? resolve(context.storeRoot)
    : undefined;

  const overlap = detectOverlap(rootReal, workReal, storeReal);
  if (overlap) {
    return blockedReceipt(approved, `overlapping input/work/store paths refused: ${overlap}`);
  }

  const ownedRoot = reserveOwnedRoot(workReal);
  if (!ownedRoot) {
    return blockedReceipt(approved, "could not reserve an exclusive verifier-owned work directory");
  }
  const copyRoot = join(ownedRoot, "input");

  const containerName = `t4-${approved.checkId}-${randomBytes(4).toString("hex")}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");

  let receipt: CheckReceipt | undefined;
  try {
    const collected = materializeInput(rootReal, copyRoot, { expectedDigest: approved.inputDigest });
    if (approved.discovery?.source === "verifier-harness") {
      writeVerifierHarness(copyRoot, approved.discovery.harnessDigest);
    }

    const mountSource = copyRoot.replace(/\\/g, "/");
    if (mountSource.includes(",")) {
      throw new RunnerError("WORKSPACE_UNSAFE", "input mount path contains an unsupported separator");
    }
    const args = buildDockerArgs(approved, mountSource, containerName);
    const env = sanitizeDockerEnv();
    const bounded = await docker.run({
      args,
      containerName,
      timeoutMs: approved.resources.timeoutMs,
      maxOutputBytes: approved.resources.maxOutputBytes,
      env,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    receipt = buildReceipt(approved, bounded, collected, startedAt);
  } catch (error) {
    if (error instanceof RunnerError && error.code === "INPUT_DIGEST_MISMATCH") {
      receipt = blockedReceipt(
        approved,
        "approved input snapshot is stale: materialized digest does not match the approved digest",
      );
    } else {
      receipt = blockedReceipt(
        approved,
        `execution blocked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    const cleanup = await removeOwnedContainer(docker, containerName);
    if (!cleanup.ok) {
      receipt = markCleanupFailed(
        receipt ?? blockedReceipt(approved, "execution did not complete"),
        cleanup.detail,
      );
    }
    // Only ever remove the exact random directory this run exclusively created.
    nodeRunnerIo.rmrf(ownedRoot);
  }

  return receipt ?? blockedReceipt(approved, "execution did not produce a receipt");
}

function buildDockerArgs(approved: ApprovedCheck, mountSource: string, containerName: string): string[] {
  const resources = approved.resources;
  const args = [
    "run",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    approved.user,
    "--pids-limit",
    String(resources.pids),
    "--memory",
    `${resources.memoryMb}m`,
    "--memory-swap",
    `${resources.memoryMb}m`,
    "--cpus",
    String(resources.cpus),
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${resources.tmpfsMb}m`,
    "--mount",
    `type=bind,source=${mountSource},target=${approved.inputMountTarget},readonly`,
    "--workdir",
    approved.cwd,
  ];
  for (const [key, value] of Object.entries(approved.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(approved.image, ...approved.argv);
  return args;
}
