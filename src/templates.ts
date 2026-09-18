/**
 * Agent / command / pattern templates.
 *
 * The important change here: agent frontmatter is PARSED and injected as real
 * OpenCode config keys (`mode`, `permission`, `temperature`, `color`,
 * `description`), not embedded in the system prompt as text.
 *
 * Previously the plugin did `config.agent[name] = { prompt: <whole markdown> }`,
 * which meant `permission: edit: deny` on the verifier did nothing, `mode`
 * defaulted to `all` (so every "hidden" subagent showed up in the agent menu),
 * and `temperature` was ignored — the segregation-of-duties claim was a
 * paragraph, not a boundary. See `agentConfigs()`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOPOLOGIES, resolvePatternsDir, type TopologyInfo } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "cli", "templates");
const PROMPTS_DIR = join(TEMPLATES_DIR, "prompts");

export type PermissionAction = "allow" | "deny" | "ask";

export interface AgentPermissions {
  edit: PermissionAction;
  bash: PermissionAction;
  webfetch: PermissionAction;
  task: PermissionAction;
}

export interface AgentTemplate {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  model: string;
  temperature: number;
  hidden: boolean;
  color: string;
  /** Markdown body with the frontmatter and the prompt placeholder removed. */
  prompt: string;
  permissions: AgentPermissions;
}

export interface CommandTemplate {
  name: string;
  description: string;
  agent: string;
  template: string;
}

// ─── Frontmatter parsing ─────────────────────────────────────────────

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: md };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function parseFrontmatter(fm: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m && m[1]) out[m[1]] = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function parsePermissionBlock(fm: string): AgentPermissions {
  const fallback: AgentPermissions = { edit: "ask", bash: "ask", webfetch: "allow", task: "allow" };
  const start = fm.indexOf("permission:");
  if (start < 0) return fallback;
  const lines = fm.slice(start).split(/\r?\n/).slice(1);
  const block: Record<string, string> = {};
  for (const line of lines) {
    if (line && !line.startsWith(" ")) break; // next top-level key
    const m = line.match(/^\s+([a-zA-Z]+):\s*(.+?)\s*$/);
    if (m && m[1]) block[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  const asAction = (v: string | undefined, dflt: PermissionAction): PermissionAction =>
    v === "allow" || v === "deny" || v === "ask" ? v : dflt;
  return {
    edit: asAction(block.edit, fallback.edit),
    bash: asAction(block.bash, fallback.bash),
    webfetch: asAction(block.webfetch, fallback.webfetch),
    task: asAction(block.task, fallback.task),
  };
}

function loadTemplateFile(relPath: string): string {
  return readFileSync(join(TEMPLATES_DIR, relPath), "utf-8");
}

/** Resolve `{file:./prompts/team/x.txt}` to the absolute installed path. */
function resolvePromptPlaceholder(body: string, name: string): string {
  const abs = join(PROMPTS_DIR, `${name}.txt`).replace(/\\/g, "/");
  return body
    .replace(/\{file:\.\/prompts\/team\/[^}]+\}/g, abs)
    .replace(/\{file:[^}]+\}/g, abs)
    .trim();
}

function loadAgent(file: string, promptName: string): AgentTemplate {
  const raw = loadTemplateFile(file);
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatter);
  const mode = fm.mode === "primary" || fm.mode === "all" ? fm.mode : "subagent";
  return {
    name: file.replace(/\.md$/, ""),
    description: fm.description ?? "",
    mode,
    model: fm.model ?? "anthropic/claude-sonnet-4-5",
    temperature: Number.isFinite(Number(fm.temperature)) ? Number(fm.temperature) : 0.2,
    hidden: fm.hidden === "true",
    color: fm.color ?? "#7c3aed",
    prompt: resolvePromptPlaceholder(body, promptName),
    permissions: parsePermissionBlock(frontmatter),
  };
}

const AGENT_FILES: Array<[string, string]> = [
  ["crafter.md", "crafter"],
  ["sentinel.md", "sentinel"],
  ["worker.md", "worker"],
  ["proof-worker.md", "proof-worker"],
  ["verifier.md", "verifier"],
  ["orchestrator.md", "orchestrator"],
  ["proposer.md", "proposer"],
  ["falsifier.md", "falsifier"],
  ["synthesizer.md", "synthesizer"],
  ["scout.md", "scout"],
];

export const AGENT_TEMPLATES: AgentTemplate[] = AGENT_FILES.map(([f, p]) => loadAgent(f, p));

export function getAgent(name: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((a) => a.name === name);
}

/** Declared permissions for a role, used by the runtime guard. */
export function agentPermissions(name: string): AgentPermissions | undefined {
  return getAgent(name)?.permissions;
}

// ─── Pattern library (so the 6 pattern files actually reach the model) ──

export interface PatternTemplate {
  name: string;
  summary: string;
  path: string | null;
  body: string;
}

/**
 * The topology index injected into the orchestrating agents' prompts.
 * Absolute paths, because the model runs in the user's project while the
 * patterns live in the installed package — before this, the sentinel was
 * told to pick a topology whose definition it had no way to read, using names
 * that matched no file.
 */
export function topologyIndex(): string {
  const dir = resolvePatternsDir();
  const rows = TOPOLOGIES.map((t: TopologyInfo) => {
    const p = dir ? join(dir, t.file).replace(/\\/g, "/") : `(missing: ${t.file})`;
    return `| \`${t.name}\` | ${t.summary} | \`${p}\` |`;
  });
  return [
    "## Topology library",
    "",
    "Pick exactly one. Read its file before planning — the file is the definition, this table is only an index.",
    "If a name is not in this table it does not exist; do not invent one.",
    "",
    "| topology | shape | definition |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

export function getAllPatterns(): PatternTemplate[] {
  const dir = resolvePatternsDir();
  return TOPOLOGIES.map((t) => {
    const path = dir ? join(dir, t.file) : null;
    return {
      name: t.name,
      summary: t.summary,
      path,
      body: path && existsSync(path) ? readFileSync(path, "utf-8") : "",
    };
  });
}

// ─── Agent config injection (the P0 fix) ─────────────────────────────

export interface InjectedAgentConfig {
  description?: string;
  mode: "primary" | "subagent" | "all";
  model?: string;
  temperature: number;
  color?: string;
  permission: AgentPermissions;
  prompt: string;
  hidden?: boolean;
  /** Only the sentinel/orchestrator may invoke subagents; leaves may not. */
  tools?: Record<string, boolean>;
}

/**
 * Build the config for one agent.
 *
 * `existing` is whatever the user (or the CLI installer) already put in
 * `opencode.json` for this agent — crucially `model`. The old code replaced
 * that object wholesale, which silently discarded the per-role model the
 * installer had just written.
 */
export function agentConfigFor(agent: AgentTemplate, existing?: Record<string, unknown>): InjectedAgentConfig {
  const config: InjectedAgentConfig = {
    mode: agent.mode,
    temperature: agent.temperature,
    permission: agent.permissions,
    // Orchestrating agents get the topology library appended: they are the
    // ones who must pick a topology, and the pattern files live in the
    // installed package rather than in the user's project.
    prompt: agent.mode === "primary" ? `${agent.prompt}\n\n${topologyIndex()}\n` : agent.prompt,
  };
  if (agent.description) config.description = agent.description;
  if (agent.color) config.color = agent.color;
  const model = typeof existing?.["model"] === "string" ? (existing["model"] as string) : agent.model;
  if (model) config.model = model;
  return config;
}

export function agentConfigs(existing?: Record<string, Record<string, unknown>>): Record<string, InjectedAgentConfig> {
  const out: Record<string, InjectedAgentConfig> = {};
  for (const agent of AGENT_TEMPLATES) {
    const prior = existing?.[`team/${agent.name}`];
    out[`team/${agent.name}`] = agentConfigFor(agent, prior);
  }
  return out;
}

/**
 * Agent bodies with the topology index appended, keyed by agent name.
 * Kept for callers that want the prompt text only.
 */
export function getAllAgentBodies(): Record<string, string> {
  const out: Record<string, string> = {};
  const index = topologyIndex();
  for (const agent of AGENT_TEMPLATES) {
    const orchestrating = agent.mode === "primary";
    out[agent.name] = orchestrating ? `${agent.prompt}\n\n${index}\n` : agent.prompt;
  }
  return out;
}

// ─── Commands ────────────────────────────────────────────────────────

const COMMAND_FILES = [
  "teamwork.md",
  "teamwork-craft.md",
  "team-orchestrate.md",
  "team-propose.md",
  "team-falsify.md",
  "team-synthesize.md",
  "team-review.md",
];

export function getAllCommands(): CommandTemplate[] {
  const out: CommandTemplate[] = [];
  for (const file of COMMAND_FILES) {
    const name = file.replace(/\.md$/, "");
    const raw = loadTemplateFile(`commands/${file}`);
    const { frontmatter, body } = splitFrontmatter(raw);
    const fm = parseFrontmatter(frontmatter);
    out.push({
      name,
      description: fm.description ?? "",
      agent: fm.agent ?? "team/sentinel",
      template: body.trim(),
    });
  }
  return out;
}

// ─── SKILL.md body ───────────────────────────────────────────────────

export const SKILL_BODY = `# Teamwork — Multi-Agent Orchestration for OpenCode

${AGENT_TEMPLATES.length} agents, ${TOPOLOGIES.length} topologies,
${COMMAND_FILES.length} slash commands. The run is owned by code: agents propose
and work, the engine decides order, retries, budget and terminal state.

## The ${AGENT_TEMPLATES.length} agents

| Agent | Role | Mode |
|---|---|---|
${AGENT_TEMPLATES.map((a) => `| \`team/${a.name}\` | ${a.description.split(".")[0] ?? ""} | ${a.mode}${a.permissions.edit === "deny" ? " (read-only)" : ""} |`).join("\n")}

Read-only roles are enforced twice: as an OpenCode \`permission.edit: deny\`
and by a runtime guard that refuses write tools for those sessions.

## The ${TOPOLOGIES.length} topologies

${TOPOLOGIES.map((t) => `- \`${t.name}\` — ${t.summary}`).join("\n")}

## The engine

The sentinel never decides dispatch order in prose. It calls:

- \`teamwork_plan\` — validate the DAG, create the run, provision worktrees
- \`teamwork_dispatch\` — ask which tasks are ready now (topological + budget)
- \`teamwork_verify\` — submit a verifier report; the engine rules on it
- \`teamwork_status\` / \`teamwork_resume\` — derive state from the event log

A PASS is only accepted when the report contains at least one executed check
that recorded a command and its exit code. Reading the diff and judging is not
a verification.
`;
