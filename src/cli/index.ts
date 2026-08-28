#!/usr/bin/env node
/**
 * opencode-teamwork installer CLI.
 *
 * Usage:
 *   opencode-teamwork install                # interactive: ask for model per role
 *   opencode-teamwork install --preset team  # use a preset (single model everywhere)
 *   opencode-teamwork install --reset        # overwrite existing config (no merge)
 *   opencode-teamwork install --print        # print the config that would be written, then exit
 *   opencode-teamwork uninstall              # remove the plugin from opencode.json
 *   opencode-teamwork doctor                 # check that opencode.json is valid
 *   opencode-teamwork --help
 *
 * Installs to ~/.config/opencode/opencode.json by default. Override with
 * --config <path>. Honors OPENCODE_CONFIG_DIR for non-standard setups.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform, arch } from "node:os";
import { createInterface, type Interface as RL } from "node:readline/promises";
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

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

/** True if the user passed --yes (force non-interactive, accept defaults). */
function yesFlag(args: string[]): boolean {
  return args.includes("--yes") || args.includes("-y");
}

/** True if the user wants a dry-run that prints but never writes. */
function dryRunFlag(args: string[]): boolean {
  return args.includes("--dry-run") || args.includes("--print");
}

/** Ask a yes/no question. Returns true for yes, false for no.
 *  Default applies when the user just presses Enter.
 *  Recognizes: y/yes/Enter(default), n/no, q/quit (throws AbortError).
 *  Re-prompts on invalid input. */
async function askYesNo(
  question: string,
  options: { defaultYes?: boolean } = {},
): Promise<boolean> {
  const hint = options.defaultYes ? "(Y/n)" : "(y/N)";
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const raw = (await rl.question(`  ${question} ${hint}: `)).trim().toLowerCase();
      if (raw === "") return options.defaultYes ?? false;
      if (raw === "y" || raw === "yes") return true;
      if (raw === "n" || raw === "no") return false;
      if (raw === "q" || raw === "quit" || raw === "exit") throw new AbortError();
      console.log(`  Please answer y or n (or q to quit).`);
    }
  } finally {
    rl.close();
  }
}

/** Pick an integer from a 1-indexed menu, with re-prompt on invalid.
 *  Returns null if the user picks "skip" (last option). */
async function pickMenu(
  question: string,
  choices: { label: string; description: string }[],
  options: { skipChoice?: string } = {},
): Promise<number | null> {
  const rl = createInterface({ input, output });
  try {
    console.log(`\n${question}\n`);
    choices.forEach((c, i) => {
      console.log(`  ${(i + 1).toString().padStart(2)}. ${c.label.padEnd(20)} ${c.description}`);
    });
    if (options.skipChoice) {
      console.log(`  ${(choices.length + 1).toString().padStart(2)}. ${options.skipChoice.padEnd(20)} keep your existing config`);
    }
    const quitHint = options.skipChoice ? choices.length + 2 : choices.length + 1;
    console.log(`   q. quit                            cancel and exit\n`);

    for (;;) {
      const raw = (await rl.question(`  > choice (1-${quitHint}, q=quit): `)).trim().toLowerCase();
      if (raw === "q" || raw === "quit" || raw === "exit") throw new AbortError();
      const idx = Number.parseInt(raw, 10);
      if (Number.isNaN(idx)) {
        console.log(`  Please enter a number or 'q' to quit.`);
        continue;
      }
      if (idx === quitHint && options.skipChoice) return null;
      if (idx < 1 || idx > choices.length) {
        console.log(`  Out of range. Pick 1-${choices.length}${options.skipChoice ? `, ${choices.length + 1} to skip, or q to quit` : ` or q to quit`}.`);
        continue;
      }
      return idx - 1;
    }
  } finally {
    rl.close();
  }
}

/** Free-text prompt with optional default.
 *  Re-prompts on empty when a default is NOT provided.
 *  Recognizes 'q' to abort. */
async function askText(
  question: string,
  options: { defaultValue?: string; allowEmpty?: boolean } = {},
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const hint = options.defaultValue ? ` [${options.defaultValue}]` : "";
      const raw = (await rl.question(`  ${question}${hint}: `)).trim();
      if (raw === "q" || raw === "quit" || raw === "exit") throw new AbortError();
      if (raw === "" && options.defaultValue) return options.defaultValue;
      if (raw === "") {
        if (options.allowEmpty) return "";
        console.log(`  Please enter a value (or 'q' to quit).`);
        continue;
      }
      return raw;
    }
  } finally {
    rl.close();
  }
}

/** Top-level preset picker. Returns the chosen preset name, or
 *  null for "skip" (keep existing config), or "custom" for per-role. */
async function pickPreset(): Promise<string | null> {
  const idx = await pickMenu(
    "Choose a preset for opencode-teamwork:",
    PRESETS.map((p) => ({ label: p.name, description: p.description })),
    { skipChoice: "skip" },
  );
  if (idx === null) return null;
  if (idx === PRESETS.length) return "custom";
  return PRESETS[idx]!.name;
}

/** Per-role model picker. Returns the model map. */
async function pickPerRoleModels(): Promise<Record<string, string>> {
  const defaults = PRESETS[0]!.agents; // anthropic defaults
  const out: Record<string, string> = {};
  console.log(`\n  Set the model for each role. Press Enter to use the default,`);
  console.log(`  type a model id (e.g. "google/gemini-3-flash"), or 'q' to quit.\n`);
  for (const role of ROLES) {
    const def = defaults[role]!;
    out[role] = await askText(`${role}`, { defaultValue: def });
  }
  return out;
}

/** Print a unified diff-like view of what will change in the config.
 *  Shows added keys, removed keys, and changed values. */
function diffConfig(before: Record<string, any>, after: Record<string, any>): string {
  const lines: string[] = [];
  const beforeKeys = new Set(Object.keys(before));
  const afterKeys = new Set(Object.keys(after));

  for (const k of afterKeys) {
    if (!beforeKeys.has(k)) {
      lines.push(`  + ${k}: ${JSON.stringify(after[k])}`);
    } else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      lines.push(`  ~ ${k}:`);
      lines.push(`      - ${JSON.stringify(before[k])}`);
      lines.push(`      + ${JSON.stringify(after[k])}`);
    }
  }
  for (const k of beforeKeys) {
    if (!afterKeys.has(k)) {
      lines.push(`  - ${k}: ${JSON.stringify(before[k])}`);
    }
  }
  if (lines.length === 0) lines.push("  (no changes)");
  return lines.join("\n");
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
  const reset = args.includes("--reset");
  const presetName = (() => {
    const i = args.indexOf("--preset");
    return i >= 0 ? args[i + 1] : undefined;
  })() as string | undefined;
  const configPath = (() => {
    const i = args.indexOf("--config");
    return i >= 0 ? (args[i + 1] ?? resolveConfigPath()) : resolveConfigPath();
  })();
  const printOnly = dryRunFlag(args);
  const autoYes = yesFlag(args);
  const isTTY = process.stdout.isTTY;

  // Resolve the package spec. We use the npm package name so users
  // can pin to a version. The plugin's exports field provides
  // the entry points.
  const pkg = "opencode-teamwork@latest";

  // ── 1. Choose the model assignment ────────────────────────────────
  let agents: Record<string, string>;
  try {
    if (presetName) {
      const preset = PRESETS.find((p) => p.name === presetName);
      if (!preset) {
        console.error(`✗ Unknown preset: ${presetName}`);
        console.error(`  Available: ${PRESETS.map((p) => p.name).join(", ")}`);
        process.exit(1);
      }
      console.log(`\n  Preset: ${preset.name} — ${preset.description}`);
      agents = preset.agents;
    } else if (isTTY && !autoYes) {
      const choice = await pickPreset();
      if (choice === null) {
        console.log(`\n  Skipped. No changes made.`);
        return;
      }
      if (choice === "custom") {
        agents = await pickPerRoleModels();
      } else {
        const preset = PRESETS.find((p) => p.name === choice)!;
        console.log(`\n  Preset: ${preset.name} — ${preset.description}`);
        agents = preset.agents;
      }
    } else {
      // Non-interactive (CI, pipe, or --yes): default to anthropic.
      const why = autoYes && !presetName
        ? "(--yes flag set, defaulting to anthropic preset)"
        : "(non-interactive: no TTY, defaulting to anthropic preset)";
      console.log(`\n  ${why}`);
      console.log(`  Override with --preset <name>.`);
      agents = PRESETS[0]!.agents;
    }
  } catch (err) {
    if (err instanceof AbortError) {
      console.log(`\n  Aborted. No changes made.`);
      return;
    }
    throw err;
  }

  // ── 2. Build the patch and show what will change ──────────────────
  const patch = buildPatch(agents, pkg);
  if (printOnly) {
    console.log(`\n  # Would write to ${configPath}:\n`);
    console.log(JSON.stringify(patch, null, 2).split("\n").map((l) => "  " + l).join("\n"));
    return;
  }

  const existing = reset ? {} : loadExistingConfig(configPath);
  const merged = reset ? patch : deepMerge(existing, patch);
  ensurePluginListed(merged, pkg);

  // If a config already exists and we're not --reset, show the diff
  // so the user knows exactly what will change. If --reset, show a
  // warning. If no config exists, no preview needed (greenfield).
  if (existsSync(configPath) && !reset) {
    console.log(`\n  Existing config: ${configPath}`);
    console.log(`  Changes that will be made:`);
    console.log(diffConfig(existing, merged));
  } else if (reset && existsSync(configPath)) {
    console.log(`\n  ⚠ --reset will OVERWRITE the existing config at:`);
    console.log(`    ${configPath}`);
    console.log(`  All existing keys not in the new patch will be lost.`);
  } else {
    console.log(`\n  New config will be created at: ${configPath}`);
  }

  // ── 3. Confirm before writing ─────────────────────────────────────
  try {
    if (!isTTY || autoYes) {
      // Non-interactive: skip the prompt, proceed (with a log line
      // so the user can see what happened in CI logs).
      console.log(`  Proceeding (--yes or non-interactive).`);
    } else {
      const ok = await askYesNo("Write this config?", { defaultYes: true });
      if (!ok) {
        console.log(`\n  Cancelled. No changes made.`);
        return;
      }
    }
  } catch (err) {
    if (err instanceof AbortError) {
      console.log(`\n  Aborted. No changes made.`);
      return;
    }
    throw err;
  }

  // ── 4. Write ──────────────────────────────────────────────────────
  saveConfig(configPath, merged);
  console.log(`\n  ✓ Wrote ${configPath}`);
  console.log(`\n  Installed opencode-teamwork with ${Object.keys(agents).length} agents.`);
  console.log(`  Models:`);
  for (const [role, model] of Object.entries(agents)) {
    console.log(`    ${role.padEnd(28)} ${model}`);
  }
  console.log(`\n  Next: opencode (the plugin loads automatically).`);
  console.log(`  Try:  /teamwork "your problem here"`);
  console.log(`        /teamwork --topology long-proof "prove X"`);
  console.log(`        /teamwork --topology iterative-coding "fix this bug"`);
}

async function cmdUninstall(args: string[]): Promise<void> {
  const configPath = (() => {
    const i = args.indexOf("--config");
    return i >= 0 ? (args[i + 1] ?? resolveConfigPath()) : resolveConfigPath();
  })();
  const autoYes = yesFlag(args);
  const isTTY = process.stdout.isTTY;

  if (!existsSync(configPath)) {
    console.log(`  No config at ${configPath}. Nothing to remove.`);
    return;
  }

  // Preview what will be removed
  const config = loadExistingConfig(configPath);
  const preview: Record<string, any> = {};
  if (Array.isArray(config.plugin)) {
    preview.plugin = (config.plugin as string[]).filter(
      (p: string) => !p.startsWith("opencode-teamwork"),
    );
  }
  if (config.agent && typeof config.agent === "object") {
    preview.agent = { ...config.agent };
    for (const role of ROLES) {
      delete (preview.agent as Record<string, any>)[role];
    }
  }

  console.log(`\n  Will remove opencode-teamwork from: ${configPath}`);
  console.log(`  Changes that will be made:`);
  console.log(diffConfig(config, preview));

  try {
    if (!isTTY || autoYes) {
      console.log(`  Proceeding (--yes or non-interactive).`);
    } else {
      const ok = await askYesNo("Remove opencode-teamwork?", { defaultYes: false });
      if (!ok) {
        console.log(`\n  Cancelled. No changes made.`);
        return;
      }
    }
  } catch (err) {
    if (err instanceof AbortError) {
      console.log(`\n  Aborted. No changes made.`);
      return;
    }
    throw err;
  }

  saveConfig(configPath, preview);
  console.log(`  ✓ Removed opencode-teamwork from config.`);
  console.log(`    The package is still installed via npm. Run:`);
  console.log(`      npm uninstall -g opencode-teamwork   # to fully remove`);
}

async function cmdDoctor(_args: string[]): Promise<void> {
  const configPath = resolveConfigPath();
  console.log(`opencode-teamwork doctor\n`);
  console.log(`  Platform:     ${platform()} ${arch()}`);
  console.log(`  Node:         ${process.version}`);
  console.log(`  Config path:  ${configPath}`);

  if (!existsSync(configPath)) {
    console.log(`\n  ✗ No config found. Run \`opencode-teamwork install\`.`);
    process.exit(1);
  }
  const config = loadExistingConfig(configPath);
  const hasPlugin =
    Array.isArray(config.plugin) &&
    config.plugin.some((p: string) => p.startsWith("opencode-teamwork"));
  const agents = config.agent ?? {};
  const allRoles = ROLES.every((r) => r in agents);
  console.log(`  Plugin listed:  ${hasPlugin ? "✓" : "✗"}`);
  console.log(`  All roles set:  ${allRoles ? "✓" : "✗"}`);
  if (!hasPlugin) {
    console.log(`\n  Fix: run \`opencode-teamwork install\`.`);
    process.exit(1);
  }
  if (!allRoles) {
    const missing = ROLES.filter((r) => !(r in agents));
    console.log(`\n  Missing roles: ${missing.join(", ")}`);
    console.log(`  Fix: re-run \`opencode-teamwork install --reset\`.`);
    process.exit(1);
  }
  console.log(`\n  All checks passed.`);
}

function printHelp(): void {
  console.log(`opencode-teamwork — Antigravity-style multi-agent orchestration for OpenCode.

Usage:
  opencode-teamwork install [options]
  opencode-teamwork uninstall [options]
  opencode-teamwork doctor
  opencode-teamwork --help
  opencode-teamwork --version

Install options:
  --preset <name>     Use a preset: ${PRESETS.map((p) => p.name).join(", ")}, or 'custom' for per-role
  --reset             Overwrite the existing config (no merge; warns + confirms)
  --dry-run           Print the config that would be written, then exit
  --print             Alias for --dry-run
  --yes, -y           Skip all confirmation prompts (for CI / scripts)
  --config <path>     Override the config path (default: ~/.config/opencode/opencode.json)
  --help              Show this help

Uninstall options:
  --yes, -y           Skip the confirmation prompt
  --config <path>     Same as install

In every interactive prompt you can type 'q' or 'quit' to cancel
without making any changes. Invalid input is re-prompted, not
rejected.

Examples:
  opencode-teamwork install                              # interactive
  opencode-teamwork install --preset team                # use a preset
  opencode-teamwork install --preset google --reset      # replace existing config
  opencode-teamwork install --yes                        # non-interactive (CI)
  opencode-teamwork install --dry-run                    # preview, never write
  opencode-teamwork install --config /path/to/config.json
  opencode-teamwork uninstall --yes                      # CI-friendly uninstall
  opencode-teamwork doctor

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
    console.log(`opencode-teamwork ${pkg}`);
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
