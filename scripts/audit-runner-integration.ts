/**
 * Task 4 — REAL Docker integration evidence for the authorized disposable runner.
 *
 * This script is the end-to-end proof that the runner works against an actual
 * Docker engine. It does not trust mocks or flags:
 *
 *   1. it probes the engine and actually runs a self-test container under the
 *      exact hardening controls, observing uid / CapEff / NoNewPrivs / readonly
 *      rootfs / network / cgroup limits inside the container;
 *   2. it runs the committed fixtures only inside the container and records real
 *      exits, discovery counts, bounded output and verified cleanup;
 *   3. it exercises denial (unapproved image/cwd/adapter, missing capability,
 *      forged capability set, stale input, overlapping work root), timeout,
 *      cancellation and a read-only, store-less, network-less escape attempt;
 *   4. it proves NO same-process discovery is decisive: a candidate adapter that
 *      prints green JSON is INCONCLUSIVE; a candidate-supplied reserved harness
 *      is ignored; and real adversarial fixtures that forge the final count line
 *      (`os.write` + `os._exit`), monkeypatch `json.dumps` /
 *      `unittest.TestResult`, or flood the harness sink are all COMPLETED but
 *      INCONCLUSIVE, never PASS/FAIL;
 *   5. it `docker create`s an identical container and `docker inspect`s the real
 *      HostConfig, so containment is shown from actual configuration, not flags.
 *
 * Fixtures, work and any protected store live strictly under
 * `audit-build/task4-fixtures`. Total wall time is bounded well under five
 * minutes by per-probe timeouts. No home/credential reads; no pull.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_AUDIT_POLICY,
  authorizeCheck,
  type AuditPolicy,
  type CheckPlan,
  type DockerCapabilities,
  type InputSnapshot,
} from "../src/audit/policy.js";
import {
  collectInputFiles,
  isProbedCapabilities,
  nodeDockerExecutor,
  probeDockerCapabilities,
  runCheck,
  type RunnerContext,
} from "../src/audit/runner.js";
import { VERIFIER_HARNESS_DIGEST } from "../src/audit/harness.js";

const WORKSPACE = process.cwd();
const FIXTURES = join(WORKSPACE, "audit-build", "task4-fixtures");
const INPUT = join(FIXTURES, "fixture");
const ROOT = join(FIXTURES, "integration");
const WORK = join(ROOT, "work");
const STORE = join(ROOT, "protected-store");
const LOGS = join(WORKSPACE, "audit-build", "logs");
const IMAGE_REFERENCE = "python:3.12-slim";
const CONTAINER_PREFIX = "t4-";
const MOUNTED_HARNESS = "/input/.t4-verifier/harness.py";

function harnessArgv(testFile: string): string[] {
  return ["python3", MOUNTED_HARNESS, "--json-counts", `/input/${testFile}`];
}

interface Scenario {
  name: string;
  category: string;
  ok: boolean;
  detail: unknown;
}

const scenarios: Scenario[] = [];
const notes: string[] = [];

function record(name: string, category: string, ok: boolean, detail: unknown): void {
  scenarios.push({ name, category, ok, detail });
  const marker = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`[${marker}] ${category}: ${name}`);
}

function docker(args: string[], timeout = 30_000) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? "").toString().trim(),
    stderr: (result.stderr ?? "").toString().trim(),
    error: result.error?.message,
  };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function leftoverContainers(): string[] {
  const result = docker(["ps", "-a", "--format", "{{.Names}}"], 20_000);
  if (result.status !== 0) return ["<docker ps failed>"];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => name.startsWith(CONTAINER_PREFIX));
}

function imageDigest(): string | null {
  const result = docker(["image", "inspect", IMAGE_REFERENCE, "--format", "{{json .RepoDigests}}"], 30_000);
  if (result.status !== 0) return null;
  try {
    const digests = JSON.parse(result.stdout) as string[];
    const repository = IMAGE_REFERENCE.split(":")[0]!;
    const repoDigest = digests.find((entry) => entry.startsWith(`${repository}@sha256:`));
    if (!repoDigest) return null;
    return repoDigest.slice(repoDigest.indexOf("@") + 1);
  } catch {
    return null;
  }
}

function makeContext(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    inputRoot: INPUT,
    workRoot: WORK,
    storeRoot: STORE,
    capabilities: capabilityProbe,
    docker: nodeDockerExecutor,
    ...overrides,
  };
}

let capabilityProbe: DockerCapabilities;

function makePolicy(imageDigest: string, inputDigest: string, extraSnapshots: InputSnapshot[] = []): AuditPolicy {
  return {
    schemaVersion: 2,
    mode: "DOCKER",
    images: [{ reference: IMAGE_REFERENCE, digest: imageDigest }],
    inputSnapshots: [{ root: INPUT, digest: inputDigest }, ...extraSnapshots],
    inputMountTarget: "/input",
    network: "none",
    cwd: "/input",
    envAllowlist: ["T4_ALLOWED"],
    resources: {
      pids: 64,
      memoryMb: 128,
      cpus: 1,
      timeoutMs: 20_000,
      tmpfsMb: 8,
      maxOutputBytes: 65_536,
    },
    discoveryAdapters: {
      "fixture-check": {
        source: "verifier-harness",
        argv: harnessArgv("check.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-fail": {
        source: "verifier-harness",
        argv: harnessArgv("fail.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-zero": {
        source: "verifier-harness",
        argv: harnessArgv("zero.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-skip": {
        source: "verifier-harness",
        argv: harnessArgv("skip.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "candidate-spoof": {
        source: "candidate",
        argv: ["python3", "/input/spoof.py"],
        parser: "json-counts-v1",
      },
      "fixture-write-exit": {
        source: "verifier-harness",
        argv: harnessArgv("harness_write_exit.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-mp-json": {
        source: "verifier-harness",
        argv: harnessArgv("harness_mp_json.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-mp-result": {
        source: "verifier-harness",
        argv: harnessArgv("harness_mp_result.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
      "fixture-flood-harness": {
        source: "verifier-harness",
        argv: harnessArgv("harness_flood.py"),
        parser: "json-counts-v1",
        harnessDigest: VERIFIER_HARNESS_DIGEST,
      },
    },
  };
}

function makePlan(overrides: Partial<CheckPlan> = {}): CheckPlan {
  return {
    checkId: "chk-int-1",
    taskId: "task-4",
    taskRevision: "rev-1",
    candidateId: "cand-int-1",
    criterionIds: ["req-1"],
    argv: harnessArgv("check.py"),
    image: IMAGE_REFERENCE,
    inputRoot: INPUT,
    timeoutMs: 15_000,
    maxOutputBytes: 8192,
    discovery: { adapter: "fixture-check" },
    ...overrides,
  };
}

async function main(): Promise<number> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(INPUT, { recursive: true });
  mkdirSync(STORE, { recursive: true });
  writeFileSync(join(STORE, "canary.txt"), "protected store must stay unreachable\n");

  const requiredFixtures = [
    "check.py",
    "fail.py",
    "zero.py",
    "skip.py",
    "spoof.py",
    "flood.py",
    "escape.py",
    "sleep.py",
    "harness_write_exit.py",
    "harness_mp_json.py",
    "harness_mp_result.py",
    "harness_flood.py",
  ];
  const missingFixtures = requiredFixtures.filter((name) => !existsSync(join(INPUT, name)));
  if (missingFixtures.length > 0) {
    record("required fixtures present", "fixtures", false, missingFixtures);
    return finish(false);
  }
  record("required fixtures present", "fixtures", true, requiredFixtures);

  const storeCanaryBefore = sha256File(join(STORE, "canary.txt"));
  const inputHashBefore = sha256File(join(INPUT, "check.py"));

  // --- 0. engine -----------------------------------------------------------
  const version = docker(["version", "--format", "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"], 30_000);
  record("docker version", "engine", version.status === 0, version.stdout || version.stderr);
  const security = docker(["info", "--format", "{{.SecurityOptions}}|cgroup={{.CgroupVersion}}"], 30_000);
  record("docker security options", "engine", security.status === 0, security.stdout || security.stderr);

  const digest = imageDigest();
  if (!digest) {
    record("pinned image digest", "engine", false, `${IMAGE_REFERENCE} has no local RepoDigest; refusing to invent one`);
    return finish(false);
  }
  record("pinned image digest", "engine", true, `${IMAGE_REFERENCE}@${digest}`);
  const image = `${IMAGE_REFERENCE}@${digest}`;

  // --- 1. capability probe (real self-test container) ----------------------
  capabilityProbe = await probeDockerCapabilities({ image, timeoutMs: 30_000 });
  const capsOk =
    capabilityProbe.probed &&
    capabilityProbe.engine.available &&
    isProbedCapabilities(capabilityProbe) &&
    [
      capabilityProbe.readOnlyRootfs,
      capabilityProbe.capDropAll,
      capabilityProbe.noNewPrivileges,
      capabilityProbe.nonRootUser,
      capabilityProbe.networkNone,
      capabilityProbe.pidsLimit,
      capabilityProbe.memoryLimit,
      capabilityProbe.cpusLimit,
      capabilityProbe.tmpfs,
    ].every((state) => state === "supported");
  record("capability probe (real self-test)", "containment", capsOk, capabilityProbe);
  if (!capabilityProbe.engine.available) {
    notes.push("engine unavailable: cannot run live scenarios");
    return finish(false);
  }

  const inputDigest = collectInputFiles(INPUT).digest;
  const policy = makePolicy(digest, inputDigest);
  const blockedPolicy = { ...policy, mode: "DISABLED" as const };

  // --- 2. default/disabled policy denies -----------------------------------
  const disabled = authorizeCheck(makePlan(), DEFAULT_AUDIT_POLICY, capabilityProbe);
  record(
    "default DISABLED policy denies",
    "authorization",
    !disabled.authorized && disabled.reasons.includes("POLICY_DISABLED"),
    disabled.reasons,
  );
  const staticOnly = authorizeCheck(makePlan(), blockedPolicy, capabilityProbe);
  record(
    "DISABLED policy refuses execution",
    "authorization",
    !staticOnly.authorized && staticOnly.reasons.includes("POLICY_DISABLED"),
    staticOnly.reasons,
  );

  // --- 3. widening / escape denials ----------------------------------------
  const imageDenied = authorizeCheck(makePlan({ image: "ubuntu:latest" }), policy, capabilityProbe);
  record("unapproved image denied", "denial", !imageDenied.authorized && imageDenied.reasons.includes("IMAGE_NOT_ALLOWED"), imageDenied.reasons);
  const cwdDenied = authorizeCheck(makePlan({ cwd: "/etc" }), policy, capabilityProbe);
  record("out-of-scope cwd denied", "denial", !cwdDenied.authorized && cwdDenied.reasons.includes("CWD_NOT_ALLOWED"), cwdDenied.reasons);
  const adapterDenied = authorizeCheck(makePlan({ discovery: { adapter: "nope" } }), policy, capabilityProbe);
  record(
    "unknown discovery adapter denied",
    "denial",
    !adapterDenied.authorized && adapterDenied.reasons.includes("DISCOVERY_ADAPTER_UNKNOWN"),
    adapterDenied.reasons,
  );
  const mismatchDenied = authorizeCheck(
    makePlan({ argv: ["python3", "/input/other.py"], discovery: { adapter: "fixture-check" } }),
    policy,
    capabilityProbe,
  );
  record(
    "discovery pinned-command mismatch denied",
    "denial",
    !mismatchDenied.authorized && mismatchDenied.reasons.includes("DISCOVERY_ARGV_MISMATCH"),
    mismatchDenied.reasons,
  );
  const rootDenied = authorizeCheck(makePlan({ inputRoot: join(ROOT, "elsewhere") }), policy, capabilityProbe);
  record(
    "unlisted input root denied",
    "denial",
    !rootDenied.authorized && rootDenied.reasons.includes("INPUT_NOT_ALLOWED"),
    rootDenied.reasons,
  );

  // --- 4. missing capability fails closed ----------------------------------
  const missingCaps: DockerCapabilities = { ...capabilityProbe, networkNone: "unknown" };
  const capDenied = authorizeCheck(makePlan(), policy, missingCaps);
  record(
    "missing capability blocks authorization",
    "denial",
    !capDenied.authorized && capDenied.reasons.some((reason) => reason.includes("CAPABILITY_UNKNOWN")),
    capDenied.reasons,
  );

  // --- 5. success (verifier harness) ---------------------------------------
  const goodApproval = authorizeCheck(makePlan(), policy, capabilityProbe);
  if (!goodApproval.authorized || !goodApproval.approved) {
    record("authorize success check", "authorization", false, goodApproval.reasons);
    return finish(false);
  }
  const leftBefore = leftoverContainers();
  const successReceipt = await runCheck(goodApproval.approved, makeContext());
  const leftAfterSuccess = leftoverContainers();
  record(
    "same-process verifier-harness suite: COMPLETED/INCONCLUSIVE, counts nondecisive",
    "execution",
    successReceipt.completion === "COMPLETED" &&
      successReceipt.result === "INCONCLUSIVE" &&
      successReceipt.discovery?.passed === 3 &&
      successReceipt.discovery?.collected === 3 &&
      successReceipt.exitCode === 0 &&
      (successReceipt.limitations ?? []).some((line) => /nondecisive/i.test(line)),
    successReceipt,
  );
  record(
    "no owned container left after success",
    "cleanup",
    leftAfterSuccess.filter((name) => !leftBefore.includes(name)).length === 0,
    { leftBefore, leftAfterSuccess },
  );

  // --- 6. failing suite ----------------------------------------------------
  const failApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-fail", argv: harnessArgv("fail.py"), discovery: { adapter: "fixture-fail" } }),
    policy,
    capabilityProbe,
  );
  const failReceipt = failApproval.authorized ? await runCheck(failApproval.approved!, makeContext()) : null;
  record(
    "failing-suite counts are a nondecisive observation (INCONCLUSIVE, never FAIL)",
    "execution",
    failReceipt?.completion === "COMPLETED" &&
      failReceipt?.result === "INCONCLUSIVE" &&
      failReceipt?.discovery?.failed === 1,
    failReceipt,
  );

  // --- 7. zero / skip suites cannot prove completeness ---------------------
  const zeroApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-zero", argv: harnessArgv("zero.py"), discovery: { adapter: "fixture-zero" } }),
    policy,
    capabilityProbe,
  );
  const zeroReceipt = zeroApproval.authorized ? await runCheck(zeroApproval.approved!, makeContext()) : null;
  record(
    "zero-test suite INCONCLUSIVE",
    "execution",
    zeroReceipt?.completion === "COMPLETED" && zeroReceipt?.result === "INCONCLUSIVE" && zeroReceipt?.discovery?.collected === 0,
    zeroReceipt,
  );
  const skipApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-skip", argv: harnessArgv("skip.py"), discovery: { adapter: "fixture-skip" } }),
    policy,
    capabilityProbe,
  );
  const skipReceipt = skipApproval.authorized ? await runCheck(skipApproval.approved!, makeContext()) : null;
  record(
    "all-skipped suite INCONCLUSIVE",
    "execution",
    skipReceipt?.completion === "COMPLETED" && skipReceipt?.result === "INCONCLUSIVE",
    skipReceipt,
  );

  // --- 8. candidate adapter is nondecisive even when it prints green JSON ---
  const spoofApproval = authorizeCheck(
    makePlan({
      checkId: "chk-int-spoof",
      argv: ["python3", "/input/spoof.py"],
      discovery: { adapter: "candidate-spoof" },
    }),
    policy,
    capabilityProbe,
  );
  const spoofReceipt = spoofApproval.authorized ? await runCheck(spoofApproval.approved!, makeContext()) : null;
  record(
    "candidate-printed green JSON is nondecisive (INCONCLUSIVE)",
    "discovery",
    spoofReceipt?.completion === "COMPLETED" &&
      spoofReceipt?.result === "INCONCLUSIVE" &&
      spoofReceipt?.discovery === undefined,
    spoofReceipt,
  );

  // --- 8b. a candidate cannot replace the verifier-owned harness -----------
  const tamperInput = join(ROOT, "tamper-input");
  mkdirSync(join(tamperInput, ".t4-verifier"), { recursive: true });
  cpSync(join(INPUT, "check.py"), join(tamperInput, "check.py"));
  writeFileSync(
    join(tamperInput, ".t4-verifier", "harness.py"),
    "import json,sys\nprint(json.dumps({'collected':99,'passed':99,'failed':0,'skipped':0}))\n",
  );
  const tamperDigest = collectInputFiles(tamperInput).digest;
  const tamperPolicy = makePolicy(digest, inputDigest, [{ root: tamperInput, digest: tamperDigest }]);
  const tamperApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-tamper", inputRoot: tamperInput }),
    tamperPolicy,
    capabilityProbe,
  );
  const tamperReceipt = tamperApproval.authorized
    ? await runCheck(tamperApproval.approved!, makeContext({ inputRoot: tamperInput }))
    : null;
  record(
    "candidate-supplied reserved harness is ignored (real harness counts, still nondecisive)",
    "discovery",
    tamperReceipt?.result === "INCONCLUSIVE" &&
      tamperReceipt?.discovery?.collected === 3 &&
      tamperReceipt?.discovery?.passed === 3,
    tamperReceipt,
  );

  // --- 8c. same-process harness spoofs are nondecisive (REAL Docker) --------
  const spoofFixtures: Array<[string, string]> = [
    ["harness_write_exit.py", "fixture-write-exit"],
    ["harness_mp_json.py", "fixture-mp-json"],
    ["harness_mp_result.py", "fixture-mp-result"],
  ];
  for (const [file, adapter] of spoofFixtures) {
    const approval = authorizeCheck(
      makePlan({ checkId: `chk-int-${adapter}`, argv: harnessArgv(file), discovery: { adapter } }),
      policy,
      capabilityProbe,
    );
    const receipt = approval.authorized ? await runCheck(approval.approved!, makeContext()) : null;
    record(
      `same-process spoof ${file} never yields PASS/FAIL (INCONCLUSIVE)`,
      "discovery",
      receipt?.completion === "COMPLETED" &&
        receipt?.result === "INCONCLUSIVE" &&
        (receipt?.limitations ?? []).some((line) => /nondecisive/i.test(line)),
      receipt,
    );
  }

  // --- 8d. candidate output flood inside the harness is bounded -------------
  const harnessFloodApproval = authorizeCheck(
    makePlan({
      checkId: "chk-int-harness-flood",
      argv: harnessArgv("harness_flood.py"),
      discovery: { adapter: "fixture-flood-harness" },
    }),
    policy,
    capabilityProbe,
  );
  const harnessFloodReceipt = harnessFloodApproval.authorized
    ? await runCheck(harnessFloodApproval.approved!, makeContext())
    : null;
  record(
    "candidate flood inside the harness is bounded and reports overflow",
    "bounds",
    harnessFloodReceipt?.result === "INCONCLUSIVE" &&
      (harnessFloodReceipt?.limitations ?? []).some((line) => /overflow/i.test(line)),
    { result: harnessFloodReceipt?.result, limitations: harnessFloodReceipt?.limitations },
  );

  // --- 9. stale input snapshot cannot execute ------------------------------
  const staleInput = join(ROOT, "stale-input");
  mkdirSync(staleInput, { recursive: true });
  cpSync(join(INPUT, "check.py"), join(staleInput, "check.py"));
  const staleDigest = collectInputFiles(staleInput).digest;
  const stalePolicy = makePolicy(digest, inputDigest, [{ root: staleInput, digest: staleDigest }]);
  const staleApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-stale", inputRoot: staleInput }),
    stalePolicy,
    capabilityProbe,
  );
  writeFileSync(join(staleInput, "check.py"), "print('mutated after approval')\n");
  const staleLeftBefore = leftoverContainers();
  const staleReceipt = staleApproval.authorized
    ? await runCheck(staleApproval.approved!, makeContext({ inputRoot: staleInput }))
    : null;
  const staleLeftAfter = leftoverContainers();
  record(
    "mutated input after approval is blocked as stale",
    "identity",
    staleReceipt?.completion === "BLOCKED" &&
      staleLeftAfter.filter((name) => !staleLeftBefore.includes(name)).length === 0,
    staleReceipt,
  );

  // --- 10. overlapping work root is refused --------------------------------
  const overlapRoot = join(ROOT, "overlap-root");
  mkdirSync(overlapRoot, { recursive: true });
  cpSync(join(INPUT, "check.py"), join(overlapRoot, "check.py"));
  const overlapDigest = collectInputFiles(overlapRoot).digest;
  const overlapPolicy = makePolicy(digest, inputDigest, [{ root: overlapRoot, digest: overlapDigest }]);
  const overlapApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-overlap", inputRoot: overlapRoot }),
    overlapPolicy,
    capabilityProbe,
  );
  const overlapReceipt = overlapApproval.authorized
    ? await runCheck(overlapApproval.approved!, makeContext({ inputRoot: overlapRoot, workRoot: overlapRoot }))
    : null;
  record(
    "work root overlapping the input root is refused",
    "identity",
    overlapReceipt?.completion === "BLOCKED",
    overlapReceipt,
  );

  // --- 11. a preexisting work path is never deleted ------------------------
  const canaryWork = join(ROOT, "canary-work");
  mkdirSync(canaryWork, { recursive: true });
  writeFileSync(join(canaryWork, "canary.txt"), "keep\n");
  const canaryApproval = authorizeCheck(makePlan({ checkId: "chk-int-canary" }), policy, capabilityProbe);
  const canaryReceipt = canaryApproval.authorized
    ? await runCheck(canaryApproval.approved!, makeContext({ workRoot: canaryWork }))
    : null;
  const canaryLeftovers = readdirSync(canaryWork).filter((name) => name.startsWith("t4-run-"));
  record(
    "preexisting work path survives and no owned scratch is left",
    "cleanup",
    canaryReceipt?.result === "INCONCLUSIVE" &&
      existsSync(join(canaryWork, "canary.txt")) &&
      canaryLeftovers.length === 0,
    { canaryLeftovers },
  );

  // --- 12. forged capability set is refused at the runner boundary ---------
  const forgedCaps = { ...capabilityProbe } as DockerCapabilities;
  const forgedLeftBefore = leftoverContainers();
  const forgedReceipt = goodApproval.approved
    ? await runCheck(goodApproval.approved, makeContext({ capabilities: forgedCaps }))
    : null;
  const forgedLeftAfter = leftoverContainers();
  record(
    "a forged capability object cannot authorize execution",
    "capability",
    forgedReceipt?.completion === "BLOCKED" &&
      forgedLeftAfter.filter((name) => !forgedLeftBefore.includes(name)).length === 0,
    forgedReceipt,
  );

  // --- 13. output flood is bounded -----------------------------------------
  const floodApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-flood", argv: ["python3", "/input/flood.py"], discovery: undefined, maxOutputBytes: 4096 }),
    policy,
    capabilityProbe,
  );
  const floodReceipt = floodApproval.authorized ? await runCheck(floodApproval.approved!, makeContext()) : null;
  record(
    "output flood bounded and visibly truncated",
    "bounds",
    !!floodReceipt &&
      (floodReceipt.output ?? "").length <= 4096 &&
      (floodReceipt.limitations ?? []).some((line) => /truncat/i.test(line)),
    { outputLength: (floodReceipt?.output ?? "").length, limitations: floodReceipt?.limitations },
  );

  // --- 14. timeout + cleanup -----------------------------------------------
  const timeoutApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-timeout", argv: ["python3", "/input/sleep.py"], discovery: undefined, timeoutMs: 5000 }),
    policy,
    capabilityProbe,
  );
  const leftBeforeTimeout = leftoverContainers();
  const timeoutStart = Date.now();
  const timeoutReceipt = timeoutApproval.authorized ? await runCheck(timeoutApproval.approved!, makeContext()) : null;
  const timeoutElapsed = Date.now() - timeoutStart;
  const leftAfterTimeout = leftoverContainers();
  record(
    "timeout recorded and bounded",
    "timeout",
    timeoutReceipt?.completion === "TIMEOUT" && timeoutElapsed < 30_000,
    { completion: timeoutReceipt?.completion, elapsedMs: timeoutElapsed },
  );
  record(
    "timeout removes the exact container",
    "cleanup",
    leftAfterTimeout.filter((name) => !leftBeforeTimeout.includes(name)).length === 0,
    { leftBeforeTimeout, leftAfterTimeout },
  );

  // --- 15. cancellation ----------------------------------------------------
  const cancelApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-cancel", argv: ["python3", "/input/sleep.py"], discovery: undefined, timeoutMs: 15_000 }),
    policy,
    capabilityProbe,
  );
  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 1500);
  const leftBeforeCancel = leftoverContainers();
  const cancelReceipt = cancelApproval.authorized
    ? await runCheck(cancelApproval.approved!, makeContext({ signal: controller.signal }))
    : null;
  clearTimeout(cancelTimer);
  const leftAfterCancel = leftoverContainers();
  record(
    "cancellation recorded and cleaned up",
    "cancellation",
    cancelReceipt?.completion === "CANCELLED" &&
      leftAfterCancel.filter((name) => !leftBeforeCancel.includes(name)).length === 0,
    { completion: cancelReceipt?.completion, leftAfterCancel },
  );

  // --- 16. real containment escape attempt ---------------------------------
  const escapeApproval = authorizeCheck(
    makePlan({ checkId: "chk-int-escape", argv: ["python3", "/input/escape.py"], discovery: undefined, timeoutMs: 15_000 }),
    policy,
    capabilityProbe,
  );
  const escapeReceipt = escapeApproval.authorized ? await runCheck(escapeApproval.approved!, makeContext()) : null;
  let escapeObservation: Record<string, unknown> | null = null;
  try {
    escapeObservation = JSON.parse((escapeReceipt?.output ?? "").trim().split(/\r?\n/).pop() ?? "null");
  } catch {
    escapeObservation = null;
  }
  const escapeOk =
    escapeObservation !== null &&
    String(escapeObservation.input_write).startsWith("denied") &&
    String(escapeObservation.root_write).startsWith("denied") &&
    String(escapeObservation.store_write).startsWith("denied") &&
    String(escapeObservation.store_listing).startsWith("absent") &&
    String(escapeObservation.network).startsWith("denied");
  record("container escape attempt denied (readonly/network/store)", "containment", escapeOk, escapeObservation);

  // --- 17. inspect the real docker configuration ---------------------------
  const inspectName = `${CONTAINER_PREFIX}inspect-${Date.now()}`;
  const mountSource = INPUT.replace(/\\/g, "/");
  const createArgs = [
    "create",
    "--name",
    inspectName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--memory-swap",
    "128m",
    "--cpus",
    "1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=8m",
    "--mount",
    `type=bind,source=${mountSource},target=/input,readonly`,
    image,
    "true",
  ];
  const created = docker(createArgs, 30_000);
  let inspectSummary: Record<string, unknown> | null = null;
  if (created.status === 0) {
    const inspected = docker(["inspect", inspectName, "--format", "{{json .HostConfig}}"], 30_000);
    if (inspected.status === 0) {
      try {
        const hostConfig = JSON.parse(inspected.stdout) as Record<string, unknown>;
        inspectSummary = {
          ReadonlyRootfs: hostConfig.ReadonlyRootfs,
          CapDrop: hostConfig.CapDrop,
          SecurityOpt: hostConfig.SecurityOpt,
          NetworkMode: hostConfig.NetworkMode,
          PidsLimit: hostConfig.PidsLimit,
          Memory: hostConfig.Memory,
          MemorySwap: hostConfig.MemorySwap,
          NanoCpus: hostConfig.NanoCpus,
          Tmpfs: hostConfig.Tmpfs,
          User: hostConfig.User,
          Privileged: hostConfig.Privileged,
          Binds: hostConfig.Binds,
        };
      } catch {
        inspectSummary = null;
      }
    }
    docker(["rm", "-f", inspectName], 20_000);
  }
  record(
    "inspect actual HostConfig (not inferred from flags)",
    "containment",
    inspectSummary !== null &&
      inspectSummary.ReadonlyRootfs === true &&
      inspectSummary.Privileged === false &&
      inspectSummary.NetworkMode === "none" &&
      Array.isArray(inspectSummary.CapDrop) &&
      (inspectSummary.CapDrop as string[]).includes("ALL") &&
      (inspectSummary.SecurityOpt as string[])?.includes("no-new-privileges") === true,
    inspectSummary,
  );

  // --- 18. host state after runs -------------------------------------------
  const storeCanaryAfter = sha256File(join(STORE, "canary.txt"));
  const inputHashAfter = sha256File(join(INPUT, "check.py"));
  record("protected store unchanged", "files", storeCanaryBefore === storeCanaryAfter, { storeCanaryBefore, storeCanaryAfter });
  record("input fixture unchanged", "files", inputHashBefore === inputHashAfter, { inputHashBefore, inputHashAfter });
  const workEntries = existsSync(WORK) ? readdirSync(WORK) : [];
  record("no leftover input copies", "files", workEntries.length === 0, workEntries);
  const leftoverFinal = leftoverContainers();
  record("no owned containers at end", "cleanup", leftoverFinal.length === 0, leftoverFinal);

  return finish(scenarios.every((scenario) => scenario.ok));
}

function finish(ok: boolean): number {
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    ok,
    inputDigest: safeInputDigest(),
    harnessDigest: VERIFIER_HARNESS_DIGEST,
    capabilities: capabilityProbe ?? null,
    defaultPolicy: DEFAULT_AUDIT_POLICY,
    scenarios,
    notes,
  };
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(join(LOGS, "task4-integration.json"), `${JSON.stringify(report, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log(`\nIntegration ${ok ? "PASS" : "FAIL"}: ${scenarios.filter((s) => s.ok).length}/${scenarios.length} scenarios ok`);
  console.log(`Evidence: audit-build/logs/task4-integration.json`);
  return ok ? 0 : 1;
}

function safeInputDigest(): string | null {
  try {
    return collectInputFiles(INPUT).digest;
  } catch {
    return null;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
