/**
 * Task 4 — optional authorized disposable runner. RED first.
 *
 * Covers the round-1 repair:
 *   - candidate identity is bound to the approved snapshot digest and root;
 *   - the scratch directory is exclusively reserved and never deleted on a
 *     preexisting path; overlapping input/work/store roots are refused;
 *   - cleanup is verified and a cleanup failure downgrades a completed verdict;
 *   - only a real, registered probe for the exact approved image can execute.
 *
 * Round-2 repair (same-process harness spoof):
 *   - the candidate test module executes in the SAME Python process as the
 *     verifier harness, so its `unittest`/`json`/`os`/`sys` machinery is
 *     mutable by the candidate. Counts parsed from that process are therefore
 *     a **benign framework observation only** and are never decisive for suite
 *     completeness: a discovery run can never be COMPLETED/PASS or
 *     COMPLETED/FAIL from those counts, only COMPLETED/INCONCLUSIVE;
 *   - the harness sink is bounded (candidate flood cannot grow memory without
 *     bound) and reports an overflow observation;
 *   - the production probe exposes no executor seam; the executor-injectable
 *     seam is a separate trusted-code/test-only function.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AUDIT_POLICY,
  authorizeCheck,
  isApprovedCheck,
  type AuditPolicy,
  type CheckPlan,
  type DockerCapabilities,
} from "../../src/audit/policy.js";
import {
  RunnerError,
  classifyContainerInspectAbsence,
  classifyContainerRemoval,
  collectInputFiles,
  isProbedCapabilities,
  materializeInput,
  parseDiscoveryCounts,
  parseHarnessObservation,
  probeDockerCapabilities,
  probeDockerCapabilitiesWithExecutor,
  runCheck,
  type BoundedResult,
  type CleanupResult,
  type DockerExecutor,
  type DockerRunRequest,
  type RemovalProbe,
  type RunnerContext,
} from "../../src/audit/runner.js";
import { VERIFIER_HARNESS_DIGEST } from "../../src/audit/harness.js";

setDefaultTimeout(30_000);

const WORKSPACE = process.cwd();
const FIXTURES = join(WORKSPACE, "audit-build", "task4-fixtures");
const SCRATCH = join(FIXTURES, "test-scratch");
const WORK = join(SCRATCH, "work");
const ALLOWED = join(SCRATCH, "allowed-root");
const NOT_ALLOWED = join(SCRATCH, "not-allowed-root");
const STORE_ROOT = join(SCRATCH, "protected-store");
const IMAGE_DIGEST = "sha256:2c941e860699f878900b0edc2403613c234d4b32eda3cc9fa7036991a2a63c4a";
const IMAGE_REFERENCE = "python:3.12-slim";
const IMAGE = `${IMAGE_REFERENCE}@${IMAGE_DIGEST}`;
const HARNESS_ARGV = ["python3", "/input/.t4-verifier/harness.py", "--json-counts", "/input/check.py"];
let seq = 0;

function freshDir(base: string, name: string): string {
  mkdirSync(base, { recursive: true });
  const dir = join(base, `${name}-${process.pid}-${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A module-level canonical snapshot used by pure authorize tests.
const BASE_ROOT = freshDir(ALLOWED, "base");
writeFileSync(join(BASE_ROOT, "check.py"), "print('{}')\n");
const BASE_DIGEST = collectInputFiles(BASE_ROOT).digest;

mkdirSync(STORE_ROOT, { recursive: true });
writeFileSync(join(STORE_ROOT, "canary.txt"), "protected\n");

function makeCaps(overrides: Partial<DockerCapabilities> = {}): DockerCapabilities {
  return {
    probed: true,
    image: IMAGE,
    engine: { available: true, version: "29.6.2", os: "linux", arch: "amd64" },
    readOnlyRootfs: "supported",
    capDropAll: "supported",
    noNewPrivileges: "supported",
    nonRootUser: "supported",
    networkNone: "supported",
    pidsLimit: "supported",
    memoryLimit: "supported",
    cpusLimit: "supported",
    tmpfs: "supported",
    notes: [],
    ...overrides,
  };
}

function makePolicy(overrides: Partial<AuditPolicy> = {}): AuditPolicy {
  return {
    schemaVersion: 2,
    mode: "DOCKER",
    images: [{ reference: IMAGE_REFERENCE, digest: IMAGE_DIGEST }],
    inputSnapshots: [{ root: BASE_ROOT, digest: BASE_DIGEST }],
    inputMountTarget: "/input",
    network: "none",
    cwd: "/input",
    envAllowlist: ["T4_ALLOWED"],
    resources: {
      pids: 64,
      memoryMb: 128,
      cpus: 1,
      timeoutMs: 30_000,
      tmpfsMb: 8,
      maxOutputBytes: 65_536,
    },
    discoveryAdapters: {
      "fixture-check": {
        source: "verifier-harness",
        argv: HARNESS_ARGV,
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
    },
    ...overrides,
  };
}

function makePolicyFor(root: string, overrides: Partial<AuditPolicy> = {}): AuditPolicy {
  return makePolicy({ inputSnapshots: [{ root, digest: collectInputFiles(root).digest }], ...overrides });
}

function makePlan(overrides: Partial<CheckPlan> = {}): CheckPlan {
  return {
    checkId: "chk-1",
    taskId: "task-4",
    taskRevision: "rev-1",
    candidateId: "cand-1",
    criterionIds: ["req-1"],
    argv: HARNESS_ARGV,
    image: IMAGE_REFERENCE,
    inputRoot: BASE_ROOT,
    timeoutMs: 10_000,
    maxOutputBytes: 32_768,
    discovery: { adapter: "fixture-check" },
    ...overrides,
  };
}

interface RunCall extends DockerRunRequest {
  args: string[];
}

class FakeExecutor implements DockerExecutor {
  readonly calls: RunCall[] = [];
  readonly removals: string[] = [];
  readonly envs: Array<Record<string, string>> = [];
  cleanupResult: CleanupResult = { ok: true };
  result: BoundedResult = {
    exitCode: 0,
    signal: null,
    stdout: '{"collected":3,"passed":3,"failed":0,"skipped":0}\n',
    stderr: "",
    stdoutBytes: 47,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    cancelled: false,
  };

  async run(request: DockerRunRequest): Promise<BoundedResult> {
    this.calls.push({ ...request, args: [...request.args] });
    this.envs.push({ ...request.env });
    return { ...this.result };
  }

  async removeContainer(name: string): Promise<CleanupResult> {
    this.removals.push(name);
    return { ...this.cleanupResult };
  }
}

const DEFAULT_OBSERVATION: Record<string, unknown> = {
  uid: 65534,
  nopriv: "1",
  capEff: "0000000000000000",
  rootWrite: "denied",
  net: "blocked",
  pidsMax: "64",
  memMax: String(128 * 1024 * 1024),
  cpuMax: "100000 100000",
  tmpTmpfs: true,
};

class FakeProbeExecutor implements DockerExecutor {
  constructor(private readonly observation: Record<string, unknown> = DEFAULT_OBSERVATION) {}

  async run(request: DockerRunRequest): Promise<BoundedResult> {
    if (request.args[0] === "version") {
      return {
        exitCode: 0,
        signal: null,
        stdout: "29.6.2|linux|amd64\n",
        stderr: "",
        stdoutBytes: 18,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        cancelled: false,
      };
    }
    const stdout = `${JSON.stringify(this.observation)}\n`;
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      stdoutBytes: stdout.length,
      stderrBytes: 0,
      truncated: false,
      timedOut: false,
      cancelled: false,
    };
  }

  async removeContainer(): Promise<CleanupResult> {
    return { ok: true };
  }
}

const PROBED_CAPS = await probeDockerCapabilitiesWithExecutor(new FakeProbeExecutor(), { image: IMAGE });

function makeInputRoot(name: string): string {
  const root = freshDir(ALLOWED, name);
  writeFileSync(join(root, "check.py"), 'print("{}")\n');
  return root;
}

function makeContext(root: string, executor: FakeExecutor, extra: Partial<RunnerContext> = {}): RunnerContext {
  return {
    inputRoot: root,
    workRoot: freshDir(WORK, "work"),
    storeRoot: STORE_ROOT,
    capabilities: PROBED_CAPS,
    docker: executor,
    ...extra,
  };
}

async function approve(plan: CheckPlan, policy = makePolicy(), caps = makeCaps()) {
  const result = authorizeCheck(plan, policy, caps);
  if (!result.authorized) {
    throw new Error(`unexpected denial: ${result.reasons.join(",")}`);
  }
  return result.approved;
}

async function approveFor(
  root: string,
  planOverrides: Partial<CheckPlan> = {},
  policyOverrides: Partial<AuditPolicy> = {},
) {
  const policy = makePolicyFor(root, policyOverrides);
  const plan = makePlan({ inputRoot: root, ...planOverrides });
  return approve(plan, policy);
}

function mountSourceOf(call: RunCall): string {
  return call.args[call.args.indexOf("--mount") + 1]!;
}

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe("authorizeCheck: default disabled / static only", () => {
  test("the default policy denies every check as disabled", () => {
    const result = authorizeCheck(makePlan(), DEFAULT_AUDIT_POLICY, makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("POLICY_DISABLED");
  });

  test("a static-only policy refuses execution even when capabilities are present", () => {
    const result = authorizeCheck(makePlan(), makePolicy({ mode: "STATIC_ONLY" }), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("POLICY_STATIC_ONLY");
  });

  test("malformed plan and policy are rejected, never coerced", () => {
    const badPlan = authorizeCheck({ checkId: 42 } as unknown, makePolicy(), makeCaps());
    expect(badPlan.authorized).toBe(false);
    expect(badPlan.reasons).toContain("INVALID_PLAN");
    const badPolicy = authorizeCheck(makePlan(), { mode: "DOCKER" } as unknown, makeCaps());
    expect(badPolicy.authorized).toBe(false);
    expect(badPolicy.reasons).toContain("INVALID_POLICY");
  });
});

describe("authorizeCheck: capability fail-closed", () => {
  test("an unprobed capability set denies", () => {
    const result = authorizeCheck(makePlan(), makePolicy(), makeCaps({ probed: false }));
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("CAPABILITY_NOT_PROBED");
  });

  test("an unavailable engine denies", () => {
    const result = authorizeCheck(
      makePlan(),
      makePolicy(),
      makeCaps({ engine: { available: false, error: "cannot connect" } }),
    );
    expect(result.authorized).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("ENGINE_UNAVAILABLE"))).toBe(true);
  });

  for (const [name, key] of [
    ["read-only rootfs", "readOnlyRootfs"],
    ["cap-drop all", "capDropAll"],
    ["no-new-privileges", "noNewPrivileges"],
    ["non-root user", "nonRootUser"],
    ["network none", "networkNone"],
    ["pids limit", "pidsLimit"],
    ["memory limit", "memoryLimit"],
    ["cpu limit", "cpusLimit"],
    ["tmpfs", "tmpfs"],
  ] as const) {
    test(`${name} unknown blocks authorization`, () => {
      const result = authorizeCheck(makePlan(), makePolicy(), makeCaps({ [key]: "unknown" }));
      expect(result.authorized).toBe(false);
      expect(result.reasons.some((r) => r.includes("CAPABILITY_UNKNOWN"))).toBe(true);
    });
    test(`${name} unsupported blocks authorization`, () => {
      const result = authorizeCheck(makePlan(), makePolicy(), makeCaps({ [key]: "unsupported" }));
      expect(result.authorized).toBe(false);
      expect(result.reasons.some((r) => r.includes("CAPABILITY_UNSUPPORTED"))).toBe(true);
    });
  }

  test("all required capabilities supported authorizes and returns an opaque check", () => {
    const result = authorizeCheck(makePlan(), makePolicy(), makeCaps());
    expect(result.authorized).toBe(true);
    expect(result.approved!.image).toBe(IMAGE);
    expect(result.approved!.network).toBe("none");
    expect(result.approved!.user).toBe("65534:65534");
    expect(result.approved!.argv).toEqual(HARNESS_ARGV);
  });

  test("a probe observed against a different image blocks authorization", () => {
    const result = authorizeCheck(makePlan(), makePolicy(), makeCaps({ image: "other:latest@sha256:" + "b".repeat(64) }));
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("CAPABILITY_IMAGE_MISMATCH");
  });
});

describe("authorizeCheck: candidate cannot widen policy", () => {
  test("an image outside the allowlist is denied", () => {
    const result = authorizeCheck(makePlan({ image: "ubuntu:latest" }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("IMAGE_NOT_ALLOWED");
  });

  test("an image with a mismatched digest is denied", () => {
    const plan = makePlan({ image: `${IMAGE_REFERENCE}@sha256:${"a".repeat(64)}` });
    const result = authorizeCheck(plan, makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("IMAGE_DIGEST_MISMATCH");
  });

  test("an env key outside the allowlist is denied", () => {
    const result = authorizeCheck(makePlan({ env: { EVIL: "1" } }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("ENV_KEY_NOT_ALLOWED"))).toBe(true);
  });

  test("a secret-named env key is denied even if allowlisted", () => {
    const policy = makePolicy({ envAllowlist: ["T4_ALLOWED", "API_TOKEN"] });
    const result = authorizeCheck(makePlan({ env: { API_TOKEN: "s" } }), policy, makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("ENV_SECRET_KEY"))).toBe(true);
  });

  test("a timeout above the policy bound is denied", () => {
    const result = authorizeCheck(makePlan({ timeoutMs: 60_000 }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("TIMEOUT_OUT_OF_BOUNDS");
  });

  test("an output bound above the policy bound is denied", () => {
    const result = authorizeCheck(makePlan({ maxOutputBytes: 1_000_000 }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("OUTPUT_LIMIT_OUT_OF_BOUNDS");
  });

  test("a cwd outside the input mount is denied", () => {
    const result = authorizeCheck(makePlan({ cwd: "/etc" }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("CWD_NOT_ALLOWED");
  });

  test("empty argv is denied", () => {
    const result = authorizeCheck(makePlan({ argv: [] }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("ARGV_EMPTY");
  });

  test("an argv element containing a NUL byte is denied", () => {
    const result = authorizeCheck(makePlan({ argv: ["python3", "a\u0000b"] }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("ARGV_CONTROL_CHARACTER");
  });

  test("an unknown discovery adapter is denied", () => {
    const result = authorizeCheck(makePlan({ discovery: { adapter: "nope" } }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("DISCOVERY_ADAPTER_UNKNOWN");
  });

  test("discovery counts are only parsed from the pinned command", () => {
    const result = authorizeCheck(
      makePlan({ argv: ["python3", "/input/other.py"], discovery: { adapter: "fixture-check" } }),
      makePolicy(),
      makeCaps(),
    );
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("DISCOVERY_ARGV_MISMATCH");
  });

  test("an input root that is not a pinned snapshot is denied", () => {
    const result = authorizeCheck(makePlan({ inputRoot: NOT_ALLOWED }), makePolicy(), makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("INPUT_NOT_ALLOWED");
  });

  test("a verifier-harness adapter with a mismatched harness digest is denied", () => {
    const policy = makePolicy({
      discoveryAdapters: {
        "fixture-check": {
          source: "verifier-harness",
          argv: HARNESS_ARGV,
          parser: "json-counts-v1",
          harnessDigest: `sha256:${"c".repeat(64)}`,
        },
      },
    });
    const result = authorizeCheck(makePlan(), policy, makeCaps());
    expect(result.authorized).toBe(false);
    expect(result.reasons).toContain("DISCOVERY_HARNESS_MISMATCH");
  });

  test("approval binds the exact snapshot root and digest", () => {
    const root = makeInputRoot("bind");
    const policy = makePolicyFor(root);
    const result = authorizeCheck(makePlan({ inputRoot: root }), policy, makeCaps());
    expect(result.authorized).toBe(true);
    expect(result.approved!.inputRoot).toBe(root);
    expect(result.approved!.inputDigest).toBe(collectInputFiles(root).digest);
  });
});

describe("runCheck: forged approval / capability cannot authorize", () => {
  test("a JSON-shaped approval object is refused", async () => {
    const executor = new FakeExecutor();
    const ctx = makeContext(makeInputRoot("forged"), executor);
    await expect(
      runCheck({ authorized: true, mode: "DOCKER" } as never, ctx),
    ).rejects.toThrow(RunnerError);
    expect(executor.calls.length).toBe(0);
  });

  test("a structurally complete but forged ApprovedCheck is refused", async () => {
    const executor = new FakeExecutor();
    const ctx = makeContext(makeInputRoot("forged2"), executor);
    const forged = {
      checkId: "chk-1",
      taskId: "task-4",
      taskRevision: "rev-1",
      candidateId: "cand-1",
      criterionIds: ["req-1"],
      image: IMAGE,
      imageReference: IMAGE_REFERENCE,
      imageDigest: IMAGE_DIGEST,
      argv: HARNESS_ARGV,
      cwd: "/input",
      env: {},
      network: "none",
      inputMountTarget: "/input",
      inputReadOnly: true,
      user: "65534:65534",
      resources: { pids: 64, memoryMb: 128, cpus: 1, timeoutMs: 1000, tmpfsMb: 8, maxOutputBytes: 1024 },
      inputRoot: BASE_ROOT,
      inputDigest: BASE_DIGEST,
    } as never;
    await expect(runCheck(forged, ctx)).rejects.toThrow(RunnerError);
    expect(executor.calls.length).toBe(0);
  });

  test("a forged capabilities object is refused at the runner boundary", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("forgedcaps");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor, { capabilities: makeCaps() });
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });
});

describe("runCheck: identity-bound bytes", () => {
  test("a file mutated after approval blocks the run as stale", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("stale");
    const approved = await approveFor(root);
    writeFileSync(join(root, "check.py"), "print('changed')\n");
    const ctx = makeContext(root, executor);
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(receipt.result).toBe("UNKNOWN");
    expect(receipt.limitations.some((l) => /stale/i.test(l))).toBe(true);
    expect(executor.calls.length).toBe(0);
  });

  test("a different root cannot impersonate the approved snapshot", async () => {
    const executor = new FakeExecutor();
    const rootA = makeInputRoot("root-a");
    const rootB = makeInputRoot("root-b");
    writeFileSync(join(rootB, "check.py"), "print('different')\n");
    const approved = await approveFor(rootA);
    const ctx = makeContext(rootB, executor);
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });

  test("the approved bytes are the exact bytes mounted (verified before launch)", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("exact");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor);
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.source).toContain(approved.inputDigest);
  });
});

describe("runCheck: docker-only, hardened argv, sanitized env", () => {
  test("the candidate argv is passed as separate args, never shell-joined", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("args");
    const approved = await approveFor(root, {
      argv: ["python3", "-c", "print('a;b && c $(x)')"],
      discovery: undefined,
    });
    await runCheck(approved, makeContext(root, executor));
    const args = executor.calls[0]!.args;
    expect(args).toContain("python3");
    expect(args).toContain("-c");
    expect(args).toContain("print('a;b && c $(x)')");
  });

  test("hardening flags are present and no privileged/unconfined fallback is used", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("flags");
    const approved = await approveFor(root);
    await runCheck(approved, makeContext(root, executor));
    const args = executor.calls[0]!.args.join(" ");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--network none");
    expect(args).toContain("--user 65534:65534");
    expect(args).toContain(`@${IMAGE_DIGEST}`);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("unconfined");
    expect(args).not.toContain("--userns");
    expect(args).not.toContain("network host");
    expect(args).not.toContain("--pid host");
  });

  test("exactly one read-only input mount is used and the store is never mounted", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("mount");
    const approved = await approveFor(root);
    await runCheck(approved, makeContext(root, executor));
    const args = executor.calls[0]!.args;
    const mounts = args.filter((a) => a === "--mount");
    expect(mounts.length).toBe(1);
    const mountArg = args[args.indexOf("--mount") + 1]!;
    expect(mountArg).toContain("type=bind");
    expect(mountArg).toContain("target=/input");
    expect(mountArg).toContain("readonly");
    expect(args.some((a) => a.includes(STORE_ROOT))).toBe(false);
  });

  test("the docker subprocess env never inherits host secrets", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("env");
    const prior = process.env.T4_FAKE_SECRET;
    process.env.T4_FAKE_SECRET = "super-secret";
    try {
      const approved = await approveFor(root);
      await runCheck(approved, makeContext(root, executor));
    } finally {
      if (prior === undefined) delete process.env.T4_FAKE_SECRET;
      else process.env.T4_FAKE_SECRET = prior;
    }
    const env = executor.envs[0]!;
    expect(env.T4_FAKE_SECRET).toBeUndefined();
    expect(Object.keys(env).some((k) => /secret/i.test(k))).toBe(false);
  });

  test("container env carries only the allowlisted plan keys", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("cenv");
    const approved = await approveFor(root, { env: { T4_ALLOWED: "yes" } });
    await runCheck(approved, makeContext(root, executor));
    const args = executor.calls[0]!.args;
    const envValues = args.filter((_, i) => args[i - 1] === "--env");
    expect(envValues).toContain("T4_ALLOWED=yes");
    expect(envValues.every((v) => v.startsWith("T4_ALLOWED="))).toBe(true);
  });
});

describe("runCheck: non-destructive owned scratch", () => {
  test("an input root different from the approved snapshot is blocked", async () => {
    const executor = new FakeExecutor();
    const outside = freshDir(NOT_ALLOWED, "input");
    writeFileSync(join(outside, "check.py"), "print('{}')\n");
    const approved = await approveFor(makeInputRoot("outside-ok"));
    const receipt = await runCheck(approved, makeContext(outside, executor));
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });

  test("a work root overlapping the input root is refused", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("overlap-input");
    const workInside = freshDir(root, "work");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor, { workRoot: workInside });
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });

  test("a work root overlapping the store root is refused", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("overlap-store");
    const workInsideStore = freshDir(STORE_ROOT, "work");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor, { workRoot: workInsideStore, storeRoot: STORE_ROOT });
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });

  test("a preexisting path in the work root is never deleted", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("canary");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor);
    const canary = join(ctx.workRoot, "canary.txt");
    writeFileSync(canary, "keep me\n");
    await runCheck(approved, ctx);
    expect(existsSync(canary)).toBe(true);
    const leftover = readdirSync(ctx.workRoot).filter((name) => name.startsWith("t4-run-"));
    expect(leftover).toEqual([]);
  });

  test("a symlinked work root is refused", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("symwork");
    const realWork = freshDir(WORK, "realwork");
    const link = join(WORK, `link-${process.pid}-${seq++}`);
    let linked = false;
    try {
      symlinkSync(realWork, link, "junction");
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) return;
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor, { workRoot: link });
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    expect(executor.calls.length).toBe(0);
  });

  test("concurrent runs of the same check use distinct owned directories", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("concurrent");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor);
    await runCheck(approved, ctx);
    await runCheck(approved, ctx);
    expect(executor.calls.length).toBe(2);
    expect(mountSourceOf(executor.calls[0]!)).not.toBe(mountSourceOf(executor.calls[1]!));
  });

  test("a blocked materialization leaves no owned scratch directory behind", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("partial");
    const approved = await approveFor(root);
    const ctx = makeContext(root, executor);
    writeFileSync(join(root, "check.py"), "print('mutated')\n");
    const receipt = await runCheck(approved, ctx);
    expect(receipt.completion).toBe("BLOCKED");
    const leftover = readdirSync(ctx.workRoot).filter((name) => name.startsWith("t4-run-"));
    expect(leftover).toEqual([]);
  });
});

describe("runCheck: real observations, discovery and bounded output", () => {
  test("same-process verifier-harness counts are recorded but are never a decisive PASS", async () => {
    const executor = new FakeExecutor();
    const root = makeInputRoot("pass");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.origin).toBe("RUNNER_CAPTURED");
    expect(receipt.kind).toBe("EXECUTION");
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.result).not.toBe("PASS");
    expect(receipt.exitCode).toBe(0);
    expect(receipt.discovery).toEqual({ collected: 3, passed: 3, failed: 0, skipped: 0 });
    expect(typeof receipt.startedAt).toBe("string");
    expect(typeof receipt.endedAt).toBe("string");
    expect(receipt.argv).toEqual(HARNESS_ARGV);
    expect(receipt.limitations!.some((l) => /nondecisive|same-process|untrusted/i.test(l))).toBe(true);
  });

  test("same-process failing-test counts are nondecisive (never a decisive FAIL)", async () => {
    const executor = new FakeExecutor();
    executor.result.exitCode = 1;
    executor.result.stdout = '{"collected":3,"passed":2,"failed":1,"skipped":0}\n';
    const root = makeInputRoot("fail");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.result).not.toBe("FAIL");
    expect(receipt.discovery?.failed).toBe(1);
    expect(receipt.limitations!.some((l) => /nondecisive|same-process|untrusted/i.test(l))).toBe(true);
  });

  test("a nonzero exit without discovery is a process failure, not a contradiction", async () => {
    const executor = new FakeExecutor();
    executor.result.exitCode = 2;
    executor.result.stdout = "";
    const root = makeInputRoot("nonzero");
    const approved = await approveFor(root, { discovery: undefined });
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("FAILED");
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.exitCode).toBe(2);
  });

  test("a zero-test suite can never prove completeness", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":0,"passed":0,"failed":0,"skipped":0}\n';
    const root = makeInputRoot("zero");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.discovery?.collected).toBe(0);
  });

  test("an all-skipped suite can never prove completeness", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":2,"passed":0,"failed":0,"skipped":2}\n';
    const root = makeInputRoot("skip");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.result).toBe("INCONCLUSIVE");
  });

  test("unparseable discovery stdout leaves discovery unknown, never a guess", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = "PASS\nall tests passed\n";
    const root = makeInputRoot("badjson");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.discovery).toBeUndefined();
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.completion).toBe("COMPLETED");
  });

  test("a candidate-sourced adapter is nondecisive even with green JSON", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":10,"passed":10,"failed":0,"skipped":0}\n';
    const root = makeInputRoot("candidate-adapter");
    const policy = makePolicyFor(root, {
      discoveryAdapters: {
        "candidate-check": {
          source: "candidate",
          argv: ["python3", "/input/check.py"],
          parser: "json-counts-v1",
        },
      },
    });
    const approved = await approve(
      makePlan({ inputRoot: root, argv: ["python3", "/input/check.py"], discovery: { adapter: "candidate-check" } }),
      policy,
    );
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.discovery).toBeUndefined();
  });

  test("truncated output can never certify a suite", async () => {
    const executor = new FakeExecutor();
    executor.result.truncated = true;
    executor.result.stdoutBytes = 999_999;
    const root = makeInputRoot("truncated");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.limitations!.some((l) => /truncat/i.test(l))).toBe(true);
  });

  test("policy-approved skips can waive exactly those skips, not more", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":3,"passed":2,"failed":0,"skipped":1}\n';
    const root = makeInputRoot("approved-skips");
    const policy = makePolicyFor(root, {
      discoveryAdapters: {
        "fixture-check": {
          source: "verifier-harness",
          argv: HARNESS_ARGV,
          parser: "json-counts-v1",
          harnessDigest: VERIFIER_HARNESS_DIGEST,
          approvedSkips: 1,
        },
      },
    });
    const approved = await approve(makePlan({ inputRoot: root }), policy);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.result).not.toBe("PASS");
    expect(receipt.discovery).toEqual({ collected: 3, passed: 2, failed: 0, skipped: 1, approvedSkips: 1 });
  });

  test("an output flood is bounded and visibly truncated", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = "x".repeat(200_000);
    executor.result.stdoutBytes = 200_000;
    executor.result.truncated = true;
    const root = makeInputRoot("flood");
    const approved = await approveFor(root, { discovery: undefined });
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect((receipt.output ?? "").length).toBeLessThanOrEqual(32_768);
    expect((receipt.limitations ?? []).some((l) => /truncat/i.test(l))).toBe(true);
  });

  test("a timeout records TIMEOUT and cleans up the exact container", async () => {
    const executor = new FakeExecutor();
    executor.result.timedOut = true;
    executor.result.exitCode = null;
    const root = makeInputRoot("timeout");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("TIMEOUT");
    expect(receipt.result).toBe("UNKNOWN");
    expect(executor.removals.length).toBe(1);
    expect(executor.removals[0]).toBe(executor.calls[0]!.containerName);
  });

  test("cancellation records CANCELLED and cleans up", async () => {
    const executor = new FakeExecutor();
    executor.result.cancelled = true;
    executor.result.exitCode = null;
    const root = makeInputRoot("cancel");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("CANCELLED");
    expect(executor.removals.length).toBe(1);
  });

  test("a docker spawn error records BLOCKED, not a pass", async () => {
    const executor = new FakeExecutor();
    executor.result.spawnError = "docker: command not found";
    executor.result.exitCode = null;
    const root = makeInputRoot("spawn");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("BLOCKED");
    expect(receipt.result).toBe("UNKNOWN");
  });
});

describe("runCheck: verified cleanup", () => {
  test("a cleanup failure downgrades a completed run to blocked", async () => {
    const executor = new FakeExecutor();
    executor.cleanupResult = { ok: false, detail: "docker rm denied" };
    const root = makeInputRoot("cleanup-fail");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("BLOCKED");
    expect(receipt.result).toBe("UNKNOWN");
    expect(receipt.limitations!.some((l) => /CLEANUP_FAILED/.test(l))).toBe(true);
  });

  test("a cleanup failure is visible on a timeout too", async () => {
    const executor = new FakeExecutor();
    executor.result.timedOut = true;
    executor.result.exitCode = null;
    executor.cleanupResult = { ok: false, detail: "still present" };
    const root = makeInputRoot("cleanup-timeout");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.limitations!.some((l) => /CLEANUP_FAILED/.test(l))).toBe(true);
  });
});

describe("container removal requires verified absence, not an ambiguous error", () => {
  const NAME = "t4-check-abc123";
  const ok = (overrides: Partial<RemovalProbe> = {}): RemovalProbe => ({
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  });
  const daemonDown: RemovalProbe = {
    status: 1,
    stdout: "",
    stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  };
  const permissionDenied: RemovalProbe = {
    status: 1,
    stdout: "",
    stderr: "permission denied while trying to connect to the Docker daemon socket",
  };
  const spawnError: RemovalProbe = {
    status: null,
    stdout: "",
    stderr: "",
    error: new Error("spawn docker ENOENT"),
  };

  test("a successful rm is verified removal", () => {
    expect(classifyContainerRemoval(NAME, ok(), daemonDown).ok).toBe(true);
  });

  test("rm failure with a daemon outage is NOT treated as absence", () => {
    const result = classifyContainerRemoval(NAME, daemonDown, daemonDown);
    expect(result.ok).toBe(false);
  });

  test("rm failure with a permission error is NOT treated as absence", () => {
    const result = classifyContainerRemoval(NAME, permissionDenied, permissionDenied);
    expect(result.ok).toBe(false);
  });

  test("rm failure with a spawn error is NOT treated as absence", () => {
    const result = classifyContainerRemoval(NAME, spawnError, spawnError);
    expect(result.ok).toBe(false);
  });

  test("rm failure plus a successful daemon query that omits the name is verified absence", () => {
    const result = classifyContainerRemoval(
      NAME,
      { status: 1, stdout: "", stderr: "rm error" },
      ok({ status: 0, stdout: "some-other-container\n" }),
    );
    expect(result.ok).toBe(true);
  });

  test("rm failure plus a daemon query that still lists the name is not absence", () => {
    const result = classifyContainerRemoval(
      NAME,
      { status: 1, stdout: "", stderr: "rm error" },
      ok({ status: 0, stdout: `other\n${NAME}\n` }),
    );
    expect(result.ok).toBe(false);
  });

  test("an explicit no-such-container inspect result is accepted absence", () => {
    const result = classifyContainerRemoval(
      NAME,
      { status: 1, stdout: "", stderr: "rm error" },
      { status: 1, stdout: "", stderr: `Error: No such object: ${NAME}` },
    );
    expect(result.ok).toBe(true);
  });
});

describe("final gap: an inspect id is not a container name", () => {
  test("final gap: an ambiguous daemon error is not verified container absence", () => {
    const rm = { status: 1, stdout: "", stderr: "permission denied" };
    const verify = { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    expect(classifyContainerRemoval("t4-owned", rm, verify).ok).toBe(false);
  });

  test("final gap: a successful exact-name listing establishes absence", () => {
    const rm = { status: 1, stdout: "", stderr: "removal failed" };
    const verify = { status: 0, stdout: "t4-other\n", stderr: "" };
    expect(classifyContainerRemoval("t4-owned", rm, verify).ok).toBe(true);
  });

  test("final gap: a successful listing that still names the container is cleanup failure", () => {
    const rm = { status: 1, stdout: "", stderr: "removal failed" };
    const verify = { status: 0, stdout: "t4-owned\n", stderr: "" };
    expect(classifyContainerRemoval("t4-owned", rm, verify).ok).toBe(false);
  });

  test("final gap: a successful inspect returning an id is treated as present, not absent", () => {
    const inspect = { status: 0, stdout: "d0c4b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8\n", stderr: "" };
    expect(classifyContainerInspectAbsence(inspect).ok).toBe(false);
  });

  test("final gap: an explicit no-such-object inspect is verified absence", () => {
    const inspect = { status: 1, stdout: "", stderr: "Error: No such object: t4-owned" };
    expect(classifyContainerInspectAbsence(inspect).ok).toBe(true);
  });

  test("final gap: an ambiguous inspect error is not verified absence", () => {
    const inspect = { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" };
    expect(classifyContainerInspectAbsence(inspect).ok).toBe(false);
  });
});

describe("input materialization: bounded, secret-free, link-free, non-destructive", () => {
  test("collectInputFiles excludes secrets, .git, verifier storage and the reserved dir", () => {
    const root = freshDir(ALLOWED, "collect");
    writeFileSync(join(root, "check.py"), "print('x')\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, "id_rsa"), "PRIVATE\n");
    writeFileSync(join(root, "credentials.json"), "{}\n");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "url\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep.js"), "x\n");
    mkdirSync(join(root, ".t4-verifier"), { recursive: true });
    writeFileSync(join(root, ".t4-verifier", "harness.py"), "EVIL\n");
    const collected = collectInputFiles(root);
    const paths = collected.files.map((f) => f.path).sort();
    expect(paths).toEqual(["check.py"]);
    const reasons = collected.excluded.map((e) => e.path);
    expect(reasons).toContain(".env");
    expect(reasons).toContain("id_rsa");
    expect(reasons).toContain("credentials.json");
    expect(reasons.some((p) => p.startsWith(".git"))).toBe(true);
    expect(reasons.some((p) => p.startsWith(".t4-verifier"))).toBe(true);
    expect(collected.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("materializeInput copies only the collected files and records the digest", () => {
    const root = freshDir(ALLOWED, "materialize");
    writeFileSync(join(root, "check.py"), "print('x')\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const dest = freshDir(WORK, "dest");
    const result = materializeInput(root, join(dest, "input"));
    const copied = readdirSync(join(dest, "input")).sort();
    expect(copied).toEqual(["check.py"]);
    expect(existsSync(join(dest, "input", ".env"))).toBe(false);
    expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("materializeInput never deletes a preexisting destination", () => {
    const root = freshDir(ALLOWED, "nodestroy");
    writeFileSync(join(root, "check.py"), "print('x')\n");
    const dest = freshDir(WORK, "nodestroy-dest");
    writeFileSync(join(dest, "canary.txt"), "keep\n");
    expect(() => materializeInput(root, dest)).toThrow(RunnerError);
    expect(existsSync(join(dest, "canary.txt"))).toBe(true);
  });

  test("materializeInput fails closed when the expected digest does not match", () => {
    const root = freshDir(ALLOWED, "digestcheck");
    writeFileSync(join(root, "check.py"), "print('x')\n");
    const dest = freshDir(WORK, "digestcheck-dest");
    expect(() =>
      materializeInput(root, join(dest, "input"), { expectedDigest: `sha256:${"d".repeat(64)}` }),
    ).toThrow(RunnerError);
    expect(existsSync(join(dest, "input"))).toBe(false);
  });

  test("a symlinked input component is rejected, never followed", () => {
    const root = freshDir(ALLOWED, "symlink");
    writeFileSync(join(root, "check.py"), "print('x')\n");
    let linked = false;
    try {
      symlinkSync(join(root, "check.py"), join(root, "alias.py"), "file");
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) return;
    expect(() => collectInputFiles(root)).toThrow(RunnerError);
  });

  test("an oversized input file fails closed", () => {
    const root = freshDir(ALLOWED, "oversize");
    writeFileSync(join(root, "big.bin"), Buffer.alloc(1024));
    expect(() => collectInputFiles(root, { maxFileBytes: 16 })).toThrow(RunnerError);
  });
});

describe("discovery parsing and approval immutability", () => {
  test("parseDiscoveryCounts never reads approvedSkips from candidate output", () => {
    const parsed = parseDiscoveryCounts(
      '{"collected":2,"passed":0,"failed":0,"skipped":2,"approvedSkips":2}\n',
    );
    expect(parsed).toEqual({ collected: 2, passed: 0, failed: 0, skipped: 2 });
  });

  test("an approval is deeply frozen", async () => {
    const root = makeInputRoot("frozen");
    const approved = await approveFor(root);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(Object.isFrozen(approved.resources)).toBe(true);
    expect(Object.isFrozen(approved.env)).toBe(true);
    expect(Object.isFrozen(approved.argv)).toBe(true);
    expect(Object.isFrozen(approved.criterionIds)).toBe(true);
    expect(isApprovedCheck(approved)).toBe(true);
  });

  test("mutating a policy after authorization cannot broaden the approved run", () => {
    const policy = makePolicyFor(BASE_ROOT);
    const result = authorizeCheck(makePlan({ inputRoot: BASE_ROOT, env: { T4_ALLOWED: "yes" } }), policy, makeCaps());
    expect(result.authorized).toBe(true);
    const approved = result.approved!;
    const approvedOutput = approved.resources.maxOutputBytes;
    (policy.images as Array<{ reference: string; digest: string }>).push({
      reference: "evil:latest",
      digest: `sha256:${"a".repeat(64)}`,
    });
    (policy.envAllowlist as string[]).push("EVIL");
    (policy.resources as { maxOutputBytes: number }).maxOutputBytes = 999_999;
    expect(approved.resources.maxOutputBytes).toBe(approvedOutput);
    expect(approved.env.EVIL).toBeUndefined();
    expect(approved.image).toBe(IMAGE);
  });
});

describe("round-2: same-process counts are nondecisive; overflow is observed", () => {
  test("a candidate that forges the final count line and exits early cannot force PASS", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":9,"passed":9,"failed":0,"skipped":0}\n';
    executor.result.exitCode = 0;
    const root = makeInputRoot("forged-final");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.completion).toBe("COMPLETED");
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.result).not.toBe("PASS");
  });

  test("a candidate that monkeypatches the framework counts cannot force PASS", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":7,"passed":7,"failed":0,"skipped":0}\n';
    executor.result.exitCode = 0;
    const root = makeInputRoot("monkeypatch");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.result).not.toBe("PASS");
    expect(receipt.limitations!.some((l) => /nondecisive|same-process|untrusted|forge/i.test(l))).toBe(true);
  });

  test("parseHarnessObservation surfaces the bounded-sink overflow observation", () => {
    const observation = parseHarnessObservation(
      '{"collected":1,"passed":1,"failed":0,"skipped":0,"overflow":true}\n',
    );
    expect(observation?.counts).toEqual({ collected: 1, passed: 1, failed: 0, skipped: 0 });
    expect(observation?.overflow).toBe(true);
    expect(parseDiscoveryCounts('{"collected":2,"passed":2,"failed":0,"skipped":0}\n')).toEqual({
      collected: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
    });
  });

  test("a harness overflow is recorded as a visible observation and stays nondecisive", async () => {
    const executor = new FakeExecutor();
    executor.result.stdout = '{"collected":1,"passed":1,"failed":0,"skipped":0,"overflow":true}\n';
    executor.result.exitCode = 0;
    const root = makeInputRoot("harness-overflow");
    const approved = await approveFor(root);
    const receipt = await runCheck(approved, makeContext(root, executor));
    expect(receipt.result).toBe("INCONCLUSIVE");
    expect(receipt.limitations!.some((l) => /overflow/i.test(l))).toBe(true);
  });
});

describe("probe: registered, image-bound, fail-closed on malformed observations", () => {
  test("a real probe result is registered and a plain object is not", () => {
    expect(isProbedCapabilities(PROBED_CAPS)).toBe(true);
    expect(isProbedCapabilities(makeCaps())).toBe(false);
  });

  test("an observed numeric nonzero uid is supported", () => {
    expect(PROBED_CAPS.nonRootUser).toBe("supported");
    expect(PROBED_CAPS.image).toBe(IMAGE);
  });

  test("a malformed (missing) uid observation is unknown, not supported", async () => {
    const { uid, ...withoutUid } = DEFAULT_OBSERVATION;
    void uid;
    const caps = await probeDockerCapabilitiesWithExecutor(new FakeProbeExecutor(withoutUid), { image: IMAGE });
    expect(caps.nonRootUser).toBe("unknown");
  });

  test("a uid of zero is unsupported", async () => {
    const caps = await probeDockerCapabilitiesWithExecutor(
      new FakeProbeExecutor({ ...DEFAULT_OBSERVATION, uid: 0 }),
      { image: IMAGE },
    );
    expect(caps.nonRootUser).toBe("unsupported");
  });

  test("a non-string capability observation is unknown", async () => {
    const caps = await probeDockerCapabilitiesWithExecutor(
      new FakeProbeExecutor({ ...DEFAULT_OBSERVATION, capEff: 0 }),
      { image: IMAGE },
    );
    expect(caps.capDropAll).toBe("unknown");
  });

  test("the production probe exposes no executor seam; the seam is a separate trusted-code function", () => {
    // A model-facing caller cannot inject an executor into the production probe,
    // so it cannot acquire a registered capability set from forged observations.
    // The injectable seam is verifier/test-only code and is never re-exported by
    // the public package entry.
    expect(probeDockerCapabilities.length).toBe(1);
    expect(typeof probeDockerCapabilitiesWithExecutor).toBe("function");
    expect(probeDockerCapabilitiesWithExecutor).not.toBe(probeDockerCapabilities);
  });
});
