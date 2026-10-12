/**
 * Task 3 — evidence ledger: provenance, bounds and trust. RED first.
 *
 * Every case is written against the still-absent `src/audit/evidence-store.ts`
 * and `src/audit/report.ts`, so the first run fails to import. GREEN only after
 * the provenance-safe, bounded, hash-chained, atomic ledger exists.
 *
 * Design invariants under test:
 *   - the store root is exclusively reserved, verifier-owned and outside the
 *     candidate; records use strict versioned schemas with atomic writes,
 *     collision/duplicate refusal and a terminal cancellation state;
 *   - a public imported receipt can never certify execution, even when it is
 *     structurally valid and claims `RUNNER_CAPTURED`; only an internal,
 *     non-exported capture authority can mark a capture, and no execution
 *     capture exists in this task;
 *   - opaque output refs resolve only inside the store, with path/link checks,
 *     bounded reads and digest validation — never arbitrary imported paths;
 *   - snapshot copied hashes are re-validated before artifact evidence is relied
 *     on; a manifest's self-hash alone is never enough;
 *   - output is redacted and bounded before anything is persisted, and the
 *     original secret is never retained in any store file;
 *   - a copied/forged ledger cannot reconstruct trust and fails closed.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as evidenceStoreModule from "../../src/audit/evidence-store.js";
import {
  EVIDENCE_STORE_SCHEMA_VERSION,
  EvidenceStoreError,
  appendCheck,
  assertPredicatePathsSecretFree,
  bindTask,
  collectArtifactObservation,
  createEvidenceStore,
  nodeEvidenceStoreIo,
  openEvidenceStore,
  readAudit,
  readOutputRef,
  StoredRecordSchema,
} from "../../src/audit/evidence-store.js";
import { replayAudit } from "../../src/audit/report.js";
import { captureSnapshot } from "../../src/audit/snapshot.js";
import type {
  CheckReceipt,
  EvidenceStore,
  EvidenceStoreIo,
} from "../../src/audit/evidence-store.js";
import type { SnapshotManifest } from "../../src/audit/snapshot.js";

setDefaultTimeout(30_000);

const WORKSPACE = process.cwd();
const FIXTURES = join(WORKSPACE, "audit-build", "evidence-fixtures");
const STORE_BASE = join(WORKSPACE, "audit-build", "evidence-store-output");
const TASK_ID = "task-3";
const TASK_REV = "rev-1";
let seq = 0;

function runGit(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`);
  }
  return result.stdout;
}

function freshDir(base: string, name: string): string {
  mkdirSync(base, { recursive: true });
  const dir = join(base, `${name}-${process.pid}-${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

function makeRepo(name: string): string {
  const dir = freshDir(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q", "-b", "main"]);
  runGit(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "base.txt"), "base content\n");
  writeFileSync(join(dir, "gone.txt"), "will be deleted\n");
  const identity = ["-c", "user.email=audit@test.local", "-c", "user.name=audit-test"];
  runGit(dir, [...identity, "add", "-A"]);
  runGit(dir, [...identity, "commit", "-qm", "init"]);
  rmSync(join(dir, "gone.txt"), { force: true });
  writeFileSync(join(dir, "artifact.txt"), "artifact payload\n");
  writeFileSync(join(dir, "changed.txt"), "changed payload\n");
  return dir;
}

async function createStore(
  name: string,
  limits?: Record<string, number>,
): Promise<{ store: EvidenceStore; root: string }> {
  const root = freshDir(STORE_BASE, `store-${name}`);
  const store = limits
    ? await createEvidenceStore({ root, limits })
    : await createEvidenceStore({ root });
  return { store, root };
}

async function capture(
  store: EvidenceStore,
  repo: string,
  name: string,
): Promise<SnapshotManifest> {
  return captureSnapshot({
    taskId: TASK_ID,
    taskRevision: TASK_REV,
    sourceRoot: repo,
    outputRoot: join(store.root, "snapshots", name),
  });
}

function criterion(id: string, over: any = {}): any {
  const text = over.text ?? over.statement ?? `requirement ${id}`;
  const value: any = {
    id,
    span: { text, start: 0, end: text.length },
    required: over.required ?? true,
    acceptanceType: over.acceptanceType ?? "ARTIFACT",
  };
  if (over.requiresSuiteCompleteness !== undefined) {
    value.requiresSuiteCompleteness = over.requiresSuiteCompleteness;
  }
  if (over.statement !== undefined) value.statement = over.statement;
  if (over.artifactExpectation !== undefined) value.artifactExpectation = over.artifactExpectation;
  return value;
}

/**
 * Build an ARTIFACT criterion with an explicit registered byte-level predicate.
 * When `over.digest` is omitted the snapshot entry's own hash is registered (a
 * present file), otherwise the supplied presence/digest is used verbatim.
 */
function artifactCriterion(
  id: string,
  path: string,
  snapshot: SnapshotManifest | null,
  over: any = {},
): any {
  const entry = snapshot?.files.find((file) => file.path === path);
  const presence = over.presence ?? (entry && entry.hash !== null ? "present" : "absent");
  const digest = over.digest !== undefined ? over.digest : entry ? entry.hash : null;
  return criterion(id, {
    acceptanceType: "ARTIFACT",
    text: over.text,
    artifactExpectation: { path, presence, digest },
  });
}

function claim(id: string, criterionIds: string[], text = `claim ${id}`): any {
  return { id, span: { text, start: 0, end: text.length }, criterionIds };
}

function bindingOf(snapshot: SnapshotManifest, over: any = {}): any {
  return {
    taskId: TASK_ID,
    taskRevision: TASK_REV,
    candidateId: snapshot.candidateId,
    scope: { description: "test scope", paths: ["artifact.txt"] },
    statement: "Deliver the artifact",
    criteria: [criterion("R2", { acceptanceType: "ARTIFACT" })],
    claims: [],
    snapshot,
    ...over,
  };
}

async function setup(name: string, over: any = {}) {
  const repo = makeRepo(name);
  const { store, root } = await createStore(name, over.limits);
  const snapshot = await capture(store, repo, "snap");
  await bindTask(
    store,
    bindingOf(snapshot, {
      criteria: over.criteria ?? [artifactCriterion("R2", "artifact.txt", snapshot)],
      claims: over.claims ?? [],
      statement: over.statement ?? "Deliver the artifact",
    }),
  );
  const receipt = (o: any = {}): CheckReceipt =>
    ({
      checkId: "chk-1",
      taskId: TASK_ID,
      taskRevision: TASK_REV,
      candidateId: snapshot.candidateId,
      criterionIds: ["R2"],
      kind: "EXECUTION",
      origin: "IMPORTED",
      completion: "COMPLETED",
      result: "PASS",
      exitCode: 0,
      ...o,
    }) as CheckReceipt;
  return { store, root, repo, snapshot, receipt, candidateId: snapshot.candidateId };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EvidenceStoreError);
    expect((error as EvidenceStoreError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function storeContains(dir: string, needle: string): boolean {
  for (const file of walk(dir)) {
    if (readFileSync(file).includes(needle)) return true;
  }
  return false;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Rewrite a record file and re-seal the whole hash chain/metadata head exactly
 * as a writer with store-root access could. Used to prove that a
 * self-consistent forged `CAPTURED` record still cannot fabricate trust.
 */
const RECORD_KEY_ORDER = [
  "schemaVersion",
  "sequence",
  "checkId",
  "taskId",
  "taskRevision",
  "candidateId",
  "criterionIds",
  "kind",
  "claimedOrigin",
  "provenance",
  "completion",
  "result",
  "discovery",
  "exitCode",
  "signal",
  "argv",
  "cwd",
  "startedAt",
  "endedAt",
  "runner",
  "snapshotCandidateId",
  "artifact",
  "output",
  "referencedOutputs",
  "environment",
  "source",
  "limitations",
  "redactions",
  "terminal",
  "terminalReason",
  "recordedAt",
  "previousHash",
] as const;

function forgeRecord(root: string, checkId: string, mutate: (record: any) => void): void {
  const file = join(root, "records", `${checkId}.json`);
  // Normalise through the strict schema first: the reader re-orders keys via
  // Zod, so the hash must be computed over the schema order, not file order.
  const parsed = StoredRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const record: any = { ...parsed };
  mutate(record);
  const withoutHash: Record<string, unknown> = {};
  for (const key of RECORD_KEY_ORDER) {
    if (record[key] !== undefined) withoutHash[key] = record[key];
  }
  const hash = `sha256:${sha256Hex(JSON.stringify(withoutHash))}`;
  writeFileSync(file, JSON.stringify({ ...withoutHash, hash }));
  const metaPath = join(root, "store.json");
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  meta.chain = { head: hash, length: 1 };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function spyIo(externalMarker: string): { io: EvidenceStoreIo; reads: string[] } {
  const reads: string[] = [];
  const io: EvidenceStoreIo = {
    ...nodeEvidenceStoreIo,
    readFile: (path: string) => {
      reads.push(path);
      return nodeEvidenceStoreIo.readFile(path);
    },
  };
  // `externalMarker` is retained only so callers can document intent.
  void externalMarker;
  return { io, reads };
}

afterAll(() => {
  for (const base of [FIXTURES, STORE_BASE]) {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("store creation and layout", () => {
  test("exports the expected store schema version", () => {
    expect(EVIDENCE_STORE_SCHEMA_VERSION).toBe(2);
  });

  test("creates a store exclusively and refuses an existing root", async () => {
    const { root } = await createStore("exclusive");
    expect(existsSync(join(root, "store.json"))).toBe(true);
    await expectCode(createEvidenceStore({ root }), "STORE_EXISTS");
  });

  test("refuses to open a missing store", async () => {
    await expectCode(
      openEvidenceStore({ root: join(STORE_BASE, "definitely-missing-store") }),
      "STORE_NOT_FOUND",
    );
  });

  test("rejects an unsupported store schema version", async () => {
    const { root } = await createStore("version");
    const meta = JSON.parse(readFileSync(join(root, "store.json"), "utf8"));
    meta.schemaVersion = 999;
    writeFileSync(join(root, "store.json"), JSON.stringify(meta, null, 2));
    await expectCode(openEvidenceStore({ root }), "STORE_VERSION_UNSUPPORTED");
  });

  test("rejects a malformed store file", async () => {
    const { root } = await createStore("malformed");
    writeFileSync(join(root, "store.json"), "{ this is not json");
    await expectCode(openEvidenceStore({ root }), "STORE_INVALID");
  });

  test("does not export any capture-authority mint", () => {
    const names = Object.keys(evidenceStoreModule);
    expect(names.some((name) => /mint|authority|capab/i.test(name))).toBe(false);
    expect((evidenceStoreModule as any).captureExecution).toBeUndefined();
  });
});

describe("task binding", () => {
  test("binds a verifier-owned snapshot and re-validates copied hashes", async () => {
    const repo = makeRepo("bind-ok");
    const { store } = await createStore("bind-ok");
    const snapshot = await capture(store, repo, "snap");
    await bindTask(store, bindingOf(snapshot));
    const records = await readAudit(store);
    expect(records.task?.candidateId).toBe(snapshot.candidateId);
    expect(records.integrity.copyValid).toBe(true);
  });

  test("refuses a duplicate bind", async () => {
    const repo = makeRepo("bind-dup");
    const { store } = await createStore("bind-dup");
    const snapshot = await capture(store, repo, "snap");
    await bindTask(store, bindingOf(snapshot));
    await expectCode(bindTask(store, bindingOf(snapshot)), "TASK_COLLISION");
  });

  test("refuses a snapshot copy outside the store root", async () => {
    const repo = makeRepo("bind-outside");
    const { store } = await createStore("bind-outside");
    const external = freshDir(STORE_BASE, "external-snap");
    const snapshot = await captureSnapshot({
      taskId: TASK_ID,
      taskRevision: TASK_REV,
      sourceRoot: repo,
      outputRoot: external,
    });
    await expectCode(bindTask(store, bindingOf(snapshot)), "SNAPSHOT_UNREGISTERED");
  });

  test("refuses a tampered snapshot copy", async () => {
    const repo = makeRepo("bind-tamper");
    const { store } = await createStore("bind-tamper");
    const snapshot = await capture(store, repo, "snap");
    writeFileSync(join(snapshot.copyRoot, "artifact.txt"), "tampered at bind\n");
    await expectCode(bindTask(store, bindingOf(snapshot)), "SNAPSHOT_COPY_TAMPERED");
  });

  test("refuses binding identity that disagrees with the snapshot", async () => {
    const repo = makeRepo("bind-identity");
    const { store } = await createStore("bind-identity");
    const snapshot = await capture(store, repo, "snap");
    await expectCode(
      bindTask(store, { ...bindingOf(snapshot), candidateId: "cand-other" }),
      "IDENTITY_MISMATCH",
    );
  });

  test("rejects a claim referencing an unknown criterion", async () => {
    const repo = makeRepo("bind-badclaim");
    const { store } = await createStore("bind-badclaim");
    const snapshot = await capture(store, repo, "snap");
    await expectCode(
      bindTask(store, bindingOf(snapshot, { claims: [claim("C1", ["NOPE"])] })),
      "TASK_BINDING_INVALID",
    );
  });
});

describe("imported check receipts", () => {
  test("appends an imported receipt with a valid hash chain", async () => {
    const s = await setup("append-ok");
    await appendCheck(s.store, s.receipt());
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(1);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.integrity.chainLength).toBe(1);
    expect(records.records[0]!.provenance).toBe("IMPORTED");
    expect(records.records[0]!.trusted).toBe(false);
  });

  test("downgrades a forged RUNNER_CAPTURED execution receipt", async () => {
    const s = await setup("forged", {
      criteria: [criterion("R1", { acceptanceType: "EXECUTION" })],
    });
    await appendCheck(
      s.store,
      s.receipt({
        criterionIds: ["R1"],
        origin: "RUNNER_CAPTURED",
        kind: "EXECUTION",
        completion: "COMPLETED",
        result: "PASS",
        exitCode: 0,
      }),
    );
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.claimedOrigin).toBe("RUNNER_CAPTURED");
    expect(record.provenance).toBe("IMPORTED");
    expect(record.effectiveOrigin).toBe("IMPORTED");
    expect(record.trusted).toBe(false);

    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.verdict.criteria.find((c) => c.id === "R1")!.state).toBe("UNVERIFIED");
  });

  test("refuses a duplicate check id", async () => {
    const s = await setup("dup");
    await appendCheck(s.store, s.receipt({ checkId: "chk-dup" }));
    await expectCode(appendCheck(s.store, s.receipt({ checkId: "chk-dup" })), "DUPLICATE_RECORD");
  });

  test("refuses an identity mismatch", async () => {
    const s = await setup("idm");
    await expectCode(
      appendCheck(s.store, s.receipt({ candidateId: "cand-other" })),
      "IDENTITY_MISMATCH",
    );
  });

  test("refuses an unknown criterion reference", async () => {
    const s = await setup("unknown-crit");
    await expectCode(appendCheck(s.store, s.receipt({ criterionIds: ["NOPE"] })), "UNKNOWN_CRITERION");
  });

  test("refuses a structurally invalid receipt", async () => {
    const s = await setup("bad-receipt");
    await expectCode(
      appendCheck(s.store, { checkId: "chk-bad" } as unknown as CheckReceipt),
      "RECEIPT_INVALID",
    );
  });

  test("refuses to append before a task is bound", async () => {
    const { store } = await createStore("not-bound");
    await expectCode(
      appendCheck(store, {
        checkId: "chk-x",
        taskId: TASK_ID,
        taskRevision: TASK_REV,
        candidateId: "cand-none",
        criterionIds: ["R1"],
        kind: "EXECUTION",
        origin: "IMPORTED",
        completion: "COMPLETED",
        result: "PASS",
        exitCode: 0,
      }),
      "NOT_BOUND",
    );
  });

  test("records failed and cancelled states without granting support", async () => {
    const s = await setup("states", {
      criteria: [criterion("R1", { acceptanceType: "EXECUTION" })],
    });
    await appendCheck(
      s.store,
      s.receipt({ checkId: "chk-fail", criterionIds: ["R1"], completion: "FAILED", result: "PASS", exitCode: 1 }),
    );
    await appendCheck(
      s.store,
      s.receipt({ checkId: "chk-cancel", criterionIds: ["R1"], completion: "CANCELLED", result: "UNKNOWN", exitCode: undefined }),
    );
    const records = await readAudit(s.store);
    expect(records.records.map((r) => r.completion).sort()).toEqual(["CANCELLED", "FAILED"]);
    const report = replayAudit(records);
    expect(report.verdict.criteria.find((c) => c.id === "R1")!.state).not.toBe("SUPPORTED");
  });

  test("serializes concurrent appends and refuses a colliding duplicate", async () => {
    const s = await setup("concurrent");
    const results = await Promise.allSettled([
      appendCheck(s.store, s.receipt({ checkId: "chk-a" })),
      appendCheck(s.store, s.receipt({ checkId: "chk-a" })),
    ]);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("DUPLICATE_RECORD");
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(1);
  });

  test("serializes distinct concurrent appends into a valid chain", async () => {
    const s = await setup("concurrent-two");
    await Promise.all([
      appendCheck(s.store, s.receipt({ checkId: "chk-a" })),
      appendCheck(s.store, s.receipt({ checkId: "chk-b" })),
    ]);
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(2);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.integrity.chainLength).toBe(2);
  });
});

describe("output handling", () => {
  test("redacts secrets from output before persistence", async () => {
    const s = await setup("redact");
    const secret = "hunter2-SUPER-secret";
    const output = `password=${secret}\nAuthorization: Bearer abcDEF123token\nAWS AKIAIOSFODNN7EXAMPLE\n`;
    await appendCheck(s.store, s.receipt({ output }));
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.output).not.toBeNull();
    expect(record.output!.redactions.length).toBeGreaterThan(0);
    expect(storeContains(s.root, secret)).toBe(false);
    expect(storeContains(s.root, "AKIAIOSFODNN7EXAMPLE")).toBe(false);
    expect(storeContains(s.root, "abcDEF123token")).toBe(false);
  });

  test("redacts argv and environment values", async () => {
    const s = await setup("redact-argv");
    await appendCheck(
      s.store,
      s.receipt({
        argv: ["bun", "--token=abc123secret"],
        environment: { API_KEY: "sk-live-abcdef0123456789" },
      }),
    );
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.argv.join(" ")).not.toContain("abc123secret");
    expect(JSON.stringify(record.environment)).not.toContain("sk-live-abcdef0123456789");
    expect(storeContains(s.root, "abc123secret")).toBe(false);
    expect(storeContains(s.root, "sk-live-abcdef0123456789")).toBe(false);
  });

  test("truncates an oversized output and bounds the stored size", async () => {
    const s = await setup("flood");
    await appendCheck(s.store, s.receipt({ output: "A".repeat(200_000) }));
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.output!.truncated).toBe(true);
    expect(record.output!.size).toBeLessThanOrEqual(16_384);
  });

  test("refuses an oversized argv", async () => {
    const s = await setup("bigargv");
    const argv = Array.from({ length: 200 }, (_, i) => `arg-${i}`);
    await expectCode(appendCheck(s.store, s.receipt({ argv })), "LIMIT_EXCEEDED");
  });

  test("resolves a stored output ref and validates its digest", async () => {
    const s = await setup("ref");
    await appendCheck(s.store, s.receipt({ output: "hello output" }));
    const records = await readAudit(s.store);
    const output = records.records[0]!.output!;
    const resolved = await readOutputRef(s.store, output.ref, output.digest);
    expect(resolved.text).toContain("hello output");
  });

  test("refuses traversal and unknown output refs", async () => {
    const s = await setup("ref-bad");
    await expectCode(readOutputRef(s.store, "../store.json"), "REF_ESCAPE");
    await expectCode(readOutputRef(s.store, "does-not-exist"), "UNKNOWN_REF");
  });

  test("refuses a symlinked output ref", async () => {
    const s = await setup("ref-link");
    const external = freshDir(STORE_BASE, "external-ref");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "secret.txt"), "external secret");
    try {
      symlinkSync(external, join(s.root, "outputs", "evil.txt"), "junction");
    } catch {
      return;
    }
    await expectCode(readOutputRef(s.store, "evil"), "REF_ESCAPE");
  });

  test("refuses a receipt that names an unregistered output ref", async () => {
    const s = await setup("receipt-ref");
    await expectCode(appendCheck(s.store, s.receipt({ outputRefs: ["unknown-ref"] })), "UNKNOWN_REF");
  });

  test("refuses a receipt output ref that escapes the store", async () => {
    const s = await setup("receipt-ref-escape");
    await expectCode(appendCheck(s.store, s.receipt({ outputRefs: ["../store.json"] })), "REF_ESCAPE");
  });
});

describe("snapshot validation and trust", () => {
  test("a store-captured artifact observation supports an ARTIFACT criterion", async () => {
    const s = await setup("artifact-ok");
    await collectArtifactObservation(s.store, { criterionIds: ["R2"], path: "artifact.txt" });
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.kind).toBe("ARTIFACT");
    expect(record.provenance).toBe("CAPTURED");
    expect(record.trusted).toBe(true);
    expect(record.effectiveOrigin).toBe("RUNNER_CAPTURED");
    const report = replayAudit(records);
    expect(report.verdict.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("a missing artifact records BLOCKED and never fabricates PASS", async () => {
    const repo = makeRepo("artifact-missing");
    const { store } = await createStore("artifact-missing");
    const snapshot = await capture(store, repo, "snap");
    await bindTask(
      store,
      bindingOf(snapshot, {
        criteria: [
          artifactCriterion("R3", "gone.txt", snapshot, {
            presence: "present",
            digest: "0".repeat(64),
          }),
        ],
      }),
    );
    await collectArtifactObservation(store, { criterionIds: ["R3"], path: "gone.txt" });
    const records = await readAudit(store);
    const record = records.records[0]!;
    expect(record.completion).toBe("BLOCKED");
    expect(record.result).not.toBe("PASS");
    const report = replayAudit(records);
    expect(report.verdict.criteria.find((c) => c.id === "R3")!.state).toBe("BLOCKED");
  });

  test("refuses to collect an artifact that is not in the registered snapshot", async () => {
    const repo = makeRepo("artifact-unregistered");
    const { store } = await createStore("artifact-unregistered");
    const snapshot = await capture(store, repo, "snap");
    await bindTask(
      store,
      bindingOf(snapshot, {
        criteria: [
          artifactCriterion("RX", "not-in-snapshot.txt", snapshot, {
            presence: "present",
            digest: "a".repeat(64),
          }),
        ],
      }),
    );
    await expectCode(
      collectArtifactObservation(store, { criterionIds: ["RX"], path: "not-in-snapshot.txt" }),
      "SNAPSHOT_UNREGISTERED",
    );
  });

  test("tampering the snapshot copy after bind fails closed on read", async () => {
    const s = await setup("copy-tamper");
    writeFileSync(join(s.snapshot.copyRoot, "artifact.txt"), "tampered after bind\n");
    const records = await readAudit(s.store);
    expect(records.integrity.copyValid).toBe(false);
    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("a copied forged ledger does not acquire capture authority", async () => {
    const s = await setup("copied-ledger", {
      criteria: [
        criterion("R1", { acceptanceType: "EXECUTION" }),
        criterion("R2", { acceptanceType: "ARTIFACT" }),
      ],
    });
    await appendCheck(
      s.store,
      s.receipt({ criterionIds: ["R1"], origin: "RUNNER_CAPTURED", kind: "EXECUTION" }),
    );
    const copiedRoot = freshDir(STORE_BASE, "copied-ledger-copy");
    cpSync(s.root, copiedRoot, { recursive: true });
    const copied = await openEvidenceStore({ root: copiedRoot });
    const records = await readAudit(copied);
    expect(records.integrity.copyValid).toBe(false);
    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.verdict.criteria.find((c) => c.id === "R1")!.state).not.toBe("SUPPORTED");
  });

  test("an imported artifact receipt does not support an artifact criterion", async () => {
    const s = await setup("imported-artifact");
    await appendCheck(
      s.store,
      s.receipt({
        criterionIds: ["R2"],
        kind: "ARTIFACT",
        origin: "IMPORTED",
        completion: "COMPLETED",
        result: "PASS",
        exitCode: undefined,
      }),
    );
    const report = replayAudit(await readAudit(s.store));
    expect(report.verdict.criteria.find((c) => c.id === "R2")!.state).toBe("UNVERIFIED");
  });
});

describe("corruption and chain integrity", () => {
  test("a corrupt record file fails closed", async () => {
    const s = await setup("corrupt");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    writeFileSync(join(s.root, "records", "chk-bad.json"), "{ truncated record");
    await expectCode(readAudit(s.store), "STORE_TAMPERED");
  });

  test("a broken hash chain is reported invalid, not silently trusted", async () => {
    const s = await setup("chain");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const file = join(s.root, "records", "chk-1.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.result = "FAIL";
    writeFileSync(file, JSON.stringify(record));
    const records = await readAudit(s.store);
    expect(records.integrity.chainValid).toBe(false);
    const report = replayAudit(records);
    expect(report.verdict.overall).toBe("INCOMPLETE_EVIDENCE");
  });
});

describe("artifact predicate binding", () => {
  test("a semantic ARTIFACT criterion cannot be captured from static bytes", async () => {
    const s = await setup("artifact-semantic", {
      criteria: [criterion("RS", { acceptanceType: "ARTIFACT" })],
    });
    await expectCode(
      collectArtifactObservation(s.store, { criterionIds: ["RS"], path: "artifact.txt" }),
      "ARTIFACT_NOT_BOUND",
    );
    const report = replayAudit(await readAudit(s.store));
    expect(report.verdict.criteria.find((c) => c.id === "RS")!.state).not.toBe("SUPPORTED");
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("an unrelated artifact path cannot support a criterion", async () => {
    const s = await setup("artifact-unrelated");
    await expectCode(
      collectArtifactObservation(s.store, { criterionIds: ["R2"], path: "changed.txt" }),
      "ARTIFACT_PREDICATE_MISMATCH",
    );
    const report = replayAudit(await readAudit(s.store));
    expect(report.verdict.criteria.find((c) => c.id === "R2")!.state).not.toBe("SUPPORTED");
  });

  test("a wrong expected digest never verifies", async () => {
    const repo = makeRepo("artifact-wrong");
    const { store } = await createStore("artifact-wrong");
    const snapshot = await capture(store, repo, "snap");
    await bindTask(
      store,
      bindingOf(snapshot, {
        criteria: [
          artifactCriterion("RW", "artifact.txt", snapshot, {
            presence: "present",
            digest: "1".repeat(64),
          }),
        ],
      }),
    );
    await collectArtifactObservation(store, { criterionIds: ["RW"], path: "artifact.txt" });
    const records = await readAudit(store);
    expect(records.records[0]!.completion).toBe("BLOCKED");
    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.verdict.criteria.find((c) => c.id === "RW")!.state).not.toBe("SUPPORTED");
  });

  test("a matching registered predicate supports the criterion", async () => {
    const s = await setup("artifact-match");
    await collectArtifactObservation(s.store, { criterionIds: ["R2"], path: "artifact.txt" });
    const report = replayAudit(await readAudit(s.store));
    expect(report.verdict.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("a forged CAPTURED record cannot promote a semantic criterion", async () => {
    const s = await setup("artifact-forged-semantic", {
      criteria: [criterion("RS", { acceptanceType: "ARTIFACT" })],
    });
    const entry = s.snapshot.files.find((file) => file.path === "artifact.txt")!;
    await appendCheck(
      s.store,
      s.receipt({
        checkId: "chk-forge",
        criterionIds: ["RS"],
        kind: "ARTIFACT",
        completion: "COMPLETED",
        result: "PASS",
        exitCode: undefined,
      }),
    );
    forgeRecord(s.root, "chk-forge", (record) => {
      record.provenance = "CAPTURED";
      record.claimedOrigin = "RUNNER_CAPTURED";
      record.artifact = { path: "artifact.txt", digest: entry.hash, size: entry.size };
    });
    const records = await readAudit(s.store);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records[0]!.trusted).toBe(false);
    expect(records.records[0]!.effectiveOrigin).not.toBe("RUNNER_CAPTURED");
    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.verdict.criteria.find((c) => c.id === "RS")!.state).not.toBe("SUPPORTED");
  });

  test("a forged CAPTURED record cannot point at another registered file", async () => {
    const s = await setup("artifact-forged-path");
    const entry = s.snapshot.files.find((file) => file.path === "changed.txt")!;
    await appendCheck(
      s.store,
      s.receipt({
        checkId: "chk-forge2",
        criterionIds: ["R2"],
        kind: "ARTIFACT",
        completion: "COMPLETED",
        result: "PASS",
        exitCode: undefined,
      }),
    );
    forgeRecord(s.root, "chk-forge2", (record) => {
      record.provenance = "CAPTURED";
      record.claimedOrigin = "RUNNER_CAPTURED";
      record.artifact = { path: "changed.txt", digest: entry.hash, size: entry.size };
    });
    const records = await readAudit(s.store);
    expect(records.records[0]!.trusted).toBe(false);
    const report = replayAudit(records);
    expect(report.verdict.criteria.find((c) => c.id === "R2")!.state).not.toBe("SUPPORTED");
  });
});

describe("contextual and adjacent redaction", () => {
  test("redacts an arbitrary value under a secret-named environment key", async () => {
    const s = await setup("redact-env-context");
    const canary1 = "opaque-canary-alpha";
    const canary2 = "opaque-canary-beta";
    await appendCheck(
      s.store,
      s.receipt({
        environment: { API_KEY: canary1, APP_SECRET: canary2, SAFE_VALUE: "visible-value" },
      }),
    );
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.environment.API_KEY).toContain("[REDACTED");
    expect(record.environment.APP_SECRET).toContain("[REDACTED");
    expect(record.environment.SAFE_VALUE).toBe("visible-value");
    expect(JSON.stringify(record.environment)).not.toContain(canary1);
    expect(JSON.stringify(record.environment)).not.toContain(canary2);
    expect(storeContains(s.root, canary1)).toBe(false);
    expect(storeContains(s.root, canary2)).toBe(false);
  });

  test("redacts the adjacent value of a secret-named argv flag", async () => {
    const s = await setup("redact-argv-context");
    const canary = "opaque-canary-gamma";
    await appendCheck(
      s.store,
      s.receipt({ argv: ["tool", "--password", canary, "--verbose"] }),
    );
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.argv.join(" ")).not.toContain(canary);
    expect(storeContains(s.root, canary)).toBe(false);
  });

  test("redacts secrets in other persisted receipt fields", async () => {
    const s = await setup("redact-other-fields");
    const canary = "opaque-canary-delta";
    await appendCheck(
      s.store,
      s.receipt({
        source: `token=${canary}`,
        startedAt: `token=${canary}`,
        endedAt: `token=${canary}`,
        runner: `token=${canary}`,
        limitations: [`token=${canary}`],
      }),
    );
    const records = await readAudit(s.store);
    const record = records.records[0]!;
    expect(record.source).not.toContain(canary);
    expect(record.startedAt).not.toContain(canary);
    expect(record.endedAt).not.toContain(canary);
    expect(record.runner).not.toContain(canary);
    expect(record.limitations.join(" ")).not.toContain(canary);
    expect(storeContains(s.root, canary)).toBe(false);
  });

  test("redacts secrets in the bound scope text", async () => {
    const repo = makeRepo("redact-scope");
    const { store, root } = await createStore("redact-scope");
    const snapshot = await capture(store, repo, "snap");
    const canary = "opaque-canary-scope";
    await bindTask(
      store,
      bindingOf(snapshot, {
        scope: { description: `token=${canary}`, paths: ["artifact.txt"] },
      }),
    );
    const records = await readAudit(store);
    expect(records.task!.scope.description).not.toContain(canary);
    expect(storeContains(root, canary)).toBe(false);
  });
});

describe("bounded secure reads", () => {
  test("refuses to read an output through a linked outputs ancestor", async () => {
    const s = await setup("outputs-link");
    const external = freshDir(STORE_BASE, "external-outputs");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "evil.txt"), "external secret payload");
    const outputs = join(s.root, "outputs");
    rmSync(outputs, { recursive: true, force: true });
    try {
      symlinkSync(external, outputs, "junction");
    } catch {
      return;
    }
    const { io, reads } = spyIo("external-outputs");
    await expectCode(readOutputRef(s.store, "evil", undefined, io), "REF_ESCAPE");
    expect(reads.some((path) => path.includes("external-outputs"))).toBe(false);
  });

  test("refuses to collect an artifact through a linked snapshot copy", async () => {
    const s = await setup("snapshot-link");
    const external = freshDir(STORE_BASE, "external-snapshot");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "artifact.txt"), "external artifact payload\n");
    const files = s.snapshot.copyRoot;
    rmSync(files, { recursive: true, force: true });
    try {
      symlinkSync(external, files, "junction");
    } catch {
      return;
    }
    const { io, reads } = spyIo("external-snapshot");
    await expectCode(
      collectArtifactObservation(s.store, { criterionIds: ["R2"], path: "artifact.txt" }, io),
      "SNAPSHOT_COPY_TAMPERED",
    );
    expect(reads.some((path) => path.includes("external-snapshot"))).toBe(false);
  });

  test("refuses a linked records directory", async () => {
    const s = await setup("records-link");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const external = freshDir(STORE_BASE, "external-records");
    mkdirSync(external, { recursive: true });
    const recordsDir = join(s.root, "records");
    rmSync(recordsDir, { recursive: true, force: true });
    try {
      symlinkSync(external, recordsDir, "junction");
    } catch {
      return;
    }
    await expectCode(readAudit(s.store), "STORE_TAMPERED");
  });

  test("refuses a linked binding file", async () => {
    const s = await setup("binding-link");
    const external = freshDir(STORE_BASE, "external-binding");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "binding.json"), "{}");
    rmSync(join(s.root, "binding.json"), { force: true });
    try {
      symlinkSync(join(external, "binding.json"), join(s.root, "binding.json"), "file");
    } catch {
      return;
    }
    await expectCode(readAudit(s.store), "STORE_TAMPERED");
  });

  test("refuses an oversized binding before parsing", async () => {
    const repo = makeRepo("oversized-binding");
    const { store, root } = await createStore("oversized-binding", { maxMetadataBytes: 2048 });
    const snapshot = await capture(store, repo, "snap");
    await bindTask(store, bindingOf(snapshot));
    writeFileSync(join(root, "binding.json"), JSON.stringify({ pad: "x".repeat(8192) }));
    await expectCode(readAudit(store), "LIMIT_EXCEEDED");
  });

  test("refuses an oversized record before parsing", async () => {
    const s = await setup("oversized-record", { limits: { maxRecordBytes: 2048 } });
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    writeFileSync(join(s.root, "records", "chk-1.json"), JSON.stringify({ pad: "x".repeat(8192) }));
    await expectCode(readAudit(s.store), "LIMIT_EXCEEDED");
  });

  test("refuses too many records before reading any", async () => {
    const s = await setup("too-many-records", { limits: { maxRecords: 2 } });
    for (const name of ["r1", "r2", "r3"]) {
      writeFileSync(join(s.root, "records", `${name}.json`), JSON.stringify({ dummy: true }));
    }
    await expectCode(readAudit(s.store), "LIMIT_EXCEEDED");
  });

  test("refuses to open a store through a symlinked root", async () => {
    const s = await setup("root-alias");
    const link = join(STORE_BASE, `root-link-${process.pid}-${seq++}`);
    rmSync(link, { recursive: true, force: true });
    try {
      symlinkSync(s.root, link, "junction");
    } catch {
      return;
    }
    await expectCode(openEvidenceStore({ root: link }), "STORE_INVALID");
  });
});

describe("terminal lifecycle and same-root serialization", () => {
  test("cancellation is a terminal lifecycle state", async () => {
    const s = await setup("terminal", {
      criteria: [criterion("R1", { acceptanceType: "EXECUTION" })],
    });
    await appendCheck(
      s.store,
      s.receipt({
        checkId: "chk-cancel",
        criterionIds: ["R1"],
        completion: "CANCELLED",
        result: "UNKNOWN",
        exitCode: undefined,
      }),
    );
    const records = await readAudit(s.store);
    expect(records.lifecycle).toBe("CANCELLED");
    expect(records.records[0]!.terminal).toBe(true);
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-after", criterionIds: ["R1"] })),
      "TERMINAL_STATE",
    );
    const report = replayAudit(records);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("two handles for the same root serialise without lost updates", async () => {
    const s = await setup("same-root");
    const second = await openEvidenceStore({ root: s.root });
    await Promise.all([
      appendCheck(s.store, s.receipt({ checkId: "chk-a" })),
      appendCheck(second, s.receipt({ checkId: "chk-b" })),
    ]);
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(2);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.integrity.chainLength).toBe(2);
  });

  test("two handles refuse a colliding duplicate write", async () => {
    const s = await setup("same-root-dup");
    const second = await openEvidenceStore({ root: s.root });
    const results = await Promise.allSettled([
      appendCheck(s.store, s.receipt({ checkId: "chk-a" })),
      appendCheck(second, s.receipt({ checkId: "chk-a" })),
    ]);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("DUPLICATE_RECORD");
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(1);
  });
});

describe("round-2: fail-closed atomic persistence and interruption", () => {
  test("a failed metadata replace rejects the append and preserves the prior head byte-for-byte", async () => {
    const s = await setup("atomic-rename-fail");
    let fail = false;
    const removed: string[] = [];
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      rename: (from, to) => {
        if (fail && to.endsWith("store.json")) throw new Error("injected rename failure");
        nodeEvidenceStoreIo.rename(from, to);
      },
      remove: (path) => {
        removed.push(path);
        nodeEvidenceStoreIo.remove(path);
      },
    };
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }), io);
    const headPath = join(s.root, "store.json");
    const before = readFileSync(headPath);
    fail = true;
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-2" }), io),
      "ATOMIC_REPLACE_FAILED",
    );
    // The durable head was never deleted or rewritten.
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(removed.some((path) => path.endsWith("store.json"))).toBe(false);
    // The committed record is an honest orphan, not a silent success.
    expect(existsSync(join(s.root, "records", "chk-2.json"))).toBe(true);
    const records = await readAudit(s.store);
    expect(records.integrity.chainValid).toBe(false);
    expect(records.integrity.errors).toContain("CHAIN_LENGTH_MISMATCH");
    expect(records.integrity.errors.some((e) => e.startsWith("ORPHAN_RECORD:chk-2"))).toBe(true);
    const report = replayAudit(records);
    expect(report.valid).toBe(false);
    expect(report.verdict.overall).toBe("INCOMPLETE_EVIDENCE");
    // The inconsistent store refuses to compound the fork.
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-3" }), io),
      "STORE_INCONSISTENT",
    );
  });

  test("a failed metadata temp write preserves the head and rejects the append", async () => {
    const s = await setup("atomic-write-fail");
    let fail = false;
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      writeFileExclusive: (path, data) => {
        if (fail && path.includes("store.json")) throw new Error("injected write failure");
        nodeEvidenceStoreIo.writeFileExclusive(path, data);
      },
    };
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }), io);
    const headPath = join(s.root, "store.json");
    const before = readFileSync(headPath);
    fail = true;
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-2" }), io),
      "ATOMIC_REPLACE_FAILED",
    );
    expect(readFileSync(headPath).equals(before)).toBe(true);
  });

  test("a hostile remove during a replace still preserves the head", async () => {
    const s = await setup("atomic-remove-fail");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const before = readFileSync(headPath);
    let fail = false;
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      rename: (from, to) => {
        if (fail && to.endsWith("store.json")) throw new Error("injected rename failure");
        nodeEvidenceStoreIo.rename(from, to);
      },
      remove: (path) => {
        if (path.endsWith("store.json")) throw new Error("hostile remove");
        nodeEvidenceStoreIo.remove(path);
      },
    };
    fail = true;
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-2" }), io),
      "ATOMIC_REPLACE_FAILED",
    );
    expect(readFileSync(headPath).equals(before)).toBe(true);
  });

  test("an unavailable atomic primitive fails closed without writing half JSON in place", async () => {
    const s = await setup("atomic-link-fail");
    const headPath = join(s.root, "store.json");
    const before = readFileSync(headPath);
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      link: () => {
        const error = new Error("injected link failure") as NodeJS.ErrnoException;
        error.code = "EXDEV";
        throw error;
      },
    };
    await expectCode(
      appendCheck(s.store, s.receipt({ checkId: "chk-1" }), io),
      "ATOMIC_UNAVAILABLE",
    );
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(existsSync(join(s.root, "records", "chk-1.json"))).toBe(false);
    const leftovers = readdirSync(join(s.root, "records")).filter((name) => name.endsWith(".json"));
    expect(leftovers.length).toBe(0);
  });

  test("a transient replace-existing refusal falls back to a recoverable swap", async () => {
    const s = await setup("atomic-swap");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      rename: (from, to) => {
        // Simulate a policy that refuses to replace an existing store.json but
        // still allows moving it aside (the Windows failure mode).
        if (to.endsWith("store.json") && nodeEvidenceStoreIo.exists(to)) {
          const error = new Error("injected EPERM") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        nodeEvidenceStoreIo.rename(from, to);
      },
    };
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }), io);
    const records = await readAudit(s.store);
    expect(records.records.length).toBe(2);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.integrity.chainLength).toBe(2);
    expect(existsSync(join(s.root, "store.json.bak"))).toBe(false);
  });

  test("an interrupted metadata swap is recovered on reopen", async () => {
    const s = await setup("atomic-recover");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    // Simulate a crash after the old head was moved aside but before publish.
    nodeEvidenceStoreIo.rename(headPath, backupPath);
    expect(existsSync(headPath)).toBe(false);

    const reopened = await openEvidenceStore({ root: s.root });
    expect(existsSync(headPath)).toBe(true);
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.records.length).toBe(1);
    expect(records.integrity.chainValid).toBe(true);
  });
});

describe("round-3: recovery validates both heads before discarding a backup", () => {
  test("crash after move-aside recovers the prior head", async () => {
    const s = await setup("recover3-move-aside");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    // Simulate a crash after the old head was moved aside but before publish.
    nodeEvidenceStoreIo.rename(headPath, backupPath);
    expect(existsSync(headPath)).toBe(false);

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
  });

  test("crash after publish keeps the live head and discards the older backup", async () => {
    const s = await setup("recover3-after-publish");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const head = readFileSync(headPath);
    const headMeta = JSON.parse(head.toString("utf8"));
    const firstHash = JSON.parse(readFileSync(join(s.root, "records", "chk-1.json"), "utf8"))
      .hash as string;
    // The backup is the previous (valid) head the swap moved aside.
    writeFileSync(
      backupPath,
      JSON.stringify({ ...headMeta, chain: { head: firstHash, length: 1 } }, null, 2),
    );

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(head)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(2);
  });

  test("a truncated primary with a valid backup restores the backup instead of erasing it", async () => {
    const s = await setup("recover3-truncated");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    nodeEvidenceStoreIo.rename(headPath, backupPath);
    const validHead = readFileSync(backupPath);
    // A torn (or hostile) truncated primary appears ahead of the backup.
    writeFileSync(headPath, validHead.toString("utf8").slice(0, 40));

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(validHead)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(1);
  });

  test("a schema-invalid primary with a valid backup restores the backup", async () => {
    const s = await setup("recover3-badschema");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    nodeEvidenceStoreIo.rename(headPath, backupPath);
    const validHead = readFileSync(backupPath);
    const invalid = JSON.parse(validHead.toString("utf8"));
    invalid.lifecycle = "NOT_A_STATE";
    writeFileSync(headPath, JSON.stringify(invalid));

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(validHead)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
  });

  test("a valid primary with an identical stale backup discards only the backup", async () => {
    const s = await setup("recover3-stale-identical");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    cpSync(headPath, backupPath);

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(1);
  });

  test("an oversized backup is never promoted or followed", async () => {
    const s = await setup("recover3-oversized-backup");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    writeFileSync(backupPath, "x".repeat(1024 * 1024 + 1));

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(before)).toBe(true);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(1);
  });

  test("a linked backup is never followed or promoted", async () => {
    const s = await setup("recover3-linked-backup");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    // A forged head that a hostile link would promote if it were followed. The
    // portable fs API refuses to create a real file symlink on some hosts, so
    // the IO seam reports the linked backup deterministically.
    const externalDir = freshDir(STORE_BASE, "recover3-external");
    mkdirSync(externalDir, { recursive: true });
    const external = join(externalDir, "store.json");
    const forged = JSON.parse(before.toString("utf8"));
    forged.chain = { head: `sha256:${"a".repeat(64)}`, length: 9 };
    writeFileSync(external, JSON.stringify(forged, null, 2));
    const reads: string[] = [];
    const io: EvidenceStoreIo = {
      ...nodeEvidenceStoreIo,
      lstat: (path) =>
        path === backupPath
          ? {
              size: forged.chain.length,
              isFile: () => false,
              isDirectory: () => false,
              isSymbolicLink: () => true,
            }
          : nodeEvidenceStoreIo.lstat(path),
      readFile: (path) => {
        reads.push(path);
        return nodeEvidenceStoreIo.readFile(path);
      },
    };

    const reopened = await openEvidenceStore({ root: s.root }, io);
    // The linked backup (and its external target) was never read or followed.
    expect(reads.some((path) => path === backupPath || path === external)).toBe(false);
    expect(readFileSync(headPath).equals(before)).toBe(true);
    const records = await readAudit(reopened, io);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.integrity.chainLength).toBe(1);
  });

  test("an incoherent valid pair fails closed and preserves the backup", async () => {
    const s = await setup("recover3-ambiguous");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const before = readFileSync(headPath);
    const headMeta = JSON.parse(before.toString("utf8"));
    // A valid-looking backup that claims to be ahead of the live head.
    const rogue = { ...headMeta, chain: { head: `sha256:${"b".repeat(64)}`, length: 5 } };
    writeFileSync(backupPath, JSON.stringify(rogue, null, 2));

    await expectCode(openEvidenceStore({ root: s.root }), "STORE_INVALID");
    expect(readFileSync(headPath).equals(before)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  test("both primary and backup invalid fails closed and preserves the backup", async () => {
    const s = await setup("recover3-both-invalid");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    nodeEvidenceStoreIo.rename(headPath, backupPath);
    writeFileSync(headPath, "{ not json");
    writeFileSync(backupPath, "{ also not json");

    await expectCode(openEvidenceStore({ root: s.root }), "STORE_INVALID");
    expect(existsSync(backupPath)).toBe(true);
  });
});

describe("round-4: recovery requires actual chain coherence, not numeric ordering", () => {
  function readHeadMeta(root: string): any {
    return JSON.parse(readFileSync(join(root, "store.json"), "utf8"));
  }

  function firstRecordHash(root: string, checkId: string): string {
    return JSON.parse(readFileSync(join(root, "records", `${checkId}.json`), "utf8")).hash as string;
  }

  test("a greater-count primary with a fake head is rejected for the coherent backup", async () => {
    const s = await setup("recover4-fake-head");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const headMeta = readHeadMeta(s.root);
    // The backup is the real, coherent last head (chain length 1).
    writeFileSync(backupPath, JSON.stringify(headMeta, null, 2));
    // A schema-valid primary that merely claims a LONGER chain (length 2) whose
    // head hash matches no committed record.
    writeFileSync(
      headPath,
      JSON.stringify(
        { ...headMeta, chain: { head: `sha256:${"c".repeat(64)}`, length: 2 } },
        null,
        2,
      ),
    );

    const reopened = await openEvidenceStore({ root: s.root });
    const restored = readHeadMeta(s.root);
    expect(restored.chain.length).toBe(1);
    expect(restored.chain.head).toBe(headMeta.chain.head);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(1);
  });

  test("a greater-count primary with a different store identity is ambiguous and preserves the backup", async () => {
    const s = await setup("recover4-identity");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const head = readFileSync(headPath);
    const headMeta = readHeadMeta(s.root);
    // A valid backup that is a real prefix (length 1) but claims a different store
    // identity: it can neither justify keeping the live head nor be promoted.
    writeFileSync(
      backupPath,
      JSON.stringify(
        {
          ...headMeta,
          storeId: "store-other123",
          chain: { head: firstRecordHash(s.root, "chk-1"), length: 1 },
        },
        null,
        2,
      ),
    );

    await expectCode(openEvidenceStore({ root: s.root }), "STORE_INVALID");
    expect(readFileSync(headPath).equals(head)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  test("a malformed intervening record makes the pair ambiguous and preserves the backup", async () => {
    const s = await setup("recover4-malformed-record");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const head = readFileSync(headPath);
    const headMeta = readHeadMeta(s.root);
    writeFileSync(
      backupPath,
      JSON.stringify(
        { ...headMeta, chain: { head: firstRecordHash(s.root, "chk-1"), length: 1 } },
        null,
        2,
      ),
    );
    // The real committed record is corrupted (still a plausible file). Neither
    // head can be proven coherent, so recovery must fail closed.
    writeFileSync(join(s.root, "records", "chk-2.json"), "{ not json");

    await expectCode(openEvidenceStore({ root: s.root }), "STORE_INVALID");
    expect(readFileSync(headPath).equals(head)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  test("a lower-count backup that is a real prefix keeps the coherent live head", async () => {
    const s = await setup("recover4-valid-extension");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const head = readFileSync(headPath);
    const headMeta = readHeadMeta(s.root);
    writeFileSync(
      backupPath,
      JSON.stringify(
        { ...headMeta, chain: { head: firstRecordHash(s.root, "chk-1"), length: 1 } },
        null,
        2,
      ),
    );

    const reopened = await openEvidenceStore({ root: s.root });
    expect(readFileSync(headPath).equals(head)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(2);
  });

  test("a valid next-chain extension still appends and re-reads after recovery", async () => {
    const s = await setup("recover4-continue");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const headPath = join(s.root, "store.json");
    const backupPath = join(s.root, "store.json.bak");
    const headMeta = readHeadMeta(s.root);
    writeFileSync(backupPath, JSON.stringify(headMeta, null, 2));

    const reopened = await openEvidenceStore({ root: s.root });
    expect(existsSync(backupPath)).toBe(false);
    await appendCheck(reopened, s.receipt({ checkId: "chk-2" }));
    const records = await readAudit(reopened);
    expect(records.integrity.chainValid).toBe(true);
    expect(records.records.length).toBe(2);
  });
});

describe("round-2: exact-span redaction mapping", () => {
  test("a redacted criterion span records original offsets and never persists the secret", async () => {
    const repo = makeRepo("span-redact");
    const { store, root } = await createStore("span-redact");
    const snapshot = await capture(store, repo, "snap");
    const canary = "opaque-canary-epsilon";
    const originalText = `token=${canary}`;
    await bindTask(
      store,
      bindingOf(snapshot, {
        criteria: [criterion("R1", { acceptanceType: "EXECUTION", text: originalText })],
      }),
    );
    const records = await readAudit(store);
    const storedSpan = records.task!.criteria[0]!.span;
    expect(storedSpan.redacted).toBe(true);
    expect(storedSpan.originalStart).toBe(0);
    expect(storedSpan.originalEnd).toBe(originalText.length);
    // the display span is internally exact while the original extent is separate
    expect(storedSpan.end - storedSpan.start).toBe(storedSpan.text.length);
    expect(storedSpan.text).not.toContain(canary);
    expect(storeContains(root, canary)).toBe(false);
  });

  test("an unredacted criterion span carries no original-offset annotation", async () => {
    const s = await setup("span-clean");
    const records = await readAudit(s.store);
    const storedSpan = records.task!.criteria[0]!.span;
    expect(storedSpan.redacted).toBeUndefined();
    expect(storedSpan.originalStart).toBeUndefined();
    expect(storedSpan.originalEnd).toBeUndefined();
  });
});

describe("final gap: secret-bearing predicate identities are refused, not rewritten", () => {
  test("final gap: secret predicate identity is refused without echo", () => {
    const canary = "CANARY123";
    let caught: unknown;
    try {
      assertPredicatePathsSecretFree(
        [{ artifactExpectation: { path: `password=${canary}` } }],
        "criteria",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(EvidenceStoreError);
    expect((caught as EvidenceStoreError).code).toBe("CRITERION_SECRET");
    expect(String(caught)).not.toContain(canary);
  });

  test("final gap: ordinary predicate identity is preserved", () => {
    const criteria = [{ artifactExpectation: { path: "artifact.txt" } }];
    assertPredicatePathsSecretFree(criteria, "criteria");
    expect(criteria[0]!.artifactExpectation.path).toBe("artifact.txt");
  });
});
