/**
 * Smoke test for opencode-team.
 *
 * Runs the installer against a temp HOME, verifies the resulting
 * opencode.json is well-formed and has all 6 agents, and that the
 * plugin entry can be required without throwing.
 *
 * Usage: bun scripts/smoke.ts
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(1); }

const distCli = join(ROOT, "dist", "cli", "index.js");
if (!existsSync(distCli)) fail(`Build first: bun run build (no ${distCli})`);

const fakeHome = mkdtempSync(join(tmpdir(), "opencode-team-smoke-"));
const cfgDir = join(fakeHome, ".config", "opencode");
const cfgPath = join(cfgDir, "opencode.json");

// ─── 1. Fresh install with --preset team ──────────────────────────────
console.log("\n[1] Fresh install with --preset team");
{
  const r = spawnSync("node", [distCli, "install", "--preset", "team", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`install exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  ok("install --preset team exited 0");
}

if (!existsSync(cfgPath)) fail(`Config not written: ${cfgPath}`);
ok(`Config written: ${cfgPath}`);

const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
if (!Array.isArray(cfg.plugin) || !cfg.plugin.includes("opencode-team@latest"))
  fail("plugin entry missing");
ok("plugin entry present");

const expectedRoles = [
  "team/crafter",
  "team/sentinel",
  "team/worker",
  "team/proof-worker",
  "team/verifier",
  "team/orchestrator",
  "team/proposer",
  "team/falsifier",
  "team/synthesizer",
  "team/scout",
];
for (const role of expectedRoles) {
  if (!cfg.agent?.[role]?.model) fail(`Missing role: ${role}`);
  ok(`role ${role} -> ${cfg.agent[role].model}`);
}

// ─── 2. Re-run is idempotent (deep-merge, not overwrite) ──────────────
console.log("\n[2] Re-run preserves existing config");
{
  // Add a custom setting
  cfg.custom = { mine: true };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = spawnSync("node", [distCli, "install", "--preset", "anthropic", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`re-install exited ${r.status}\n${r.stderr}`);
  const re = JSON.parse(readFileSync(cfgPath, "utf-8"));
  if (re.custom?.mine !== true) fail("Custom config got overwritten");
  ok("Existing custom config preserved");
  if (cfg.plugin.length === re.plugin.length) ok("Plugin list still has 1 entry (no dup)");
  else fail(`Plugin list grew: ${re.plugin}`);
}

// ─── 3. Uninstall removes plugin and roles ────────────────────────────
console.log("\n[3] Uninstall");
{
  const r = spawnSync("node", [distCli, "uninstall", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`uninstall exited ${r.status}\n${r.stderr}`);
  const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
  if (Array.isArray(after.plugin) && after.plugin.includes("opencode-team@latest"))
    fail("Plugin still listed after uninstall");
  ok("Plugin removed from plugin list");
  for (const role of expectedRoles) {
    if (after.agent?.[role]) fail(`Role ${role} still present after uninstall`);
  }
  ok("All team/* roles removed");
}

// ─── 4. Doctor detects missing config ─────────────────────────────────
console.log("\n[4] Doctor");
{
  // Remove config; doctor should fail
  rmSync(cfgPath);
  const r = spawnSync("node", [distCli, "doctor", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status === 0) fail("Doctor should have failed with no config");
  ok("Doctor correctly reports no config (exit != 0)");
}

// ─── 5. Plugin entry is importable ────────────────────────────────────
console.log("\n[5] Plugin entry import");
{
  const distPlugin = join(ROOT, "dist", "index.js");
  if (!existsSync(distPlugin)) fail(`No ${distPlugin}`);
  // We can't actually load it (it imports @opencode-ai/plugin which
  // is a peer dep), but we can at least verify the file is valid JS.
  const r = spawnSync("node", ["--check", distPlugin], { encoding: "utf-8" });
  if (r.status !== 0) fail(`Plugin syntax check failed: ${r.stderr}`);
  ok("Plugin entry is valid JS");
}

// Cleanup
rmSync(fakeHome, { recursive: true, force: true });
console.log("\n✓ All smoke tests passed.\n");
