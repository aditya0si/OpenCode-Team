/**
 * Task 0 compatibility probe — black-box only.
 *
 * Reproducibly exercises the *installed* OpenCode host against this package's
 * built entries. Every artifact, config, cache, state and temp path is kept
 * under `audit-build/compatibility`; the parent environment's credentials and
 * the writer's auth configuration are never copied into the child.
 *
 * Modes:
 *   bun scripts/audit-compatibility.ts load    # plugin-load contract (RED/GREEN)
 *   bun scripts/audit-compatibility.ts serve   # isolated `opencode serve` + SDK
 *   bun scripts/audit-compatibility.ts all     # both (default)
 */

import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

export const WORKSPACE = resolve(import.meta.dir, "..");
export const COMPAT_DIR = join(WORKSPACE, "audit-build", "compatibility");
export const HOME_DIR = join(COMPAT_DIR, "home");
export const CONFIG_DIR = join(HOME_DIR, ".config", "opencode");
export const CONFIG_PATH = join(CONFIG_DIR, "opencode.json");
export const EVIDENCE_DIR = join(COMPAT_DIR, "evidence");
export const PROBE_DIR = join(COMPAT_DIR, "probes");

export const DIRECT_ENTRY = join(WORKSPACE, "dist", "index.js");
export const ADAPTER_ENTRY = join(WORKSPACE, "dist", "plugin.js");

/**
 * Every child process MUST run through `runBounded`: a hard wall-clock timeout,
 * a hard cap on captured bytes, a whole-process-tree kill, and explicit stream
 * cancellation. Awaiting stream EOF alone is unsafe — a grandchild that inherits
 * the pipe handle keeps EOF from ever arriving (observed as an 80-minute hang).
 */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 256 * 1024;

const CREDENTIAL_PATTERNS = [
  /^OPENCODE_/i,
  /_API_KEY$/i,
  /_TOKEN$/i,
  /^AWS_/i,
  /^ANTHROPIC/i,
  /^OPENAI/i,
  /^GEMINI/i,
  /^GOOGLE/i,
  /^AZURE/i,
  /^NPM_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
];

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface PluginLoadObservation {
  case: string;
  spec: string;
  exitCode: number;
  loaded: boolean;
  loadErrorMessage: string | null;
  teamAgents: string[];
  timedOut: boolean;
}

export interface ServeProbeResult {
  url: string | null;
  hostVersion: string;
  agents: { count: number; teamAgents: string[] } | { error: string };
  toolIds: { count: number; teamworkTools: string[] } | { error: string };
  sessionCreate: { ok: boolean; id?: string; error?: string };
  sessionAbort: { status?: number; error?: string };
  childSession: { ok: boolean; parentID?: string; error?: string };
  shellTool: { status?: number; tool?: string; output?: string; error?: string };
  prompt: { attempted: boolean; completed: boolean; error?: string };
}

export function ensureDirs(): void {
  for (const dir of [HOME_DIR, CONFIG_DIR, EVIDENCE_DIR, PROBE_DIR, join(HOME_DIR, "tmp")]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function buildIsolatedEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  env.HOME = HOME_DIR;
  env.USERPROFILE = HOME_DIR;
  env.XDG_CONFIG_HOME = join(HOME_DIR, ".config");
  env.XDG_DATA_HOME = join(HOME_DIR, ".local", "share");
  env.XDG_CACHE_HOME = join(HOME_DIR, ".cache");
  env.XDG_STATE_HOME = join(HOME_DIR, ".local", "state");
  env.TMPDIR = join(HOME_DIR, "tmp");
  env.TMP = join(HOME_DIR, "tmp");
  env.TEMP = join(HOME_DIR, "tmp");
  return { ...env, ...overrides };
}

export function writeIsolatedConfig(spec: string): void {
  ensureDirs();
  const config = { $schema: "https://opencode.ai/config.json", plugin: [spec] };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export function pluginSpec(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

export function writeEvidence(name: string, content: string): string {
  ensureDirs();
  const path = join(EVIDENCE_DIR, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

export function writeProbeModule(name: string, source: string): string {
  ensureDirs();
  const path = join(PROBE_DIR, `${name}.mjs`);
  writeFileSync(path, source, "utf-8");
  return path;
}

function opencodeBin(): string {
  return process.env.OPENCODE_BIN ?? Bun.which("opencode") ?? "opencode";
}

interface CaptureState {
  text: string;
  truncated: boolean;
}

let captureSeq = 0;

function capturePaths(): { out: string; err: string } {
  ensureDirs();
  captureSeq += 1;
  const stem = join(PROBE_DIR, `capture-${process.pid}-${captureSeq}`);
  return { out: `${stem}.out.txt`, err: `${stem}.err.txt` };
}

/**
 * Reads at most `cap` bytes from a capture file. File-backed capture avoids the
 * pipe EOF problem entirely: a grandchild that inherits the pipe handle can no
 * longer keep us blocked waiting for a stream to close.
 */
export function readCappedFile(path: string, cap: number): CaptureState {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const readLen = Math.min(cap, size);
    const buffer = Buffer.allocUnsafe(readLen);
    const bytes = readSync(fd, buffer, 0, readLen, 0);
    return { text: buffer.subarray(0, bytes).toString("utf-8"), truncated: size > bytes };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** Kills the direct child and, on Windows, the whole process tree. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const killer = Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await Promise.race([killer.exited, Bun.sleep(3_000)]);
    } catch {
      // taskkill unavailable; fall through
    }
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

export interface RunBoundedOptions {
  timeoutMs?: number;
  maxBytes?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** `.cmd`/`.bat` shims reject args containing cmd special chars; route via cmd.exe. */
function spawnArgv(command: string, args: string[]): string[] {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command, ...args];
  }
  return [command, ...args];
}

/**
 * Runs a command with a hard timeout and bounded, file-backed output capture.
 * Always resolves: stdout/stderr go to files, so there is no pipe EOF to await,
 * and the child tree is force-killed on timeout.
 */
export async function runBounded(
  command: string,
  args: string[],
  options: RunBoundedOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = options.maxBytes ?? MAX_OUTPUT_BYTES;
  const { out: outPath, err: errPath } = capturePaths();

  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");

  const proc = (() => {
    try {
      return Bun.spawn(spawnArgv(command, args), {
        cwd: options.cwd ?? WORKSPACE,
        env: options.env ?? buildIsolatedEnv(),
        stdin: "ignore",
        stdout: outFd,
        stderr: errFd,
      });
    } finally {
      // The child holds its own duplicated handles; the parent copies can close.
      closeSync(outFd);
      closeSync(errFd);
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const winner = await Promise.race([
    proc.exited.then(() => "exit" as const),
    deadline.then(() => "timeout" as const),
  ]);

  let timedOut = false;
  if (winner === "timeout") {
    timedOut = true;
    await killTree(proc.pid);
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
  }
  if (timer) clearTimeout(timer);

  const out = readCappedFile(outPath, cap);
  const err = readCappedFile(errPath, cap);
  for (const path of [outPath, errPath]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // a detached grandchild may still hold the handle; harmless
    }
  }
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: out.text,
    stderr: err.text,
    timedOut,
    truncated: out.truncated || err.truncated,
  };
}

export async function runOpencode(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return runBounded(opencodeBin(), args, { timeoutMs: options.timeoutMs });
}

export function parseTeamAgents(stdout: string): string[] {
  return [...stdout.matchAll(/^team\/[^\s(]+/gm)].map((match) => match[0]);
}

export function parseLoadError(stderr: string): string | null {
  const match = stderr.match(/failed to load plugin[\s\S]*?error="([^"]+)"/);
  return match?.[1] ?? null;
}

export async function observePluginLoad(name: string, spec: string): Promise<PluginLoadObservation> {
  writeIsolatedConfig(spec);
  const result = await runOpencode(["agent", "list", "--print-logs", "--log-level", "ERROR"]);
  const loadErrorMessage =
    result.timedOut ? `probe timed out after ${DEFAULT_TIMEOUT_MS}ms` : parseLoadError(result.stderr);
  const teamAgents = result.timedOut ? [] : parseTeamAgents(result.stdout);
  const observation: PluginLoadObservation = {
    case: name,
    spec,
    exitCode: result.exitCode,
    loaded: loadErrorMessage === null,
    loadErrorMessage,
    teamAgents,
    timedOut: result.timedOut,
  };
  writeEvidence(`${name}.out.txt`, result.stdout);
  writeEvidence(`${name}.err.txt`, result.stderr);
  writeEvidence(`${name}.json`, `${JSON.stringify(observation, null, 2)}\n`);
  return observation;
}

export async function runPluginLoadProbes(): Promise<PluginLoadObservation[]> {
  ensureDirs();
  const malformed = writeProbeModule("malformed-default", "export default 42;\n");
  const unsafeWrapper = writeProbeModule(
    "unsafe-wrapper",
    `import real from ${JSON.stringify(pluginSpec(ADAPTER_ENTRY))};\nexport default real;\nexport const meta = { unsafe: true };\n`,
  );

  const observations = [
    await observePluginLoad("direct-entry", pluginSpec(DIRECT_ENTRY)),
    await observePluginLoad("adapter-entry", pluginSpec(ADAPTER_ENTRY)),
    await observePluginLoad("malformed-default", pluginSpec(malformed)),
    await observePluginLoad("unsafe-wrapper", pluginSpec(unsafeWrapper)),
  ];

  writeEvidence("plugin-load-summary.json", `${JSON.stringify(observations, null, 2)}\n`);
  return observations;
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

/** Bounds any promise; the underlying request is abandoned, not awaited. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runServeProbes(): Promise<ServeProbeResult> {
  ensureDirs();
  writeIsolatedConfig(pluginSpec(ADAPTER_ENTRY));

  const hostVersion = (await runOpencode(["--version"], { timeoutMs: 30_000 })).stdout.trim();

  const { out: serveOutPath, err: serveErrPath } = capturePaths();
  const serveOutFd = openSync(serveOutPath, "w");
  const serveErrFd = openSync(serveErrPath, "w");
  const proc = Bun.spawn([opencodeBin(), "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: WORKSPACE,
    env: buildIsolatedEnv(),
    stdin: "ignore",
    stdout: serveOutFd,
    stderr: serveErrFd,
  });
  closeSync(serveOutFd);
  closeSync(serveErrFd);

  const serveOut = (): CaptureState => readCappedFile(serveOutPath, MAX_OUTPUT_BYTES);
  const serveErr = (): CaptureState => readCappedFile(serveErrPath, MAX_OUTPUT_BYTES);

  const result: ServeProbeResult = {
    url: null,
    hostVersion,
    agents: { error: "not probed" },
    toolIds: { error: "not probed" },
    sessionCreate: { ok: false },
    sessionAbort: {},
    childSession: { ok: false },
    shellTool: {},
    prompt: { attempted: false, completed: false },
  };

  try {
    result.url = await waitFor(() => serveOut().text.match(/listening on (http:\/\/\S+)/)?.[1], 45_000);
    const client = createOpencodeClient({ baseUrl: result.url });

    try {
      const agentsResponse = await withTimeout(client.app.agents(), 15_000, "app.agents");
      const agents = (agentsResponse.data ?? []) as Array<{ name?: string }>;
      result.agents = {
        count: agents.length,
        teamAgents: agents.map((agent) => agent.name ?? "").filter((name) => name.startsWith("team/")),
      };
    } catch (error) {
      result.agents = { error: messageOf(error) };
    }

    try {
      const idsResponse = await withTimeout(client.tool.ids(), 15_000, "tool.ids");
      const ids = (idsResponse.data ?? []) as string[];
      result.toolIds = {
        count: ids.length,
        teamworkTools: ids.filter((id) => id.includes("teamwork")),
      };
    } catch (error) {
      result.toolIds = { error: messageOf(error) };
    }

    let sessionId: string | undefined;
    try {
      const created = await withTimeout(
        client.session.create({ body: { title: "audit-compat" } }),
        15_000,
        "session.create",
      );
      sessionId = created.data?.id;
      result.sessionCreate = sessionId ? { ok: true, id: sessionId } : { ok: false, error: "no session id" };
    } catch (error) {
      result.sessionCreate = { ok: false, error: messageOf(error) };
    }

    if (sessionId) {
      try {
        const aborted = await withTimeout(
          client.session.abort({ path: { id: sessionId } }),
          15_000,
          "session.abort",
        );
        result.sessionAbort = { status: aborted.response?.status };
      } catch (error) {
        result.sessionAbort = { error: messageOf(error) };
      }

      try {
        const child = await withTimeout(
          client.session.create({ body: { parentID: sessionId, title: "audit-compat-child" } }),
          15_000,
          "session.create.child",
        );
        result.childSession = child.data?.id
          ? { ok: true, parentID: child.data.parentID }
          : { ok: false, error: "no child id" };
      } catch (error) {
        result.childSession = { ok: false, error: messageOf(error) };
      }

      try {
        const shell = await withTimeout(
          client.session.shell({
            path: { id: sessionId },
            body: { agent: "build", command: "echo audit-compat-probe" },
          }),
          30_000,
          "session.shell",
        );
        const part = (shell.data?.parts ?? []).find((entry) => entry.type === "tool") as
          | { tool?: string; state?: { output?: string } }
          | undefined;
        result.shellTool = {
          status: shell.response?.status,
          tool: part?.tool,
          output: part?.state?.output,
        };
      } catch (error) {
        result.shellTool = { error: messageOf(error) };
      }

      result.prompt.attempted = true;
      try {
        await withTimeout(
          client.session.prompt({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: "audit-compat-ping" }] },
          }),
          12_000,
          "live model invocation",
        );
        result.prompt.completed = true;
      } catch (error) {
        result.prompt.error = messageOf(error);
      }
    }
  } catch (error) {
    result.prompt.error = result.prompt.error ?? messageOf(error);
  } finally {
    await killTree(proc.pid);
    await Promise.race([proc.exited, Bun.sleep(3_000)]);
  }

  writeEvidence("serve-probe.out.txt", serveOut().text);
  writeEvidence("serve-probe.err.txt", serveErr().text);
  writeEvidence("serve-probe.json", `${JSON.stringify(result, null, 2)}\n`);
  for (const path of [serveOutPath, serveErrPath]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // a detached descendant may still hold the handle; harmless
    }
  }
  return result;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "all";
  ensureDirs();

  if (mode === "load" || mode === "all") {
    const observations = await runPluginLoadProbes();
    for (const observation of observations) {
      console.log(
        `[load] ${observation.case}: loaded=${observation.loaded} teams=${observation.teamAgents.length}` +
          (observation.loadErrorMessage ? ` error="${observation.loadErrorMessage}"` : ""),
      );
    }
  }

  if (mode === "serve" || mode === "all") {
    const result = await runServeProbes();
    console.log(`[serve] url=${result.url ?? "unavailable"} host=${result.hostVersion}`);
    console.log(`[serve] agents=${JSON.stringify(result.agents)}`);
    console.log(`[serve] tools=${JSON.stringify(result.toolIds)}`);
    console.log(`[serve] session=${JSON.stringify(result.sessionCreate)} abort=${JSON.stringify(result.sessionAbort)}`);
    console.log(`[serve] child=${JSON.stringify(result.childSession)} shell=${JSON.stringify(result.shellTool)}`);
    console.log(`[serve] prompt=${JSON.stringify(result.prompt)}`);
  }
}

if (import.meta.main) {
  await main();
}
