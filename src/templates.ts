import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "cli", "templates");
const PROMPTS_DIR = join(TEMPLATES_DIR, "prompts");

export interface AgentTemplate {
  name: string;
  description: string;
  mode: "primary" | "subagent" | "all";
  model: string;
  temperature: number;
  hidden: boolean;
  color: string;
  body: string; // the full markdown (frontmatter + body)
  promptFile: string; // path inside the package
  permissions: {
    edit: "allow" | "deny" | "ask";
    bash: "allow" | "deny" | "ask";
    webfetch: "allow" | "deny" | "ask";
    task: "allow" | "deny" | "ask";
  };
}

export interface CommandTemplate {
  name: string;
  description: string;
  agent: string;
  body: string;
}

export interface PatternTemplate {
  name: string;
  body: string;
}

function loadTemplateFile(relPath: string): string {
  return readFileSync(join(TEMPLATES_DIR, relPath), "utf-8");
}

function loadPromptFile(name: string): string {
  return readFileSync(join(PROMPTS_DIR, `${name}.txt`), "utf-8");
}

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  // Frontmatter is between the first pair of --- lines
  const match = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: "", body: md };
  return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
}

function parseFrontmatter(fm: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function parsePermissionBlock(fm: string): AgentTemplate["permissions"] {
  // crude but sufficient: find the `permission:` block, then the
  // children until the next top-level key (no leading spaces).
  const start = fm.indexOf("permission:");
  if (start < 0) {
    return { edit: "ask", bash: "ask", webfetch: "allow", task: "allow" };
  }
  const rest = fm.slice(start);
  const lines = rest.split("\n").slice(1);
  const block: Record<string, string> = {};
  for (const line of lines) {
    if (line && !line.startsWith(" ")) break; // next top-level key
    const m = line.match(/^\s+([a-zA-Z]+):\s*(.+?)\s*$/);
    if (m) block[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return {
    edit: (block.edit as "allow" | "deny" | "ask") ?? "ask",
    bash: (block.bash as "allow" | "deny" | "ask") ?? "ask",
    webfetch: (block.webfetch as "allow" | "deny" | "ask") ?? "allow",
    task: (block.task as "allow" | "deny" | "ask") ?? "allow",
  };
}

function loadAgent(file: string, promptName: string): AgentTemplate {
  const raw = loadTemplateFile(file);
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatter);
  return {
    name: file.replace(/\.md$/, ""),
    description: fm.description ?? "",
    mode: (fm.mode as "primary" | "subagent" | "all") ?? "subagent",
    model: fm.model ?? "anthropic/claude-sonnet-4-5",
    temperature: Number(fm.temperature ?? "0.2"),
    hidden: fm.hidden === "true",
    color: fm.color ?? "#7c3aed",
    body: raw,
    promptFile: `./prompts/team/${promptName}.txt`,
    permissions: parsePermissionBlock(frontmatter),
  };
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  loadAgent("crafter.md", "crafter"),
  loadAgent("sentinel.md", "sentinel"),
  loadAgent("worker.md", "worker"),
  loadAgent("proof-worker.md", "proof-worker"),
  loadAgent("verifier.md", "verifier"),
  loadAgent("orchestrator.md", "orchestrator"),
  loadAgent("proposer.md", "proposer"),
  loadAgent("falsifier.md", "falsifier"),
  loadAgent("synthesizer.md", "synthesizer"),
  loadAgent("scout.md", "scout"),
];

export function getAgent(name: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((a) => a.name === name);
}

export function getAgentBodyWithPromptPath(name: string): string {
  const agent = getAgent(name);
  if (!agent) throw new Error(`Unknown agent: ${name}`);
  // Replace the {file:./prompts/team/<name>.txt} placeholder with the
  // absolute path inside the installed package so opencode can resolve it.
  const absPath = join(TEMPLATES_DIR, "prompts", `${name}.txt`).replace(
    /\\/g,
    "/",
  );
  return agent.body.replace(agent.promptFile, absPath);
}

export function getAllAgentBodies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of AGENT_TEMPLATES) out[a.name] = getAgentBodyWithPromptPath(a.name);
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

export function getAllCommandBodies(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of COMMAND_FILES) {
    const name = file.replace(/\.md$/, "");
    const raw = loadTemplateFile(`commands/${file}`);
    const { frontmatter } = splitFrontmatter(raw);
    const fm = parseFrontmatter(frontmatter);
    out[name] = {
      template: raw,
      description: fm.description ?? "",
      agent: fm.agent ?? "team/orchestrator",
    } as unknown as string;
  }
  return out;
}

// We need a richer shape — re-export as parsed.
export interface ParsedCommand {
  name: string;
  description: string;
  agent: string;
  template: string;
}

export function getAllCommands(): ParsedCommand[] {
  const out: ParsedCommand[] = [];
  for (const file of COMMAND_FILES) {
    const name = file.replace(/\.md$/, "");
    const raw = loadTemplateFile(`commands/${file}`);
    const { frontmatter, body } = splitFrontmatter(raw);
    const fm = parseFrontmatter(frontmatter);
    out.push({
      name,
      description: fm.description ?? "",
      agent: fm.agent ?? "team/orchestrator",
      template: body.trim(),
    });
  }
  return out;
}

// ─── Patterns ────────────────────────────────────────────────────────

export function getAllPatterns(): PatternTemplate[] {
  const out: PatternTemplate[] = [];
  for (const name of [
    "small-focused",
    "long-proof",
    "iterative-coding",
    "distributed-coding",
    "document-review",
    "massive-proof-swarm",
  ]) {
    out.push({
      name,
      body: loadTemplateFile(`patterns/${name}.md`),
    });
  }
  return out;
}

// ─── SKILL.md body ───────────────────────────────────────────────────

export const SKILL_BODY = `# Teamwork — Multi-Agent Orchestration for OpenCode

A replica of Google Antigravity's \`/teamwork-preview\`, packaged as an
opencode plugin. 6 agents, 4 patterns, 5 slash commands.

## The 6 agents

| Agent | Role | Hidden |
|---|---|---|
| \`team/orchestrator\` | Lead coordinator. Picks a pattern, runs the loop. | no (primary) |
| \`team/proposer\` | Generates candidate solutions. | yes |
| \`team/falsifier\` | Attacks a candidate. Adversarial by design. | yes |
| \`team/synthesizer\` | Merges candidates + critiques. | yes |
| \`team/verifier\` | Final correctness gate. | yes |
| \`team/scout\` | Read-only context gatherer. Runs first. | yes |

The \`hidden: true\` flag on the sub-agents means they don't appear in
the \`@\` autocomplete menu — they're invoked by the orchestrator via the
\`task\` tool. You can still @-mention them manually if you want.

## The 4 patterns

| Pattern | When |
|---|---|
| \`long-proof\` | "prove", "show that", open problem, Lean/Coq |
| \`iterative-coding\` | "fix this bug", "add a feature to this function" |
| \`distributed-coding\` | "build this across N files", parallel workers |
| \`document-review\` | "review this paper", "what does this say" |

The orchestrator picks the pattern from the prompt. You can force one
with \`/teamwork --pattern iterative-coding "fix the bug in foo.ts"\`.

## The 5 slash commands

| Command | Does |
|---|---|
| \`/teamwork [args]\` | Full Teamwork run. |
| \`/team-propose [args]\` | Just the propose step. |
| \`/team-falsify [args]\` | Just the falsify step on existing candidates. |
| \`/team-synthesize [args]\` | Just the synthesis step. |
| \`/team-review [args]\` | Just the verify step. |

The split commands let you inspect intermediate artifacts before
committing to the next phase. Useful when you want to see what
candidates look like before deciding whether to merge them.

## Per-role model selection

Each agent has a \`model\` field. The plugin's defaults are
anthropic/claude-sonnet-4-5 across the board (cheap + smart), but the
installer lets you mix and match. Common mix:

- \`orchestrator\`: opus-4.5 (smartest, slowest)
- \`proposer\`: sonnet-4.5 (cheap, run many)
- \`falsifier\`: sonnet-4.5 (need smart, but cheap)
- \`synthesizer\`: opus-4.5 (smartest merge)
- \`verifier\`: sonnet-4.5 (cheap, run many)
- \`scout\`: haiku-4.5 (read-only, fast)

You can also mix providers. \`team/proposer\` on Gemini Flash,
\`team/falsifier\` on Claude Sonnet, etc. This is the same pattern
Google's research used (Flash + Pro 3.1 hit 71% on TCSBench).

## When to skip Teamwork

If the user prompt is a single, simple task ("rename this function",
"add a console.log", "explain this line"), do not use Teamwork. Use
the default opencode build agent. Teamwork is overkill for everyday
work — it's for the problems that take hours or days and where one
model gets it wrong.

The orchestrator asks once: "Skipping Teamwork — I'll work as a single
agent. OK?" before falling back.
`;
