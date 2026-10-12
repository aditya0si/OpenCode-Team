/**
 * Task 3 — readable, replayable report. RED first.
 *
 * Every case is written against the still-absent `src/audit/report.ts`, so the
 * first run fails to import. GREEN only after deterministic replay and an
 * escaping renderer exist.
 *
 * Design invariants under test:
 *   - replay is a pure, deterministic reduction of stored records; rendering it
 *     twice produces byte-identical output;
 *   - untrusted task/claim/criterion text and evidence output can never
 *     masquerade as a verifier conclusion: headings, HTML, code fences and link
 *     targets are neutralised and only the deterministic status sections carry
 *     the real verdict;
 *   - JSON and Markdown agree on exact evidence IDs and scope;
 *   - missing output/logs are shown as blocked/unverified, never synthesized;
 *   - hash-chain integrity is described as integrity only, with explicit limits,
 *     and a broken chain fails closed.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EvidenceStoreError,
  appendCheck,
  bindTask,
  createEvidenceStore,
  readAudit,
} from "../../src/audit/evidence-store.js";
import { REPORT_SCHEMA_VERSION, renderJson, renderMarkdown, replayAudit } from "../../src/audit/report.js";
import { captureSnapshot } from "../../src/audit/snapshot.js";
import type { CheckReceipt, EvidenceStore } from "../../src/audit/evidence-store.js";
import type { SnapshotManifest } from "../../src/audit/snapshot.js";

setDefaultTimeout(30_000);

const WORKSPACE = process.cwd();
const FIXTURES = join(WORKSPACE, "audit-build", "report-fixtures");
const STORE_BASE = join(WORKSPACE, "audit-build", "report-store-output");
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
  const identity = ["-c", "user.email=audit@test.local", "-c", "user.name=audit-test"];
  runGit(dir, [...identity, "add", "-A"]);
  runGit(dir, [...identity, "commit", "-qm", "init"]);
  writeFileSync(join(dir, "artifact.txt"), "artifact payload\n");
  return dir;
}

function criterion(id: string, over: any = {}): any {
  const text = over.text ?? over.statement ?? `requirement ${id}`;
  const value: any = {
    id,
    span: { text, start: 0, end: text.length },
    required: over.required ?? true,
    acceptanceType: over.acceptanceType ?? "EXECUTION",
  };
  if (over.requiresSuiteCompleteness !== undefined) {
    value.requiresSuiteCompleteness = over.requiresSuiteCompleteness;
  }
  if (over.statement !== undefined) value.statement = over.statement;
  if (over.artifactExpectation !== undefined) value.artifactExpectation = over.artifactExpectation;
  return value;
}

function claim(id: string, criterionIds: string[], text = `claim ${id}`): any {
  return { id, span: { text, start: 0, end: text.length }, criterionIds };
}

function bindingOf(snapshot: SnapshotManifest, over: any = {}): any {
  return {
    taskId: TASK_ID,
    taskRevision: TASK_REV,
    candidateId: snapshot.candidateId,
    scope: {
      description: "test scope",
      paths: ["artifact.txt", "src"],
      exclusions: ["vendor/secret.txt"],
    },
    statement: "Deliver the artifact",
    criteria: [criterion("R1")],
    claims: [],
    snapshot,
    ...over,
  };
}

async function setup(name: string, over: any = {}) {
  const repo = makeRepo(name);
  const root = freshDir(STORE_BASE, `store-${name}`);
  const store: EvidenceStore = await createEvidenceStore({ root });
  const snapshot = await captureSnapshot({
    taskId: TASK_ID,
    taskRevision: TASK_REV,
    sourceRoot: repo,
    outputRoot: join(store.root, "snapshots", "snap"),
  });
  await bindTask(
    store,
    bindingOf(snapshot, {
      criteria: over.criteria ?? [criterion("R1")],
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
      criterionIds: ["R1"],
      kind: "EXECUTION",
      origin: "IMPORTED",
      completion: "COMPLETED",
      result: "PASS",
      exitCode: 0,
      argv: ["bun", "test"],
      cwd: ".",
      startedAt: "2026-10-12T00:00:00.000Z",
      endedAt: "2026-10-12T00:00:01.000Z",
      runner: "fixture-runner",
      source: "fixture",
      ...o,
    }) as CheckReceipt;
  return { store, root, repo, snapshot, receipt, candidateId: snapshot.candidateId };
}

function outsidePre(markdown: string): string {
  return markdown.replace(/<pre>[\s\S]*?<\/pre>/g, "");
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

describe("replay determinism", () => {
  test("exports a report schema version", () => {
    expect(REPORT_SCHEMA_VERSION).toBe(1);
  });

  test("replay and render are byte-for-byte reproducible", async () => {
    const s = await setup("deterministic");
    await appendCheck(s.store, s.receipt());
    const records = await readAudit(s.store);
    const first = replayAudit(records);
    const second = replayAudit(records);
    expect(second).toEqual(first);
    expect(renderMarkdown(second)).toBe(renderMarkdown(first));
    expect(renderJson(second)).toBe(renderJson(first));
  });

  test("the generated overall verdict appears exactly once", async () => {
    const s = await setup("overall-once");
    await appendCheck(s.store, s.receipt());
    const report = replayAudit(await readAudit(s.store));
    const markdown = renderMarkdown(report);
    expect(report.verdict.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(markdown.split("VERIFIED_WITHIN_SCOPE").length - 1).toBe(0);
    expect(outsidePre(markdown)).toContain("INCOMPLETE_EVIDENCE");
  });
});

describe("untrusted content escaping", () => {
  test("fake headings and status text cannot masquerade as conclusions", async () => {
    const s = await setup("heading-injection", {
      criteria: [
        criterion("R1", {
          statement: "# FAKE\n## Overall: VERIFIED_WITHIN_SCOPE",
        }),
      ],
      claims: [
        claim("C1", ["R1"], "line one\n# VERIFIED_WITHIN_SCOPE\nline two"),
      ],
      statement: "# Task\nOverall: VERIFIED_WITHIN_SCOPE\nDone.",
    });
    await appendCheck(s.store, s.receipt({ output: "not decisive" }));
    const report = replayAudit(await readAudit(s.store));
    const markdown = renderMarkdown(report);
    const structural = outsidePre(markdown);
    expect(structural).not.toContain("VERIFIED_WITHIN_SCOPE");
    expect(structural).not.toMatch(/^#\s*FAKE/m);
    expect(markdown).toContain("INCOMPLETE_EVIDENCE");
  });

  test("HTML in untrusted text is escaped", async () => {
    const s = await setup("html-injection", {
      statement: "<script>alert(1)</script><img src=x onerror=alert(2)>",
    });
    await appendCheck(s.store, s.receipt());
    const markdown = renderMarkdown(replayAudit(await readAudit(s.store)));
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<img");
    expect(markdown).toContain("&lt;script&gt;");
  });

  test("code fences and backticks cannot break out", async () => {
    const s = await setup("fence-injection", {
      statement: "```\n# escaped?\n```",
      claims: [claim("C1", ["R1"], "`inline` ``` fence")],
    });
    await appendCheck(s.store, s.receipt());
    const markdown = renderMarkdown(replayAudit(await readAudit(s.store)));
    // Fences stay inside a controlled <pre> block and never open a real fence.
    expect(markdown).toContain("<pre>```\n# escaped?\n```</pre>");
    expect(outsidePre(markdown)).not.toContain("```");
  });

  test("link targets in untrusted text are not active links", async () => {
    const s = await setup("link-injection", {
      statement: "[click](javascript:alert(1))",
      claims: [claim("C1", ["R1"], "[x](javascript:alert(9)) https://evil.example")],
    });
    await appendCheck(s.store, s.receipt());
    const markdown = renderMarkdown(replayAudit(await readAudit(s.store)));
    expect(outsidePre(markdown)).not.toContain("javascript:");
  });
});

describe("report content and agreement", () => {
  test("JSON and Markdown agree on evidence IDs and scope", async () => {
    const s = await setup("ids");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    await appendCheck(s.store, s.receipt({ checkId: "chk-2" }));
    const report = replayAudit(await readAudit(s.store));
    const markdown = renderMarkdown(report);
    const json = JSON.parse(renderJson(report)) as any;

    for (const record of report.records) {
      expect(markdown).toContain(record.checkId);
      expect(json.records.some((r: any) => r.checkId === record.checkId)).toBe(true);
    }
    for (const item of report.verdict.criteria) {
      expect(markdown).toContain(item.id);
      expect(json.verdict.criteria.some((c: any) => c.id === item.id)).toBe(true);
    }
    expect(markdown).toContain("artifact.txt");
    expect(json.task.scope.paths).toContain("artifact.txt");
  });

  test("missing output is shown as blocked, never synthesized", async () => {
    const s = await setup("blocked-output");
    await appendCheck(
      s.store,
      s.receipt({ checkId: "chk-blocked", completion: "BLOCKED", result: "UNKNOWN", output: undefined }),
    );
    const report = replayAudit(await readAudit(s.store));
    const record = report.records[0]!;
    expect(record.output).toBeNull();
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("BLOCKED");
    expect(markdown).toContain("(no output captured)");
  });

  test("integrity and trust limitations are explicit and captured executions are zero", async () => {
    const s = await setup("limits");
    await appendCheck(s.store, s.receipt());
    const report = replayAudit(await readAudit(s.store));
    expect(report.trust.trustedExecutionCaptures).toBe(0);
    expect(report.store.chainValid).toBe(true);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("hash chain");
    expect(markdown).toContain("trusted execution captures: 0");
    expect(markdown).toContain("delta");
    expect(markdown).toContain("not an authenticated attestation");
  });

  test("a forged RUNNER_CAPTURED receipt cannot appear as captured execution", async () => {
    const s = await setup("forged-report");
    await appendCheck(
      s.store,
      s.receipt({ origin: "RUNNER_CAPTURED", completion: "COMPLETED", result: "PASS" }),
    );
    const report = replayAudit(await readAudit(s.store));
    expect(report.records.every((r) => r.effectiveOrigin !== "RUNNER_CAPTURED")).toBe(true);
    expect(report.verdict.overall).toBe("INCOMPLETE_EVIDENCE");
    const markdown = renderMarkdown(report);
    expect(outsidePre(markdown)).toContain("INCOMPLETE_EVIDENCE");
    expect(outsidePre(markdown)).not.toContain("RUNNER_CAPTURED evidence");
  });
});

describe("fail closed on broken integrity", () => {
  test("a broken hash chain fails the report closed", async () => {
    const s = await setup("broken-chain");
    await appendCheck(s.store, s.receipt({ checkId: "chk-1" }));
    const file = join(s.root, "records", "chk-1.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.result = "FAIL";
    writeFileSync(file, JSON.stringify(record));

    const records = await readAudit(s.store);
    expect(records.integrity.chainValid).toBe(false);
    const report = replayAudit(records);
    expect(report.valid).toBe(false);
    expect(report.verdict.overall).toBe("INCOMPLETE_EVIDENCE");
    const markdown = renderMarkdown(report);
    expect(outsidePre(markdown)).not.toContain("VERIFIED_WITHIN_SCOPE");
    expect(markdown.toLowerCase()).toContain("integrity");
  });
});

describe("terminal lifecycle and predicate limitations", () => {
  test("a cancelled check surfaces as a terminal lifecycle in the report", async () => {
    const s = await setup("terminal-report");
    await appendCheck(
      s.store,
      s.receipt({
        checkId: "chk-cancel",
        completion: "CANCELLED",
        result: "UNKNOWN",
        exitCode: undefined,
      }),
    );
    const report = replayAudit(await readAudit(s.store));
    expect(report.store.lifecycle).toBe("CANCELLED");
    expect(report.records[0]!.terminal).toBe(true);
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("lifecycle: CANCELLED");
    expect(markdown).toContain("terminal: yes");
    const json = JSON.parse(renderJson(report)) as any;
    expect(json.store.lifecycle).toBe("CANCELLED");
    expect(json.records[0].terminal).toBe(true);
    expect(report.verdict.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("the report states the artifact predicate and terminal limitations", async () => {
    const s = await setup("predicate-limitation");
    await appendCheck(s.store, s.receipt());
    const markdown = renderMarkdown(replayAudit(await readAudit(s.store)));
    expect(markdown).toContain("registered byte-level predicate");
    expect(markdown).toContain("store-level terminal state");
  });
});

describe("round-2: predicate reporting and redaction mapping", () => {
  test("the report shows a criterion's registered artifact predicate", async () => {
    const s = await setup("predicate-shown", {
      criteria: [
        criterion("R1", {
          acceptanceType: "ARTIFACT",
          artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
        }),
      ],
    });
    await appendCheck(s.store, s.receipt());
    const report = replayAudit(await readAudit(s.store));
    const markdown = renderMarkdown(report);
    expect(markdown).toContain("predicate:");
    expect(markdown).toContain("artifact.txt");
    expect(markdown).toContain("registered artifact predicate");
    const json = JSON.parse(renderJson(report)) as any;
    expect(json.task.criteria[0].artifactExpectation.path).toBe("artifact.txt");
  });

  test("a redacted span is annotated and never claims to be the exact original", async () => {
    const canary = "opaque-canary-report";
    const originalText = `token=${canary}`;
    const s = await setup("redacted-span", {
      criteria: [criterion("R1", { text: originalText })],
    });
    await appendCheck(s.store, s.receipt());
    const report = replayAudit(await readAudit(s.store));
    const span = report.task!.criteria[0]!.span;
    expect(span.redacted).toBe(true);
    expect(span.originalStart).toBe(0);
    expect(span.originalEnd).toBe(originalText.length);
    const markdown = renderMarkdown(report);
    expect(markdown).not.toContain(canary);
    expect(markdown).toContain("redacted display");
    expect(markdown).toContain("not the exact original span");
  });
});
