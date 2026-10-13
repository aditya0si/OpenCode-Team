/**
 * Task 4 — optional authorized disposable execution: the fail-closed policy gate.
 *
 * This module is the *authorization* boundary for candidate check execution. It
 * is deliberately pure: it performs no I/O, reads no clock and runs nothing. It
 * turns a candidate-supplied `CheckPlan` plus a verifier-owned `AuditPolicy` plus
 * an observed `DockerCapabilities` probe into an `AuthorizationResult`.
 *
 * ## The default is disabled
 *
 * `DEFAULT_AUDIT_POLICY` is `DISABLED`, so with no explicit verifier opt-in every
 * check is refused. A `STATIC_ONLY` policy refuses execution too. Only a
 * `DOCKER` policy, with an observed capability set whose required controls are
 * all actually *supported*, can authorize anything.
 *
 * ## Authorization is an opaque process capability, not a boolean
 *
 * A successful `authorizeCheck` returns a frozen, deeply-immutable, branded
 * `ApprovedCheck` object that is registered in a module-private `WeakSet`. The
 * object is **not** a JSON document: `runCheck` accepts execution only when the
 * exact object it is handed is present in that `WeakSet`. A caller cannot forge
 * one by constructing an object literal, by re-parsing JSON, or by flipping a
 * boolean — there is no exported mint and no value that can be serialized back
 * into a capability. Approval therefore binds the exact resolved `argv`, `cwd`,
 * task/revision/candidate identity, digest-pinned image, the exact input root and
 * its content digest, network mode, input mount, env, resource/time/output limits
 * and discovery adapter at one point in time.
 *
 * ## Candidate identity is bound to executed bytes
 *
 * The round-1 review found the runner accepted an arbitrary allowed root and
 * never compared the bytes it would execute to an approved digest. An approval
 * now names one exact **pinned input snapshot** (`root` + `digest`) selected by
 * the plan; `authorizeCheck` refuses any root not in the policy snapshot list and
 * carries the snapshot digest. `runCheck` re-derives the materialized digest and
 * refuses to launch when it differs (stale/tampered input), so a changed file or
 * a different root with the same policy can never wear the approved identity.
 *
 * ## A candidate plan can narrow, never widen
 *
 * The policy owns the image allowlist (with pinned digests), the pinned input
 * snapshots, the container cwd, the network mode (must be `none`), the env
 * allowlist, the resource/time/output ceilings and the known discovery adapters.
 * A plan may request a subset; anything outside those bounds — an unlisted
 * image, a wider timeout/output, an unlisted cwd or env key, a secret-named env
 * key, an unlisted input root, an unknown discovery adapter or a discovery
 * adapter pinned to a different command — is denied with an explicit reason.
 * Capability probing is fail-closed: a missing, unknown or unsupported required
 * control denies authorization, and there is **no** privileged/unconfined
 * fallback.
 *
 * ## Discovery is verifier-owned bytes but a nondecisive observation
 *
 * A discovery adapter with `source: "verifier-harness"` pins the runner's
 * verifier-owned harness bytes via `harnessDigest`; a `"candidate"` adapter is
 * raw candidate stdout. Neither is decisive for suite completeness: the harness
 * executes the candidate test module in the SAME process, so an untrusted
 * candidate can forge the counts (`os.write`/`os._exit`, monkeypatching
 * `json.dumps`/`unittest.TestResult`). Counts are therefore recorded as a benign
 * framework observation only and can never yield `PASS`/`FAIL`. Approved skips
 * are a policy-owned number, never read from candidate stdout.
 */

import { z } from "zod";
import { ID_PATTERN, LIMITS } from "./contracts.js";
import { VERIFIER_HARNESS_DIGEST } from "./harness.js";

/** Bumped whenever the policy/plan/approval shape changes incompatibly. */
export const POLICY_SCHEMA_VERSION = 2;

/** Fixed, non-configurable containment controls the runner enforces. */
export const RUN_USER = "65534:65534";
export const DEFAULT_INPUT_TARGET = "/input";

/** Hard ceilings a policy may never exceed. */
export const HARD_RESOURCE_LIMITS = {
  pids: 4096,
  memoryMb: 8192,
  cpus: 64,
  timeoutMs: 10 * 60_000,
  tmpfsMb: 1024,
  maxOutputBytes: 16 * 1024 * 1024,
} as const;
export const HARD_ARGV = 64;
export const HARD_ARG_LENGTH = 4096;
export const HARD_ENV_KEYS = 64;
export const HARD_ENV_VALUE = 65_536;

export type AuthorizationMode = "DISABLED" | "STATIC_ONLY" | "DOCKER";

/**
 * Observed state of one required containment control. Anything other than
 * `"supported"` (i.e. `"unknown"` or `"unsupported"`) fails closed.
 */
export type CapabilityState = "supported" | "unsupported" | "unknown";

export interface DockerCapabilities {
  /** True only when a real probe actually ran and produced this record. */
  probed: boolean;
  /** The exact `reference@sha256:...` image the probe self-tested against. */
  image: string;
  engine: {
    available: boolean;
    version?: string;
    os?: string;
    arch?: string;
    error?: string;
  };
  readOnlyRootfs: CapabilityState;
  capDropAll: CapabilityState;
  noNewPrivileges: CapabilityState;
  nonRootUser: CapabilityState;
  networkNone: CapabilityState;
  pidsLimit: CapabilityState;
  memoryLimit: CapabilityState;
  cpusLimit: CapabilityState;
  tmpfs: CapabilityState;
  notes: string[];
}

const IdSchema = z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN, {
  message: "id must match [A-Za-z0-9][A-Za-z0-9._:-]*",
});

export const ResourceLimitsSchema = z
  .object({
    pids: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.pids),
    memoryMb: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.memoryMb),
    cpus: z.number().positive().max(HARD_RESOURCE_LIMITS.cpus),
    timeoutMs: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.timeoutMs),
    tmpfsMb: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.tmpfsMb),
    maxOutputBytes: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.maxOutputBytes),
  })
  .strict();

export const PinnedImageSchema = z
  .object({
    reference: z.string().min(1).max(512),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

/**
 * A verifier-pinned input snapshot: an exact root plus the SHA-256 of the file
 * manifest that root materializes to. An approval binds one of these, and
 * `runCheck` re-derives the materialized digest and refuses to launch on a
 * mismatch.
 */
export const InputSnapshotSchema = z
  .object({
    root: z.string().min(1).max(LIMITS.maxPathLength),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const InputSnapshot = InputSnapshotSchema;
export type InputSnapshot = z.infer<typeof InputSnapshotSchema>;

/**
 * A known discovery adapter.
 *
 * `source: "verifier-harness"` means the counts come from the verifier-owned
 * harness whose bytes are pinned by `harnessDigest`; `source: "candidate"` is
 * raw candidate stdout. Both are **nondecisive**: the harness shares a process
 * with the untrusted candidate, so its counts are a benign observation only and
 * can never certify suite completeness. `approvedSkips` is a verifier-owned
 * allowance and is never read from candidate stdout.
 */
export const DiscoveryAdapterSchema = z
  .object({
    source: z.enum(["verifier-harness", "candidate"]),
    argv: z
      .array(z.string().min(1).max(HARD_ARG_LENGTH))
      .min(1)
      .max(HARD_ARGV),
    parser: z.literal("json-counts-v1"),
    harnessDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    approvedSkips: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === "verifier-harness" && value.harnessDigest === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a verifier-harness discovery adapter requires harnessDigest",
        path: ["harnessDigest"],
      });
    }
    if (value.source === "candidate" && value.harnessDigest !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a candidate discovery adapter must not claim a harness digest",
        path: ["harnessDigest"],
      });
    }
  });

const ABSOLUTE_POSIX_PATH = /^\/[A-Za-z0-9._/-]*$/;

export const AuditPolicySchema = z
  .object({
    schemaVersion: z.literal(POLICY_SCHEMA_VERSION),
    mode: z.enum(["DISABLED", "STATIC_ONLY", "DOCKER"]),
    images: z.array(PinnedImageSchema).max(32),
    inputSnapshots: z.array(InputSnapshotSchema).max(16),
    inputMountTarget: z.string().min(2).max(256).regex(ABSOLUTE_POSIX_PATH),
    network: z.literal("none"),
    cwd: z.string().min(1).max(LIMITS.maxPathLength).regex(ABSOLUTE_POSIX_PATH),
    envAllowlist: z
      .array(z.string().min(1).max(128))
      .max(HARD_ENV_KEYS),
    resources: ResourceLimitsSchema,
    discoveryAdapters: z.record(IdSchema, DiscoveryAdapterSchema),
  })
  .strict();

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type PinnedImage = z.infer<typeof PinnedImageSchema>;
export type DiscoveryAdapter = z.infer<typeof DiscoveryAdapterSchema>;
export type AuditPolicy = z.infer<typeof AuditPolicySchema>;

export const CheckPlanSchema = z
  .object({
    checkId: IdSchema,
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    argv: z
      .array(z.string().min(1).max(HARD_ARG_LENGTH))
      .max(HARD_ARGV),
    cwd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
    image: z.string().min(1).max(512),
    inputRoot: z.string().min(1).max(LIMITS.maxPathLength),
    env: z.record(z.string().min(1).max(128), z.string().max(HARD_ENV_VALUE)).optional(),
    timeoutMs: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.timeoutMs).optional(),
    maxOutputBytes: z.number().int().min(1).max(HARD_RESOURCE_LIMITS.maxOutputBytes).optional(),
    discovery: z.object({ adapter: IdSchema }).strict().optional(),
  })
  .strict();

export type CheckPlan = z.infer<typeof CheckPlanSchema>;

/** The resolved, capacity-checked discovery binding carried by an approval. */
export interface ApprovedDiscovery {
  readonly adapterId: string;
  readonly source: "verifier-harness" | "candidate";
  readonly argv: readonly string[];
  readonly parser: "json-counts-v1";
  readonly approvedSkips: number;
  readonly harnessDigest?: string;
}

/** A frozen, deeply-immutable, non-forgeable authorization to run one check. */
export interface ApprovedCheck {
  readonly checkId: string;
  readonly taskId: string;
  readonly taskRevision: string;
  readonly candidateId: string;
  readonly criterionIds: readonly string[];
  readonly imageReference: string;
  readonly imageDigest: string;
  /** Fully qualified `reference@sha256:...` passed to Docker. */
  readonly image: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly network: "none";
  readonly inputMountTarget: string;
  readonly inputReadOnly: true;
  readonly user: string;
  readonly resources: Readonly<ResourceLimits>;
  /** The exact verifier-pinned input root this approval is bound to. */
  readonly inputRoot: string;
  /** The pinned SHA-256 of the input root's file manifest. */
  readonly inputDigest: string;
  readonly discovery?: ApprovedDiscovery;
}

export interface AuthorizationResult {
  authorized: boolean;
  approved?: ApprovedCheck;
  reasons: string[];
}

/**
 * Module-private registry of approved checks. There is no exported way to add to
 * it, so an `ApprovedCheck` cannot be forged from JSON or a plain object.
 */
const approvedChecks = new WeakSet<object>();

/** True only for an object actually produced by `authorizeCheck`. */
export function isApprovedCheck(value: unknown): value is ApprovedCheck {
  return typeof value === "object" && value !== null && approvedChecks.has(value);
}

/** Recursively freeze a value so a holder cannot widen an already-issued approval. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Required containment controls, in report order. */
const REQUIRED_CAPABILITIES = [
  ["readOnlyRootfs", "READ_ONLY_ROOTFS"],
  ["capDropAll", "CAP_DROP_ALL"],
  ["noNewPrivileges", "NO_NEW_PRIVILEGES"],
  ["nonRootUser", "NON_ROOT_USER"],
  ["networkNone", "NETWORK_NONE"],
  ["pidsLimit", "PIDS_LIMIT"],
  ["memoryLimit", "MEMORY_LIMIT"],
  ["cpusLimit", "CPUS_LIMIT"],
  ["tmpfs", "TMPFS"],
] as const;

const SECRET_NAME_PATTERN =
  /(?:api[_-]?key|apikey|secret|token|passwd|password|pwd|authorization|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|bearer)/i;

/** The explicit, most restrictive default: execution disabled. */
export const DEFAULT_AUDIT_POLICY: AuditPolicy = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  mode: "DISABLED",
  images: [],
  inputSnapshots: [],
  inputMountTarget: DEFAULT_INPUT_TARGET,
  network: "none",
  cwd: DEFAULT_INPUT_TARGET,
  envAllowlist: [],
  resources: {
    pids: 64,
    memoryMb: 128,
    cpus: 1,
    timeoutMs: 30_000,
    tmpfsMb: 8,
    maxOutputBytes: 65_536,
  },
  discoveryAdapters: {},
}) as AuditPolicy;

function parsePolicy(value: unknown): { ok: true; policy: AuditPolicy } | { ok: false; reasons: string[] } {
  const result = AuditPolicySchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      reasons: [
        "INVALID_POLICY",
        ...result.error.issues.map((issue) => `INVALID_POLICY:${issue.path.join(".")}`),
      ],
    };
  }
  return { ok: true, policy: result.data };
}

function parsePlan(
  value: unknown,
): { ok: true; plan: CheckPlan } | { ok: false; reasons: string[] } {
  const result = CheckPlanSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      reasons: [
        "INVALID_PLAN",
        ...result.error.issues.map((issue) => `INVALID_PLAN:${issue.path.join(".")}`),
      ],
    };
  }
  return { ok: true, plan: result.data };
}

function capabilityReasons(capabilities: DockerCapabilities | undefined): string[] {
  if (!capabilities || capabilities.probed !== true) return ["CAPABILITY_NOT_PROBED"];
  const reasons: string[] = [];
  if (!capabilities.engine || capabilities.engine.available !== true) {
    reasons.push(`ENGINE_UNAVAILABLE:${capabilities.engine?.error ?? "not available"}`);
  }
  for (const [key, label] of REQUIRED_CAPABILITIES) {
    const state = capabilities[key];
    if (state === "unknown") reasons.push(`CAPABILITY_UNKNOWN:${label}`);
    else if (state !== "supported") reasons.push(`CAPABILITY_UNSUPPORTED:${label}`);
  }
  return reasons;
}

function isUnderCwd(target: string, allowed: string): boolean {
  return target === allowed || target.startsWith(`${allowed}/`) || target === "/tmp" || target.startsWith("/tmp/");
}

function canonicalKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return canonicalKey(a) === canonicalKey(b);
}

/**
 * Authorize one candidate check against a verifier-owned policy.
 *
 * Returns an opaque capability on success. Any validation, capability or
 * policy-widening problem yields `authorized: false` with explicit reasons and
 * never a partial approval.
 */
export function authorizeCheck(
  planInput: unknown,
  policyInput: unknown,
  capabilities: DockerCapabilities | undefined,
): AuthorizationResult {
  const policyResult = parsePolicy(policyInput);
  if (!policyResult.ok) return { authorized: false, reasons: policyResult.reasons };
  const policy = policyResult.policy;

  if (policy.mode === "DISABLED") return { authorized: false, reasons: ["POLICY_DISABLED"] };
  if (policy.mode === "STATIC_ONLY") return { authorized: false, reasons: ["POLICY_STATIC_ONLY"] };

  const planResult = parsePlan(planInput);
  if (!planResult.ok) return { authorized: false, reasons: planResult.reasons };
  const plan = planResult.plan;

  const reasons: string[] = [];

  const caps = capabilityReasons(capabilities);
  reasons.push(...caps);

  // Image must be an allowlisted reference, optionally digest-checked.
  const [requestedReference, requestedDigest] = plan.image.split("@");
  const pinned = policy.images.find((image) => image.reference === requestedReference);
  let resolvedImage: string | undefined;
  if (!pinned) {
    reasons.push("IMAGE_NOT_ALLOWED");
  } else {
    if (requestedDigest !== undefined && requestedDigest !== pinned.digest) {
      reasons.push("IMAGE_DIGEST_MISMATCH");
    }
    resolvedImage = `${pinned.reference}@${pinned.digest}`;
  }

  // The plan must name one of the verifier-pinned input snapshots exactly.
  const snapshot = policy.inputSnapshots.find((entry) => samePath(entry.root, plan.inputRoot));
  if (!snapshot) reasons.push("INPUT_NOT_ALLOWED");

  // The probed capabilities must have been observed against the same image.
  if (resolvedImage !== undefined && capabilities?.image !== resolvedImage) {
    reasons.push("CAPABILITY_IMAGE_MISMATCH");
  }

  // argv must be a non-empty array of control-character-free strings.
  if (plan.argv.length === 0) reasons.push("ARGV_EMPTY");
  for (const arg of plan.argv) {
    if (/[\u0000-\u001f\u007f]/.test(arg)) {
      reasons.push("ARGV_CONTROL_CHARACTER");
      break;
    }
  }

  // Env keys must be non-secret and explicitly allowlisted.
  for (const key of Object.keys(plan.env ?? {})) {
    if (SECRET_NAME_PATTERN.test(key)) reasons.push(`ENV_SECRET_KEY:${key}`);
    else if (!policy.envAllowlist.includes(key)) reasons.push(`ENV_KEY_NOT_ALLOWED:${key}`);
  }

  // Time/output may only narrow the policy ceiling.
  if (plan.timeoutMs !== undefined && plan.timeoutMs > policy.resources.timeoutMs) {
    reasons.push("TIMEOUT_OUT_OF_BOUNDS");
  }
  if (plan.maxOutputBytes !== undefined && plan.maxOutputBytes > policy.resources.maxOutputBytes) {
    reasons.push("OUTPUT_LIMIT_OUT_OF_BOUNDS");
  }

  const cwd = plan.cwd ?? policy.cwd;
  if (!isUnderCwd(cwd, policy.inputMountTarget)) reasons.push("CWD_NOT_ALLOWED");

  // Discovery is only bound from the exact pinned command of a known adapter.
  // A verifier-harness adapter additionally pins the harness bytes; neither
  // source is decisive for suite completeness (see the module header).
  let discovery: ApprovedDiscovery | undefined;
  if (plan.discovery) {
    const adapter = policy.discoveryAdapters[plan.discovery.adapter];
    if (!adapter) {
      reasons.push("DISCOVERY_ADAPTER_UNKNOWN");
    } else if (
      adapter.argv.length !== plan.argv.length ||
      adapter.argv.some((arg, index) => arg !== plan.argv[index])
    ) {
      reasons.push("DISCOVERY_ARGV_MISMATCH");
    } else if (adapter.source === "verifier-harness" && adapter.harnessDigest !== VERIFIER_HARNESS_DIGEST) {
      reasons.push("DISCOVERY_HARNESS_MISMATCH");
    } else {
      discovery = {
        adapterId: plan.discovery.adapter,
        source: adapter.source,
        argv: [...adapter.argv],
        parser: adapter.parser,
        approvedSkips: adapter.approvedSkips ?? 0,
        ...(adapter.harnessDigest !== undefined ? { harnessDigest: adapter.harnessDigest } : {}),
      };
    }
  }

  if (reasons.length > 0) return { authorized: false, reasons };

  const resources: ResourceLimits = {
    pids: policy.resources.pids,
    memoryMb: policy.resources.memoryMb,
    cpus: policy.resources.cpus,
    timeoutMs: Math.min(plan.timeoutMs ?? policy.resources.timeoutMs, policy.resources.timeoutMs),
    tmpfsMb: policy.resources.tmpfsMb,
    maxOutputBytes: Math.min(
      plan.maxOutputBytes ?? policy.resources.maxOutputBytes,
      policy.resources.maxOutputBytes,
    ),
  };

  const approved = deepFreeze({
    checkId: plan.checkId,
    taskId: plan.taskId,
    taskRevision: plan.taskRevision,
    candidateId: plan.candidateId,
    criterionIds: [...plan.criterionIds],
    imageReference: pinned!.reference,
    imageDigest: pinned!.digest,
    image: resolvedImage!,
    argv: [...plan.argv],
    cwd,
    env: { ...(plan.env ?? {}) },
    network: "none" as const,
    inputMountTarget: policy.inputMountTarget,
    inputReadOnly: true as const,
    user: RUN_USER,
    resources,
    inputRoot: snapshot!.root,
    inputDigest: snapshot!.digest,
    ...(discovery ? { discovery } : {}),
  } satisfies ApprovedCheck & object) as ApprovedCheck;

  approvedChecks.add(approved);
  return { authorized: true, approved, reasons: [] };
}
