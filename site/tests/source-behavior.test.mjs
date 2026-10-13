// Source-backed behavioral regression assertions.
//
// These tests execute the *actual* released plugin config hook and the released
// CLI uninstall routine, extracted at the declared release commit with read-only
// git plumbing. They are deliberately not fixture-equality checks: the source
// text is sliced out of `git show <commit>:<path>` and run in an isolated VM with
// stubs, so a copied snapshot cannot drift from the reviewed behavior.
//
// Two reviewed 0.2.1 hazards are pinned here:
//   1. the config hook replaces every `team/*` role with `{ prompt: body }`,
//      discarding a user's model/temperature for that role;
//   2. uninstall rebuilds the config from a fresh object holding only `plugin`
//      and `agent`, dropping every unrelated top-level key.
//
// No real configuration file is read or written and the installer is never run.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { commitExists, releaseFile } from "../scripts/release-evidence.mjs";
import { landingContent } from "../src/content.mjs";

const COMMIT = landingContent.releaseCommit;
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/release-contract.json", import.meta.url), "utf-8"),
);

const nativeStrip = nodeModule.stripTypeScriptTypes;

// Normalise a VM-realm value into plain host-realm data so deep comparisons
// compare structure rather than realm-specific prototypes.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Bounded TypeScript annotation strip. Prefers Node's native type stripping;
// the fallback covers only the annotations present in the extracted functions.
function stripTypes(code) {
  if (typeof nativeStrip === "function") {
    return nativeStrip(code, { mode: "strip" });
  }
  return code
    .replace(/: any/g, "")
    .replace(/args: string\[\]/g, "args")
    .replace(/\): Promise<void>/g, ")")
    .replace(/: Record<string, any>/g, "")
    .replace(/ as string\[\]/g, "")
    .replace(/ as Record<string, any>/g, "")
    .replace(/\(p: string\)/g, "(p)");
}

// Return the balanced `{ ... }` block beginning at `openIndex`.
function sliceBalanced(source, openIndex) {
  if (openIndex < 0) throw new Error("sliceBalanced: openIndex not found");
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  throw new Error("sliceBalanced: unbalanced braces");
}

// Extract the `config: async (config) => { ... }` arrow function from src/index.ts.
function extractConfigHook(source) {
  const anchor = source.indexOf("config: async");
  assert.notEqual(anchor, -1, "config hook anchor is missing from src/index.ts");
  const arrow = source.indexOf("async", anchor);
  const arrowOp = source.indexOf("=>", arrow);
  assert.notEqual(arrowOp, -1, "config hook arrow is missing");
  const open = source.indexOf("{", arrowOp);
  const body = sliceBalanced(source, open);
  const fnText = source.slice(arrow, open) + body;
  return stripTypes(fnText).replace(/: any/g, "");
}

// Build and run the extracted config hook with stubbed registries.
async function runConfigHook({ agentBodies, commands, config }) {
  const source = releaseFile(COMMIT, "src/index.ts");
  const fnText = extractConfigHook(source);
  const factory = new vm.Script(
    `(function (agentBodies, commands) { return ${fnText}; })`,
  ).runInNewContext({});
  const hook = factory(agentBodies, commands);
  assert.equal(typeof hook, "function");
  await hook(config);
  return config;
}

// Extract `cmdUninstall` (from its declaration up to `cmdDoctor`) as TypeScript.
function extractUninstall(source) {
  const start = source.indexOf("async function cmdUninstall");
  const end = source.indexOf("async function cmdDoctor");
  assert.notEqual(start, -1, "cmdUninstall not found in src/cli/index.ts");
  assert.notEqual(end, -1, "cmdDoctor not found in src/cli/index.ts");
  assert.ok(end > start, "cmdUninstall must precede cmdDoctor");
  return stripTypes(source.slice(start, end));
}

// Execute the extracted uninstall routine in an isolated VM. Every external
// dependency is a stub; nothing touches the real filesystem or process.
async function runUninstall(source, initialConfig) {
  const ROLES = [...fixture.roleIds];
  const STUB_PATH = "/stub/opencode.json";
  const calls = { saved: null, savedPath: null, loadPaths: [] };

  const context = {
    console: { log() {}, error() {} },
    process: { stdout: { isTTY: false }, env: {} },
    resolveConfigPath: () => STUB_PATH,
    yesFlag: (args) => args.includes("--yes") || args.includes("-y"),
    existsSync: () => true,
    loadExistingConfig: (p) => {
      calls.loadPaths.push(p);
      return initialConfig;
    },
    ROLES,
    diffConfig: () => "",
    saveConfig: (p, config) => {
      calls.savedPath = p;
      calls.saved = config;
    },
    askYesNo: async () => true,
    AbortError: class AbortError extends Error {},
  };
  vm.createContext(context);
  const script = new vm.Script(
    `${extractUninstall(source)}\n; globalThis.__runUninstall = cmdUninstall;`,
  );
  script.runInContext(context);
  await context.__runUninstall([]);
  return calls;
}

test("config_hook_reduces_each_role_to_prompt_only", async () => {
  assert.ok(commitExists(COMMIT), `release commit must exist: ${COMMIT}`);

  const WORKER_BODY = "WORKER PROMPT BODY";
  const config = {
    agent: {
      "team/worker": { model: "anthropic/claude-sonnet-4-5", temperature: 0.2 },
      "other/agent": { model: "keep/me" },
    },
    command: {},
  };

  const result = await runConfigHook({
    agentBodies: { worker: WORKER_BODY },
    commands: [
      { name: "teamwork", template: "T", description: "D", agent: "team/sentinel" },
    ],
    config,
  });

  assert.deepEqual(
    plain(result.agent["team/worker"]),
    { prompt: WORKER_BODY },
    "the config hook replaces the preset role object with a prompt-only object",
  );
  assert.equal("model" in result.agent["team/worker"], false, "model is discarded");
  assert.equal(
    "temperature" in result.agent["team/worker"],
    false,
    "temperature is discarded",
  );

  assert.deepEqual(
    plain(result.agent["other/agent"]),
    { model: "keep/me" },
    "an unrelated agent that the hook does not iterate must be retained",
  );
  assert.deepEqual(
    plain(result.command.teamwork),
    { template: "T", description: "D", agent: "team/sentinel" },
    "commands are registered",
  );
});

test("uninstall_rebuilds_config_from_plugin_and_agent_only", async () => {
  assert.ok(commitExists(COMMIT), `release commit must exist: ${COMMIT}`);

  const initialConfig = {
    plugin: ["opencode-teamwork@latest", "other-plugin"],
    agent: {
      "team/worker": { prompt: "work" },
      "other/agent": { model: "keep/me" },
    },
    provider: "anthropic",
    theme: "dark",
    permission: "allow",
  };

  const source = releaseFile(COMMIT, "src/cli/index.ts");
  const calls = await runUninstall(source, initialConfig);

  assert.equal(
    calls.savedPath,
    "/stub/opencode.json",
    "the stub resolver path is used; no real config is touched",
  );
  assert.deepEqual(
    plain(calls.saved.plugin),
    ["other-plugin"],
    "the opencode-teamwork plugin entry is removed",
  );
  assert.deepEqual(
    plain(calls.saved.agent),
    { "other/agent": { model: "keep/me" } },
    "every team role is removed but unrelated agents are retained",
  );
  for (const role of fixture.roleIds) {
    assert.equal(role in calls.saved.agent, false, `${role} must be removed`);
  }

  assert.deepEqual(
    plain(Object.keys(calls.saved).sort()),
    ["agent", "plugin"],
    "the rebuilt object keeps only plugin and agent",
  );
  const lostKeys = Object.keys(initialConfig).filter((k) => !(k in calls.saved));
  assert.deepEqual(
    plain(lostKeys.sort()),
    [...fixture.uninstallDroppedKeys].sort(),
    "all unrelated top-level keys (provider, theme, permission) are lost",
  );
});
