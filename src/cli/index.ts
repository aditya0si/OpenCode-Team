#!/usr/bin/env node
/**
 * opencode-team installer CLI.
 *
 * Usage:
 *   opencode-team install                # interactive: ask for model per role
 *   opencode-team install --preset team  # use a preset (single model everywhere)
 *   opencode-team install --reset        # overwrite existing config (no merge)
 *   opencode-team install --print        # print the config that would be written, then exit
 *   opencode-team uninstall              # remove the plugin from opencode.json
 *   opencode-team doctor                 # check that opencode.json is valid
 *   opencode-team --help
 *
 * Installs to ~/.config/opencode/opencode.json by default. Override with
 * --config <path>. Honors OPENCODE_CONFIG_DIR for non-standard setups.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform, arch } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Where the templates live relative to the installed CLI.
// `dist/cli/index.js` -> `dist/cli/templates/`.
const TEMPLATES_DIR = join(__dirname, "templates");
const ROOT_TEMPLATES_DIR = join(__dirname, "..", "cli", "templates");

// ─── Config resolution ───────────────────────────────────────────────

function resolveConfigPath(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  const base = envDir ?? join(homedir(), ".config", "opencode");
  return join(base, "opencode.json");
}

function loadExistingConfig(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    // Strip comments for JSON.parse. Most users use JSONC, so we do
    // a minimal pass: remove // line comments and /* block comments */.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/([^:])\/\/.*$/gm, "$1");
    return JSON.parse(stripped);
  } catch (err) {
    console.error(`✗ Could not parse existing ${path}: ${(err as Error).message}`);
    console.error("  Run with --reset to overwrite, or fix the file by hand.");
    process.exit(1);
  }
}

function saveConfig(path: string, config: Record<string, any>): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(config, null, 2) + "\n";
  writeFileSync(path, json, "utf-8");
  console.log(`✓ Wrote ${path}`);
}

// ─── Presets ─────────────────────────────────────────────────────────

interface Preset {
  name: string;
  description: string;
  agents: Record<string, string>;
}

const PRESETS: Preset[] = [
  {
    name: "anthropic",
    description: "All-Claude preset (Sonnet 4.5 across the board).",
    agents: {
      "team/crafter": "anthropic/claude-sonnet-4-5",
      "team/sentinel": "anthropic/claude-sonnet-4-5",
      "team/worker": "anthropic/claude-sonnet-4-5",
      "team/proof-worker": "anthropic/claude-sonnet-4-5",
      "team/verifier": "anthropic/claude-sonnet-4-5",
      "team/orchestrator": "anthropic/claude-sonnet-4-5",
      "team/proposer": "anthropic/claude-sonnet-4-5",
      "team/falsifier": "anthropic/claude-sonnet-4-5",
      "team/synthesizer": "anthropic/claude-sonnet-4-5",
      "team/scout": "anthropic/claude-sonnet-4-5",
    },
  },
  {
    name: "team",
    description: "Mix Opus (sentinel, orchestrator, synthesizer) + Sonnet (rest).",
    agents: {
      "team/crafter": "anthropic/claude-sonnet-4-5",
      "team/sentinel": "anthropic/claude-opus-4-5",
      "team/worker": "anthropic/claude-sonnet-4-5",
      "team/proof-worker": "anthropic/claude-opus-4-5",
      "team/verifier": "anthropic/claude-sonnet-4-5",
      "team/orchestrator": "anthropic/claude-opus-4-5",
      "team/proposer": "anthropic/claude-sonnet-4-5",
      "team/falsifier": "anthropic/claude-sonnet-4-5",
      "team/synthesizer": "anthropic/claude-opus-4-5",
      "team/scout": "anthropic/claude-haiku-4-5",
    },
  },
  {
    name: "google",
    description: "Google preset (matches Teamwork's research: Flash + Pro).",
    agents: {
      "team/crafter": "google/gemini-3.1-pro",
      "team/sentinel": "google/gemini-3.1-pro",
      "team/worker": "google/gemini-3-flash",
      "team/proof-worker": "google/gemini-3.1-pro",
      "team/verifier": "google/gemini-3-flash",
      "team/orchestrator": "google/gemini-3.1-pro",
      "team/proposer": "google/gemini-3-flash",
      "team/falsifier": "google/gemini-3.1-pro",
      "team/synthesizer": "google/gemini-3.1-pro",
      "team/scout": "google/gemini-3-flash",
    },
  },
  {
    name: "openai",
    description: "OpenAI preset (GPT-5.2 + GPT-5-mini).",
    agents: {
      "team/crafter": "openai/gpt-5.2",
      "team/sentinel": "openai/gpt-5.2",
      "team/worker": "openai/gpt-5-mini",
      "team/proof-worker": "openai/gpt-5.2",
      "team/verifier": "openai/gpt-5-mini",
      "team/orchestrator": "openai/gpt-5.2",
      "team/proposer": "openai/gpt-5-mini",
      "team/falsifier": "openai/gpt-5.2",
      "team/synthesizer": "openai/gpt-5.2",
      "team/scout": "openai/gpt-5-mini",
    },
  },
  {
    name: "free",
    description: "All free tier — best for trying it out without spending credits.",
    agents: {
      "team/crafter": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/sentinel": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/worker": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/proof-worker": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/verifier": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/orchestrator": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/proposer": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/falsifier": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/synthesizer": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      "team/scout": "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    },
  },
];

const ROLES = [
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
] as const;

// ─── Interactive prompts ─────────────────────────────────────────────

async function pickPreset(): Promise<string | null> {
  const rl = createInterface({ input, output });
  console.log("\nChoose a preset (or 'custom' to set per-role):");
  PRESETS.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name.padEnd(10)} — ${p.description}`);
  });
  console.log(`  ${PRESETS.length + 1}. custom     — pick a model for each role`);
  console.log(`  ${PRESETS.length + 2}. skip       — keep your existing config\n`);

  const answer = await rl.question(`> preset (1-${PRESETS.length + 2}): `);
  rl.close();
  const idx = Number.parseInt(answer.trim(), 10);
  if (Number.isNaN(idx) || idx < 1 || idx > PRESETS.length + 2) {
    console.error("Invalid selection.");
    process.exit(1);
  }
  if (idx === PRESETS.length + 1) return "custom";
  if (idx === PRESETS.length + 2) return null;
  return PRESETS[idx - 1]!.name;
}

async function pickPerRoleModels(): Promise<Record<string, string>> {
  const rl = createInterface({ input, output });
  const defaults = PRESETS[0]!.agents; // anthropic defaults
  const out: Record<string, string> = {};
  console.log("\nSet the model for each role (press Enter to use the default):\n");
  for (const role of ROLES) {
    const def = defaults[role]!;
    const prompt = `  ${role} [${def}]: `;
    const answer = (await rl.question(prompt)).trim();
    out[role] = answer || def;
  }
  rl.close();
  return out;
}

// ─── Build the config patch ──────────────────────────────────────────

function buildPatch(agents: Record<string, string>, pkg: string): Record<string, any> {
  const agentConfig: Record<string, any> = {};
  for (const [role, model] of Object.entries(agents)) {
    agentConfig[role] = { model };
  }
  return {
    plugin: [pkg],
    agent: agentConfig,
  };
}

function deepMerge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object") {
      target[k] = deepMerge({ ...(target[k] as Record<string, any>) }, v as Record<string, any>);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function ensurePluginListed(config: Record<string, any>, pkg: string): void {
  config.plugin = config.plugin ?? [];
  if (!Array.isArray(config.plugin)) config.plugin = [config.plugin];
  if (!config.plugin.includes(pkg)) config.plugin.push(pkg);
}

// ─── Commands ────────────────────────────────────────────────────────

async function cmdInstall(args: string[]): Promise<void> {
  const printOnly = args.includes("--print");
  const reset = args.includes("--reset");
  const presetName = (() => {
    const i = args.indexOf("--preset");
    return i >= 0 ? args[i + 1] : undefined;
  })() as string | undefined;
  const configPath = (() => {
    const i = args.indexOf("--config");
    return i >= 0 ? (args[i + 1] ?? resolveConfigPath()) : resolveConfigPath();
  })();

  // Resolve the package spec. We use the npm package name so users
  // can pin to a version. The plugin's exports field provides
  // the entry points.
  const pkg = "opencode-team@latest";

  let agents: Record<string, string>;
  if (presetName) {
    const preset = PRESETS.find((p) => p.name === presetName);
    if (!preset) {
      console.error(`✗ Unknown preset: ${presetName}`);
      console.error(`  Available: ${PRESETS.map((p) => p.name).join(", ")}`);
      process.exit(1);
    }
    console.log(`Using preset: ${preset.name} — ${preset.description}`);
    agents = preset.agents;
  } else if (process.stdout.isTTY) {
    const choice = await pickPreset();
    if (choice === null) {
      console.log("Skipping — no changes made.");
      return;
    }
    if (choice === "custom") {
      agents = await pickPerRoleModels();
    } else {
      const preset = PRESETS.find((p) => p.name === choice)!;
      agents = preset.agents;
    }
  } else {
    // Non-interactive: default to anthropic preset.
    console.log("Non-interactive: defaulting to 'anthropic' preset.");
    console.log("  Re-run with --preset <name> to override.");
    agents = PRESETS[0]!.agents;
  }

  const patch = buildPatch(agents, pkg);
  if (printOnly) {
    console.log("\n# Would write to", configPath, ":\n");
    console.log(JSON.stringify(patch, null, 2));
    return;
  }

  const existing = reset ? {} : loadExistingConfig(configPath);
  const merged = reset ? patch : deepMerge(existing, patch);
  ensurePluginListed(merged, pkg);

  saveConfig(configPath, merged);
  console.log(`\n✓ Installed opencode-team with ${Object.keys(agents).length} agents.`);
  console.log(`  Models:`);
  for (const [role, model] of Object.entries(agents)) {
    console.log(`    ${role.padEnd(28)} ${model}`);
  }
  console.log(`\n  Next: opencode (the plugin loads automatically).`);
  console.log(`  Try:  /teamwork "your problem here"`);
  console.log(`        /teamwork --pattern long-proof "prove X"`);
  console.log(`        /teamwork --pattern iterative-coding "fix this bug"`);
}

async function cmdUninstall(args: string[]): Promise<void> {
  const configPath = (() => {
    const i = args.indexOf("--config");
    return i >= 0 ? (args[i + 1] ?? resolveConfigPath()) : resolveConfigPath();
  })();

  if (!existsSync(configPath)) {
    console.log(`No config at ${configPath}. Nothing to remove.`);
    return;
  }

  const config = loadExistingConfig(configPath);
  if (Array.isArray(config.plugin)) {
    config.plugin = (config.plugin as string[]).filter(
      (p: string) => !p.startsWith("opencode-team"),
    );
  }
  // Remove our agents
  if (config.agent && typeof config.agent === "object") {
    for (const role of ROLES) {
      delete config.agent[role];
    }
  }
  saveConfig(configPath, config);
  console.log("✓ Removed opencode-team from config.");
  console.log("  The package is still installed via npm. Run:");
  console.log("    npm uninstall -g opencode-team   # to fully remove");
}

async function cmdDoctor(_args: string[]): Promise<void> {
  const configPath = resolveConfigPath();
  console.log(`opencode-team doctor\n`);
  console.log(`  Platform:     ${platform()} ${arch()}`);
  console.log(`  Node:         ${process.version}`);
  console.log(`  Config path:  ${configPath}`);

  if (!existsSync(configPath)) {
    console.log(`\n  ✗ No config found. Run \`opencode-team install\`.`);
    process.exit(1);
  }
  const config = loadExistingConfig(configPath);
  const hasPlugin =
    Array.isArray(config.plugin) &&
    config.plugin.some((p: string) => p.startsWith("opencode-team"));
  const agents = config.agent ?? {};
  const allRoles = ROLES.every((r) => r in agents);
  console.log(`  Plugin listed:  ${hasPlugin ? "✓" : "✗"}`);
  console.log(`  All roles set:  ${allRoles ? "✓" : "✗"}`);
  if (!hasPlugin) {
    console.log(`\n  Fix: run \`opencode-team install\`.`);
    process.exit(1);
  }
  if (!allRoles) {
    const missing = ROLES.filter((r) => !(r in agents));
    console.log(`\n  Missing roles: ${missing.join(", ")}`);
    console.log(`  Fix: re-run \`opencode-team install --reset\`.`);
    process.exit(1);
  }
  console.log(`\n  All checks passed.`);
}

function printHelp(): void {
  console.log(`opencode-team — Antigravity-style multi-agent orchestration for OpenCode.

Usage:
  opencode-team install [options]
  opencode-team uninstall [options]
  opencode-team doctor
  opencode-team --help
  opencode-team --version

Install options:
  --preset <name>     Use a preset: ${PRESETS.map((p) => p.name).join(", ")}, custom, or skip
  --reset             Overwrite the existing config (no merge)
  --print             Print the config that would be written, then exit
  --config <path>     Override the config path (default: ~/.config/opencode/opencode.json)
  --help              Show this help

Examples:
  opencode-team install
  opencode-team install --preset team
  opencode-team install --preset google --reset
  opencode-team install --print
  opencode-team doctor
  opencode-team uninstall

Docs: https://github.com/aditya0si/OpenCode-Team
`);
}

// ─── Entry ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    const pkg = await readPackageVersion();
    console.log(`opencode-team ${pkg}`);
    return;
  }
  if (cmd === "install") {
    await cmdInstall(argv.slice(1));
    return;
  }
  if (cmd === "uninstall") {
    await cmdUninstall(argv.slice(1));
    return;
  }
  if (cmd === "doctor") {
    await cmdDoctor(argv.slice(1));
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

async function readPackageVersion(): Promise<string> {
  // Walk up from __dirname looking for package.json (works for both
  // the bundled dist/cli/index.js and a dev checkout).
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      return j.version ?? "0.0.0";
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
