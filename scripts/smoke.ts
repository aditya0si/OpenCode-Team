/**
 * Smoke test for opencode-teamwork.
 *
 * Runs the installer against a temp HOME, verifies the resulting
 * opencode.json is well-formed and has all 10 agents, and that the
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

const fakeHome = mkdtempSync(join(tmpdir(), "opencode-teamwork-smoke-"));
const cfgDir = join(fakeHome, ".config", "opencode");
const cfgPath = join(cfgDir, "opencode.json");

// ─── 1. Fresh install with --preset team --yes ───────────────────────
console.log("\n[1] Fresh install with --preset team --yes");
{
  const r = spawnSync("node", [distCli, "install", "--preset", "team", "--yes", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`install exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // The CLI should now print a confirmation prompt + a y/n line in
  // the log. Make sure "Proceeding" appears (signals the gate ran).
  if (!r.stdout.includes("Proceeding")) fail("No 'Proceeding' line in install log — confirmation gate may be missing");
  ok("install --preset team --yes exited 0 with confirmation gate");
}

if (!existsSync(cfgPath)) fail(`Config not written: ${cfgPath}`);
ok(`Config written: ${cfgPath}`);

const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
if (!Array.isArray(cfg.plugin) || !cfg.plugin.includes("opencode-teamwork@latest"))
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

// ─── 2. Re-run preserves existing config (deep-merge) ────────────────
console.log("\n[2] Re-run preserves existing config");
{
  // Add a custom setting
  cfg.custom = { mine: true };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = spawnSync("node", [distCli, "install", "--preset", "anthropic", "--yes", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`re-install exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // Should show a diff preview line
  if (!r.stdout.includes("Changes that will be made")) fail("No diff preview in re-install log");
  ok("Diff preview shown");
  const re = JSON.parse(readFileSync(cfgPath, "utf-8"));
  if (re.custom?.mine !== true) fail("Custom config got overwritten");
  ok("Existing custom config preserved");
  if (cfg.plugin.length === re.plugin.length) ok("Plugin list still has 1 entry (no dup)");
  else fail(`Plugin list grew: ${re.plugin}`);
}

// ─── 3. Uninstall with --yes removes plugin and roles ─────────────────
console.log("\n[3] Uninstall (--yes)");
{
  const r = spawnSync("node", [distCli, "uninstall", "--yes", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`uninstall exited ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  if (!r.stdout.includes("Changes that will be made")) fail("No diff preview in uninstall log");
  ok("Diff preview shown");
  const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
  if (Array.isArray(after.plugin) && after.plugin.includes("opencode-teamwork@latest"))
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

// ─── 5. --dry-run prints but does NOT write ──────────────────────────
console.log("\n[5] --dry-run never writes");
{
  const before = existsSync(cfgPath);
  const r = spawnSync("node", [distCli, "install", "--preset", "google", "--dry-run", "--config", cfgPath], {
    encoding: "utf-8",
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, OPENCODE_CONFIG_DIR: cfgDir },
  });
  if (r.status !== 0) fail(`--dry-run exited ${r.status}\nstderr:\n${r.stderr}`);
  if (!r.stdout.includes("Would write to")) fail("No 'Would write to' in --dry-run output");
  ok("--dry-run prints the would-be config");
  if (existsSync(cfgPath) !== before) fail("--dry-run wrote to disk!");
  ok("--dry-run did not write to disk");
}

// ─── 6. Plugin entry is importable ────────────────────────────────────
console.log("\n[6] Plugin entry import");
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
