/**
 * Task 5 actual-host gate.
 *
 * Exercises the *installed* OpenCode 1.18.13 host against the *built*
 * default-only plugin entry (`dist/plugin.js`) in an isolated config, with a
 * real provider-backed `session.prompt` asking the model to invoke the manual
 * audit tool. It then reads the saved audit back and compares task/candidate.
 *
 * Isolation:
 *   - HOME / XDG_CONFIG_HOME / temp are redirected under
 *     `audit-build/task5-fixtures/host/isolated`.
 *   - Provider access is preserved by pointing XDG_DATA_HOME at the host's real
 *     OpenCode data directory (where the already-configured credentials live).
 *     Credentials are never read, copied or printed.
 *   - Every fixture, capture and probe file stays under
 *     `audit-build/task5-fixtures`.
 *
 * Bounds: a 120 s prompt cap and a 5 min total probe cap. If the provider or
 * the tool is unavailable the script records the exact blocker and stops —
 * it never substitutes a mock or a shell invocation for a model tool call.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const WORKSPACE = resolve(import.meta.dir, "..");
const FIXTURES = join(WORKSPACE, "audit-build", "task5-fixtures", "host");
const REPO = join(FIXTURES, "repo");
const ISOLATED = join(FIXTURES, "isolated");
const HOME_DIR = join(ISOLATED, "home");
const CONFIG_DIR = join(HOME_DIR, ".config", "opencode");
const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");
const CAPTURE_DIR = join(FIXTURES, "captures");
const AUDIT_BASE = join(FIXTURES, "store");
const CONFIRMED_TASK_PATH = join(AUDIT_BASE, "confirmed-task.json");
const PLUGIN_ENTRY = join(WORKSPACE, "dist", "plugin.js");
const RESULT_PATH = join(FIXTURES, "host-probe.json");
const LOG_PATH = join(WORKSPACE, "audit-build", "logs", "task5-host-integration.log");

const PROVIDER_ID = "opencode-go";
const MODEL_ID = "deepseek-v4.1-flash";
const PROMPT_TIMEOUT_MS = 120_000;
const TOTAL_BUDGET_MS = 5 * 60_000;
const TASK_ID = "task-5";
const TASK_REVISION = "rev-1";
const TASK_TEXT = "Deliver artifact.txt with the exact payload.";
const ARTIFACT_CONTENT = "artifact payload\n";

const lines: string[] = [];
function log(message: string): void {
  lines.push(message);
  console.log(message);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(args: string[]): void {
  const result = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function prepareFixture(): void {
  rmSync(FIXTURES, { recursive: true, force: true });
  for (const dir of [REPO, CONFIG_DIR, CAPTURE_DIR, join(HOME_DIR, "tmp"), join(HOME_DIR, ".cache")]) {
    mkdirSync(dir, { recursive: true });
  }
  runGit(["init", "-q", "-b", "main"]);
  runGit(["config", "core.autocrlf", "false"]);
  writeFileSync(join(REPO, "base.txt"), "base content\n");
  runGit(["-c", "user.email=audit@test.local", "-c", "user.name=audit-test", "add", "-A"]);
  runGit(["-c", "user.email=audit@test.local", "-c", "user.name=audit-test", "commit", "-qm", "init"]);
  writeFileSync(join(REPO, "artifact.txt"), ARTIFACT_CONTENT);
  mkdirSync(AUDIT_BASE, { recursive: true });
  const confirmedTask = {
    schemaVersion: 1,
    taskId: TASK_ID,
    taskRevision: TASK_REVISION,
    statement: TASK_TEXT,
    criteria: [
      {
        id: "R1",
        span: { text: "artifact.txt", start: TASK_TEXT.indexOf("artifact.txt"), end: TASK_TEXT.indexOf("artifact.txt") + "artifact.txt".length },
        required: true,
        acceptanceType: "ARTIFACT",
        artifactExpectation: { path: "artifact.txt", presence: "present", digest: sha256Hex(ARTIFACT_CONTENT) },
      },
    ],
  };
  writeFileSync(CONFIRMED_TASK_PATH, `${JSON.stringify(confirmedTask, null, 2)}\n`, "utf8");
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [
      [
        pathToFileURL(PLUGIN_ENTRY).href,
        { auditBaseRoot: AUDIT_BASE, auditConfirmedTaskFile: CONFIRMED_TASK_PATH },
      ],
    ],
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isolatedEnv(): Record<string, string> {
  const realHome = process.env["USERPROFILE"] ?? process.env["HOME"] ?? homedir();
  const realData = process.env["XDG_DATA_HOME"] ?? join(realHome, ".local", "share");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  env.HOME = HOME_DIR;
  env.USERPROFILE = HOME_DIR;
  env.XDG_CONFIG_HOME = join(HOME_DIR, ".config");
  env.XDG_DATA_HOME = realData;
  env.XDG_CACHE_HOME = join(HOME_DIR, ".cache");
  env.TMPDIR = join(HOME_DIR, "tmp");
  env.TMP = join(HOME_DIR, "tmp");
  env.TEMP = join(HOME_DIR, "tmp");
  return env;
}

function opencodeBin(): string {
  return process.env["OPENCODE_BIN"] ?? "opencode";
}

function readCapped(path: string, cap: number): string {
  try {
    const buffer = readFileSync(path);
    return buffer.subarray(0, Math.min(cap, buffer.byteLength)).toString("utf8");
  } catch {
    return "";
  }
}

async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  if (!existsSyncSafe(PLUGIN_ENTRY)) {
    throw new Error(`built plugin entry is missing (${PLUGIN_ENTRY}); run bun run build`);
  }
  prepareFixture();

  const outPath = join(CAPTURE_DIR, "serve.out.txt");
  const errPath = join(CAPTURE_DIR, "serve.err.txt");
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  const env = isolatedEnv();
  const proc = Bun.spawn([opencodeBin(), "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: REPO,
    env,
    stdin: "ignore",
    stdout: outFd,
    stderr: errFd,
  });
  closeSync(outFd);
  closeSync(errFd);

  const result: Record<string, unknown> = {
    hostVersion: "unknown",
    pluginEntry: PLUGIN_ENTRY,
    provider: `${PROVIDER_ID}/${MODEL_ID}`,
    url: null,
    agents: null,
    tools: null,
    sessionCreate: { ok: false },
    prompt: { attempted: false, completed: false },
    toolCalls: [],
    auditReadback: null,
    status: "blocked",
    blocker: null,
    elapsedMs: 0,
    isolation: {
      home: HOME_DIR,
      xdgDataHome: env.XDG_DATA_HOME,
      note: "provider access preserved via XDG_DATA_HOME; no credential value was read or printed",
    },
  };

  try {
    const url = await waitFor(
      () => readCapped(outPath, 64 * 1024).match(/listening on (http:\/\/\S+)/)?.[1],
      45_000,
    );
    result.url = url;
    const client = createOpencodeClient({ baseUrl: url });

    const version = spawnSync(opencodeBin(), ["--version"], { encoding: "utf8", env });
    result.hostVersion = (version.stdout ?? "").trim() || "unknown";

    try {
      const agents = await withTimeout(client.app.agents(), 15_000, "app.agents");
      const list = (agents.data ?? []) as Array<{ name?: string }>;
      result.agents = { count: list.length, teamAgents: list.map((a) => a.name ?? "").filter((n) => n.startsWith("team/")) };
    } catch (error) {
      result.agents = { error: messageOf(error) };
    }

    try {
      const ids = await withTimeout(client.tool.ids(), 15_000, "tool.ids");
      const list = (ids.data ?? []) as string[];
      result.tools = { count: list.length, auditTools: list.filter((n) => n.includes("teamwork_audit")), teamworkTools: list.filter((n) => n.startsWith("teamwork_")) };
    } catch (error) {
      result.tools = { error: messageOf(error) };
    }

    let sessionId: string | undefined;
    try {
      const created = await withTimeout(client.session.create({ body: { title: "audit-host-gate" } }), 15_000, "session.create");
      sessionId = created.data?.id;
      result.sessionCreate = sessionId ? { ok: true, id: sessionId } : { ok: false, error: "no session id" };
    } catch (error) {
      result.sessionCreate = { ok: false, error: messageOf(error) };
    }

    if (sessionId) {
      const promptText = buildPrompt();
      result.prompt.attempted = true;
      try {
        await withTimeout(
          client.session.prompt({
            path: { id: sessionId },
            body: {
              model: { providerID: PROVIDER_ID, modelID: MODEL_ID },
              tools: {
                teamwork_audit_plan: true,
                teamwork_audit_check: true,
                teamwork_audit_report: true,
              },
              parts: [{ type: "text", text: promptText }],
            },
          }),
          PROMPT_TIMEOUT_MS,
          "provider-backed model invocation",
        );
        result.prompt.completed = true;
        result.toolCalls = await extractToolCalls(client, sessionId);
      } catch (error) {
        result.prompt = { attempted: true, completed: false, error: messageOf(error) };
      }
    }

    const readback = readAuditReadback();
    result.auditReadback = readback;
    const verified =
      readback !== null &&
      readback.reportExists === true &&
      readback.taskMatches === true &&
      readback.candidateMatches === true &&
      readback.overall === "VERIFIED_WITHIN_SCOPE" &&
      readback.taskConfirmation === "HUMAN_CONFIRMED";
    if (verified) {
      result.status = "ok";
    } else if (!result.prompt.completed) {
      result.status = "blocked";
      result.blocker = (result.prompt as { error?: string }).error ?? "model invocation did not complete";
    } else {
      result.status = "blocked";
      result.blocker =
        readback === null
          ? "model invocation completed but no saved audit registry entry was produced"
          : `saved audit did not verify: overall=${String(readback.overall)} confirmation=${String(readback.taskConfirmation)}`;
    }
  } catch (error) {
    result.status = "blocked";
    result.blocker = messageOf(error);
  } finally {
    await killTree(proc.pid);
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
  }

  result.elapsedMs = Date.now() - started;
  result.withinBudget = result.elapsedMs <= TOTAL_BUDGET_MS;
  writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  writeFileSync(join(CAPTURE_DIR, "serve.out.final.txt"), readCapped(outPath, 256 * 1024), "utf8");
  writeFileSync(join(CAPTURE_DIR, "serve.err.final.txt"), readCapped(errPath, 256 * 1024), "utf8");
  log(`status=${result.status} host=${result.hostVersion} provider=${PROVIDER_ID}/${MODEL_ID}`);
  log(`prompt=${JSON.stringify(result.prompt)}`);
  log(`toolCalls=${JSON.stringify(result.toolCalls)}`);
  log(`auditReadback=${JSON.stringify(result.auditReadback)}`);
  if (result.blocker) log(`BLOCKER: ${result.blocker}`);
  writeFileSync(LOG_PATH, `${lines.join("\n")}\n`, "utf8");
  if (result.status !== "ok") process.exitCode = 2;
}

async function extractToolCalls(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const messages = await withTimeout(
      client.session.messages({ path: { id: sessionId } }),
      20_000,
      "session.messages",
    );
    const rows = (messages.data ?? []) as Array<{ parts?: Array<Record<string, unknown>> }>;
    const calls: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      for (const part of row.parts ?? []) {
        if (part["type"] !== "tool") continue;
        const state = (part["state"] ?? {}) as Record<string, unknown>;
        calls.push({
          tool: part["tool"],
          status: state["status"] ?? null,
          input: state["input"] ?? null,
        });
      }
    }
    return calls;
  } catch (error) {
    return [{ error: messageOf(error) }];
  }
}

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for opencode serve");
    await Bun.sleep(250);
  }
}

function buildPrompt(): string {
  const planArgs = {
    taskId: TASK_ID,
    taskRevision: TASK_REVISION,
    taskText: TASK_TEXT,
    scopeDescription: "disposable host fixture repo",
  };
  return [
    "You must invoke the manual audit tools. Do not use any other tool. Do not explain.",
    "Step 1: call `teamwork_audit_plan` exactly once with this JSON arguments object:",
    JSON.stringify(planArgs),
    "Step 2: read the `auditId` from the plan result.",
    "Step 3: call `teamwork_audit_check` with {\"auditId\": <that id>, \"kind\": \"artifact\", \"criterionIds\": [\"R1\"], \"path\": \"artifact.txt\"}.",
    "Step 4: call `teamwork_audit_report` with {\"auditId\": <that same id>}.",
    "Then stop.",
  ].join("\n");
}

function readAuditReadback(): Record<string, unknown> | null {
  let registry: { audits?: Record<string, Record<string, unknown>> };
  try {
    registry = JSON.parse(readFileSync(join(AUDIT_BASE, "registry.json"), "utf8")) as typeof registry;
  } catch {
    return null;
  }
  const audits = Object.values(registry.audits ?? {});
  if (audits.length === 0) return null;
  const entry = audits[audits.length - 1]!;
  const auditId = String(entry["auditId"]);
  const root = String(entry["root"]);
  const reportPath = join(root, "report.json");
  let report: Record<string, unknown> | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  } catch {
    report = null;
  }
  let originalTaskText: string | null = null;
  try {
    originalTaskText = readFileSync(join(root, "original-task.txt"), "utf8");
  } catch {
    originalTaskText = null;
  }
  let manifestCandidate: string | null = null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "store", "snapshots", "snapshot", "manifest.json"), "utf8")) as Record<string, unknown>;
    manifestCandidate = String(manifest["candidateId"]);
  } catch {
    manifestCandidate = null;
  }
  const verdict = (report?.["verdict"] ?? {}) as Record<string, unknown>;
  return {
    auditId,
    reportExists: report !== null,
    reportPath,
    overall: verdict["overall"] ?? null,
    taskId: entry["taskId"] ?? null,
    candidateId: entry["candidateId"] ?? null,
    manifestCandidate,
    taskConfirmation: entry["confirmation"] ?? "UNCONFIRMED",
    taskMatches: entry["taskId"] === TASK_ID && entry["taskRevision"] === TASK_REVISION,
    candidateMatches: manifestCandidate !== null && manifestCandidate === entry["candidateId"],
    originalTaskPreserved: originalTaskText === TASK_TEXT,
    taskIdsMatch: report !== null,
  };
}

if (import.meta.main) {
  await main();
}
