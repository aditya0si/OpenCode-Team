/**
 * Plugin integration test: drives the BUILT bundle (`dist/index.js`) the way
 * OpenCode does — calls the returned hooks with the same shapes the host
 * sends, and asserts on the config that comes out.
 *
 * This is the test that would have caught the original P0s:
 *   - frontmatter dumped into the prompt instead of real config keys
 *   - the user's/installer's `model` being clobbered
 *   - `--topology` documented but not parsed
 *   - hidden subagents that were not hidden (mode defaulted to "all")
 *
 * Usage: bun scripts/plugin-integration.ts   (run `bun run build` first)
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamPlugin } from "../dist/index.js";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const projectDir = mkdtempSync(join(tmpdir(), "teamwork-plugin-"));

const logs: string[] = [];
const ctx = {
  directory: projectDir,
  worktree: projectDir,
  project: { id: "test" },
  serverUrl: new URL("http://localhost"),
  $: undefined,
  client: {
    app: {
      log: async (input: { body: { message: string } }) => {
        logs.push(input.body.message);
      },
    },
  },
} as never;

const hooks = await TeamPlugin(ctx, {});

// ─── config hook ─────────────────────────────────────────────────────

const userConfig: Record<string, unknown> = {
  $schema: "https://opencode.ai/config.json",
  theme: "opencode",
  agent: {
    // What the installer or the user already wrote: a per-role model, plus an
    // unrelated agent that must not be disturbed.
    "team/sentinel": { model: "anthropic/claude-opus-4-5" },
    "team/verifier": { model: "google/gemini-3-flash" },
    build: { model: "anthropic/claude-sonnet-4-5" },
  },
  custom: { mine: true },
};
await hooks.config?.(userConfig as never);

const agents = userConfig["agent"] as Record<string, Record<string, unknown>>;
console.log("\n[1] Agents are injected with real config keys");

check("all 10 team agents registered", Object.keys(agents).filter((k) => k.startsWith("team/")).length === 10);
check("unrelated user agents untouched", agents["build"]?.["model"] === "anthropic/claude-sonnet-4-5");
check("unrelated top-level keys untouched", (userConfig["custom"] as { mine: boolean }).mine === true);

const verifier = agents["team/verifier"]!;
check("verifier.permission.edit === deny (enforced, not narrated)", (verifier["permission"] as Record<string, string>)["edit"] === "deny", JSON.stringify(verifier["permission"]));
check("verifier.permission.task === deny", (verifier["permission"] as Record<string, string>)["task"] === "deny");
check("verifier.mode === subagent (was defaulting to 'all')", verifier["mode"] === "subagent");
check("verifier.temperature injected", verifier["temperature"] === 0);
check("verifier model preserved from user config", verifier["model"] === "google/gemini-3-flash");
check("verifier prompt has no YAML frontmatter", !String(verifier["prompt"]).startsWith("---"));
check("verifier prompt keeps its body", String(verifier["prompt"]).includes("forcing function"));

const sentinel = agents["team/sentinel"]!;
check("sentinel.mode === primary", sentinel["mode"] === "primary");
check("sentinel model preserved", sentinel["model"] === "anthropic/claude-opus-4-5");
check("sentinel may spawn subagents (task: allow)", (sentinel["permission"] as Record<string, string>)["task"] === "allow");
check("sentinel prompt carries the topology index", String(sentinel["prompt"]).includes("Topology library"));
check("topology index points at real files", String(sentinel["prompt"]).includes("long-proof.md"));

console.log("\n[2] Commands");
const commands = userConfig["command"] as Record<string, Record<string, string>>;
check("7 slash commands registered", Object.keys(commands).length === 7);
check("commands dispatch to team agents", Object.values(commands).every((c) => String(c["agent"]).startsWith("team/")));
const teamwork = commands["teamwork"]!;
check("no unexpandable template language", !String(teamwork["template"]).includes("{{"));
check("$ARGUMENTS appears exactly once", String(teamwork["template"]).split("$ARGUMENTS").length - 1 === 1);
check("command points the model at the pre-parsed run pointer", String(teamwork["template"]).includes("LATEST.json"));

console.log("\n[3] Tools are exposed to the model");
const toolNames = Object.keys(hooks.tool ?? {});
check("engine tools registered", ["teamwork_plan", "teamwork_dispatch", "teamwork_verify", "teamwork_status", "teamwork_resume"].every((t) => toolNames.includes(t)), toolNames.join(","));

console.log("\n[4] command.execute.before parses flags in code");
await hooks["command.execute.before"]?.(
  { command: "teamwork", sessionID: "sess-1", arguments: '--topology long-proof --budget 30 --concurrency=2 "prove X"' },
  { parts: [] } as never,
);
const pointerPath = join(projectDir, ".opencode", "teamwork", "LATEST.json");
check("run pointer written", existsSync(pointerPath));
const pointer = JSON.parse(readFileSync(pointerPath, "utf-8")) as Record<string, unknown>;
check("topology parsed", pointer["topology"] === "long-proof");
check("budget parsed", pointer["budgetUsd"] === 30);
check("concurrency parsed from the = form", pointer["maxConcurrency"] === 2);
check("request text keeps the prompt and drops the flags", String(pointer["request"]).includes("prove X") && !String(pointer["request"]).includes("--topology"));
check("session id minted", typeof pointer["sessionId"] === "string" && String(pointer["sessionId"]).length > 10);
const requestMd = readFileSync(join(projectDir, ".opencode", "teamwork", String(pointer["sessionId"]), "request.md"), "utf-8");
check("request.md written into the run dir", requestMd.includes("prove X"));

console.log("\n[5] Runtime guard: read-only roles cannot write");
hooks["chat.message"]?.( { sessionID: "sess-verifier", agent: "team/verifier" } as never, { message: {}, parts: [] } as never);
hooks["chat.message"]?.( { sessionID: "sess-worker", agent: "team/worker" } as never, { message: {}, parts: [] } as never);
let blocked: string | null = null;
try {
  await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "sess-verifier", callID: "c1" } as never, { args: {} } as never);
} catch (err) {
  blocked = (err as Error).message;
}
check("verifier edit refused", blocked !== null && blocked.includes("read-only"), blocked ?? "not blocked");
let workerBlocked = false;
try {
  await hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "sess-worker", callID: "c2" } as never, { args: {} } as never);
} catch {
  workerBlocked = true;
}
check("worker edit allowed", !workerBlocked);

const permission = { status: "ask" as string };
await hooks["permission.ask"]?.({ sessionID: "sess-verifier", type: "edit", title: "edit", id: "p1", messageID: "m1", metadata: {}, time: { created: 0 } } as never, permission as never);
check("permission.ask downgrades to deny for the verifier", permission.status === "deny", permission.status);

console.log("\n[6] Compaction keeps the run alive");
// Create a real run so the hook has something to inject.
await hooks["command.execute.before"]?.(
  { command: "teamwork", sessionID: "sess-2", arguments: '--session live-run "do the thing"' },
  { parts: [] } as never,
);
const { Engine } = await import("../dist/engine.js");
Engine.create({
  runDir: join(projectDir, ".opencode", "teamwork", "live-run"),
  sessionId: "live-run",
  topology: "small-focused",
  tasks: [{ taskId: "T1", title: "a", dependsOn: [] }],
});
const compactContext: string[] = [];
await hooks["experimental.session.compacting"]?.({ sessionID: "sess-2" } as never, { context: compactContext } as never);
const injected = compactContext.join("\n");
check("plan re-injected on compaction", injected.includes("Active Teamwork run: live-run"), injected.slice(0, 120));
check("task state re-injected", injected.includes("T1"));
check("budget re-injected", injected.includes("cost"));

rmSync(projectDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ plugin integration failed: ${failures} check(s)\n`);
  process.exit(1);
}
console.log("\n✓ plugin integration passed — config injection, commands, tools, guard, compaction.\n");
