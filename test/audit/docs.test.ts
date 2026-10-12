/**
 * Task 6 — validate the documented OpenCode configuration and exercise the
 * exact documented manual static flow in a disposable fixture.
 *
 * The documented example config is loaded verbatim, its placeholders are
 * substituted with real disposable paths, and the documented
 * auditBaseRoot + auditConfirmedTaskFile options are used to plan/check/report.
 * This proves the README's configuration is usable, not merely illustrative.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfirmedTaskSchema, createAuditTools } from "../../src/audit/tools.js";

setDefaultTimeout(60_000);

const WORKSPACE = process.cwd();
const DOCS = join(WORKSPACE, "docs", "audit");
const SCRATCH = join(WORKSPACE, "audit-build", "docs-fixtures");
let seq = 0;

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ToolMap = Record<string, { execute: (args: any, context: any) => Promise<any> }>;

describe("documented configuration", () => {
  test("the example config and confirmed-task files are valid JSON with the documented shape", () => {
    const config = JSON.parse(readFileSync(join(DOCS, "opencode.config.example.json"), "utf8"));
    expect(Array.isArray(config.plugin)).toBe(true);
    const [entry, rawOptions] = config.plugin[0];
    expect(typeof entry).toBe("string");
    expect(typeof rawOptions.auditBaseRoot).toBe("string");
    expect(typeof rawOptions.auditConfirmedTaskFile).toBe("string");

    const task = JSON.parse(readFileSync(join(DOCS, "confirmed-task.example.json"), "utf8"));
    expect(ConfirmedTaskSchema.safeParse({ ...task, criteria: task.criteria.map((c: any) => ({ ...c, artifactExpectation: { ...c.artifactExpectation, digest: sha256Hex("artifact payload\n") } })) }).success).toBe(true);
  });

  test("the docs state honest package/version/evaluation scope", () => {
    const readme = readFileSync(join(DOCS, "README.md"), "utf8");
    const flat = readme.replace(/\s+/g, " ").toLowerCase();
    expect(readme).not.toMatch(/1\.18\.13[^\n]*or newer/i);
    expect(flat).toContain("unverified");
    expect(flat).toContain("regression");
    expect(flat).toContain("not included in the published package");
    expect(flat).toContain("metadata only");
  });

  test("the documented static flow verifies in a disposable fixture", async () => {
    const dir = join(SCRATCH, `${process.pid}-${seq++}`);
    rmSync(dir, { recursive: true, force: true });
    const repo = join(dir, "repo");
    const base = join(dir, "verify-store");
    mkdirSync(repo, { recursive: true });
    mkdirSync(base, { recursive: true });

    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(repo, "base.txt"), "base content\n");
    const identity = ["-c", "user.email=audit@test.local", "-c", "user.name=audit-test"];
    git(repo, [...identity, "add", "-A"]);
    git(repo, [...identity, "commit", "-qm", "init"]);
    const content = "artifact payload\n";
    writeFileSync(join(repo, "artifact.txt"), content);

    // Substitute the documented placeholders with real disposable paths.
    const jsonPath = (value: string): string => JSON.stringify(value).slice(1, -1);
    const configText = readFileSync(join(DOCS, "opencode.config.example.json"), "utf8")
      .replace("<PLUGIN_ENTRY_FILE_URL>", pathToFileURL(join(WORKSPACE, "dist", "plugin.js")).href)
      .replace("<ABSOLUTE_AUDIT_BASE_ROOT>", jsonPath(base))
      .replace("<ABSOLUTE_CONFIRMED_TASK_FILE>", jsonPath(join(dir, "confirmed-task.json")));
    const config = JSON.parse(configText);
    const options = config.plugin[0][1];

    const taskText = readFileSync(join(DOCS, "confirmed-task.example.json"), "utf8").replace(
      "<ARTIFACT_SHA256>",
      sha256Hex(content),
    );
    writeFileSync(options.auditConfirmedTaskFile, `${taskText}\n`, "utf8");
    const confirmedTask = ConfirmedTaskSchema.parse(JSON.parse(taskText));

    const tools = createAuditTools({
      directory: repo,
      auditBaseRoot: options.auditBaseRoot,
      confirmedTasks: [confirmedTask],
    }) as unknown as ToolMap;
    const context = {
      sessionID: "docs-session",
      messageID: "docs-message",
      agent: "team/verifier",
      directory: repo,
      worktree: repo,
      abort: new AbortController().signal,
      metadata() {},
      ask: async () => {},
    };

    const plan = await tools["teamwork_audit_plan"]!.execute(
      {
        taskId: confirmedTask.taskId,
        taskRevision: confirmedTask.taskRevision,
        taskText: confirmedTask.statement,
        scopeDescription: "documented example",
      },
      context,
    );
    expect(plan.metadata.taskConfirmation).toBe("HUMAN_CONFIRMED");
    const auditId = plan.metadata.auditId as string;

    const check = await tools["teamwork_audit_check"]!.execute(
      { auditId, kind: "artifact", criterionIds: ["R1"], path: "artifact.txt" },
      context,
    );
    expect(check.metadata.result).toBe("PASS");

    const report = await tools["teamwork_audit_report"]!.execute({ auditId }, context);
    expect(report.metadata.overall).toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.metadata.taskConfirmation).toBe("HUMAN_CONFIRMED");
    expect(report.metadata.missingCriteria).toEqual([]);

    // Persist the report readback as evidence for the isolated branch.
    const logsDir = join(WORKSPACE, "audit-build", "logs");
    mkdirSync(logsDir, { recursive: true });
    copyFileSync(report.metadata.reportPath as string, join(logsDir, "task6-docs-report.md"));
    copyFileSync(report.metadata.jsonPath as string, join(logsDir, "task6-docs-report.json"));

    rmSync(dir, { recursive: true, force: true });
  });
});
