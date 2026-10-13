// Reviewed, source-backed content for the opencode-teamwork landing page.
//
// Every inventory, snippet and status claim here is grounded in the committed
// release at releaseCommit (the 0.2.1 CLI, templates and plugin entry). This
// module holds authored copy only; it never ingests README or uncommitted
// working-tree text. render.mjs consumes this object and escapes it as text.
//
// Provenance note: the published registry artifact's gitHead differs from the
// local release commit, so this page claims only that reviewed *behavior*
// matches the source at releaseCommit, never that the published build is
// byte-identical to it.

export const releaseCommit = "70c1dbaa07819f0b9612f032d27ca5ffd626fe04";
export const documentedRelease = "0.2.1";

const REPO = "https://github.com/aditya0si/OpenCode-Team";

const configJson = `{
  "plugin": ["opencode-teamwork@0.2.1"],
  "agent": {
    "team/crafter": { "model": "anthropic/claude-sonnet-4-5" },
    "team/sentinel": { "model": "anthropic/claude-sonnet-4-5" },
    "team/worker": { "model": "anthropic/claude-sonnet-4-5" },
    "team/proof-worker": { "model": "anthropic/claude-sonnet-4-5" },
    "team/verifier": { "model": "anthropic/claude-sonnet-4-5" },
    "team/orchestrator": { "model": "anthropic/claude-sonnet-4-5" },
    "team/proposer": { "model": "anthropic/claude-sonnet-4-5" },
    "team/falsifier": { "model": "anthropic/claude-sonnet-4-5" },
    "team/synthesizer": { "model": "anthropic/claude-sonnet-4-5" },
    "team/scout": { "model": "anthropic/claude-sonnet-4-5" }
  }
}`;

export const landingContent = {
  documentedRelease,
  releaseCommit,

  hero: {
    headline: "Give complex work a team, not another giant prompt.",
    body:
      "Coordinate specialist roles inside OpenCode. Start with a clear task, ask for competing approaches, challenge the result, and inspect the evidence before you accept it.",
    note:
      "Release documented: 0.2.1. The plugin registers roles and commands; agent prompts own the orchestration loop.",
  },

  illustration: {
    caption: "Illustrative workflow, not a live run.",
    steps: [
      {
        label: "Task brief",
        responsibility: "Crafter defines the spec and acceptance criteria",
      },
      {
        label: "Coordinate",
        responsibility: "Sentinel or orchestrator selects a template and dispatches",
      },
      {
        label: "Work",
        responsibility: "Worker and proof-worker produce scoped changes",
      },
      {
        label: "Review",
        responsibility: "Verifier checks evidence; human approval is recommended",
      },
    ],
    feedback: "Revise after findings",
  },

  roles: [
    {
      id: "team/crafter",
      description:
        "Brief creation: runs the elicitation flow and drafts the spec, plan, acceptance criteria and model allocation before a run.",
    },
    {
      id: "team/sentinel",
      description:
        "Coordination: the /teamwork entry point. Loads a spec, picks a topology, dispatches work and applies verification before merging.",
    },
    {
      id: "team/worker",
      description:
        "Implementation: takes a scoped spec into its own worktree and returns a diff plus summary.",
    },
    {
      id: "team/proof-worker",
      description:
        "Proofs: a worker for math and formal proofs whose output is checked by a formal verifier.",
    },
    {
      id: "team/verifier",
      description:
        "Checks: runs a verification plan against a patch and returns PASS/FAIL with evidence.",
    },
    {
      id: "team/orchestrator",
      description:
        "Legacy loop: the original propose, falsify, synthesize and verify coordinator.",
    },
    {
      id: "team/proposer",
      description: "Proposals: generates one candidate solution per invocation.",
    },
    {
      id: "team/falsifier",
      description:
        "Critique: attacks a candidate and must state explicitly when it finds no flaw.",
    },
    {
      id: "team/synthesizer",
      description:
        "Synthesis: merges the strongest parts of several candidates and drops flagged failure modes.",
    },
    {
      id: "team/scout",
      description:
        "Context: read-only gatherer that pulls code, history, docs and failing tests into one report.",
    },
  ],

  commands: [
    {
      id: "/teamwork",
      description:
        "Sentinel dispatcher: loads a spec, provisions a worktree, builds the DAG and runs workers plus verifiers.",
    },
    {
      id: "/teamwork-craft",
      description:
        "Phase-1 brief crafter. Runs the elicitation flow and produces prompt_draft.md before any dispatch.",
    },
    {
      id: "/team-orchestrate",
      description:
        "Legacy v1 propose/falsify/synthesize/verify loop without DAG, worktrees or cost tracking.",
    },
    {
      id: "/team-propose",
      description:
        "Run only the propose step and generate candidate solutions for inspection.",
    },
    {
      id: "/team-falsify",
      description:
        "Run only the falsifier step against existing candidates for adversarial critique.",
    },
    {
      id: "/team-synthesize",
      description: "Run the synthesizer on existing candidates plus their critiques.",
    },
    {
      id: "/team-review",
      description:
        "Run the verifier on the current synthesis or candidate for a binary PASS/FAIL with evidence.",
    },
  ],

  patterns: [
    {
      id: "small-focused",
      description:
        "One bounded fix with review; a single agent may be enough.",
    },
    {
      id: "iterative-coding",
      description: "Repeated candidate and critique refinement.",
    },
    {
      id: "distributed-coding",
      description: "Tasks that can be split across modules.",
    },
    {
      id: "document-review",
      description: "Critique a local RFC or document.",
    },
    {
      id: "long-proof",
      description: "Proof exploration; formal checking needs your tools.",
    },
    {
      id: "massive-proof-swarm",
      description:
        "Large proof exploration; opt-in and potentially expensive, not a promise of a worker count.",
    },
  ],

  snippets: [
    {
      id: "install-preview",
      label: "Preview the install (writes nothing)",
      copyLabel: "Copy install preview command",
      language: "sh",
      text: "npx opencode-teamwork@0.2.1 install --preset anthropic --print",
    },
    {
      id: "install-write",
      label: "Install with the documented preset",
      copyLabel: "Copy install command",
      language: "sh",
      text: "npx opencode-teamwork@0.2.1 install --preset anthropic",
    },
    {
      id: "install-bunx",
      label: "Alternative with Bun",
      copyLabel: "Copy bunx install command",
      language: "sh",
      text: "bunx opencode-teamwork@0.2.1 install --preset anthropic",
    },
    {
      id: "launch-opencode",
      label: "Start OpenCode",
      copyLabel: "Copy launch command",
      language: "sh",
      text: "opencode",
    },
    {
      id: "install-config-print",
      label: "Preview against an explicit config file",
      copyLabel: "Copy config preview command",
      language: "sh",
      text: "npx opencode-teamwork@0.2.1 install --preset anthropic --print --config ./opencode.json",
    },
    {
      id: "doctor",
      label: "Check the installed configuration (limited)",
      copyLabel: "Copy doctor command",
      language: "sh",
      text: "npx opencode-teamwork@0.2.1 doctor",
    },
    {
      id: "uninstall",
      label: "Remove the plugin entry",
      copyLabel: "Copy uninstall command",
      language: "sh",
      text: "npx opencode-teamwork@0.2.1 uninstall",
    },
    {
      id: "config-json",
      label: "Installer-written example (not effective runtime per-role settings)",
      copyLabel: "Copy JSON configuration",
      language: "json",
      text: configJson,
    },
    {
      id: "workflow-example",
      label: "Run inside OpenCode",
      copyLabel: "Copy /teamwork example",
      language: "text",
      text:
        '/teamwork --topology distributed-coding "Split the parser and formatter changes into scoped tasks. Add regression tests and report unresolved review findings."',
    },
    {
      id: "workflow-craft",
      label: "Run inside OpenCode",
      copyLabel: "Copy /teamwork-craft example",
      language: "text",
      text: '/teamwork-craft "Help define acceptance criteria for a parser refactor."',
    },
    {
      id: "workflow-orchestrate",
      label: "Run inside OpenCode",
      copyLabel: "Copy /team-orchestrate example",
      language: "text",
      text:
        '/team-orchestrate "Propose and challenge fixes for the off-by-one in parser.ts."',
    },
  ],

  sections: [
    {
      id: "workflow",
      navLabel: "Workflow",
      heading: "How the workflow runs",
      paragraphs: [
        "Start by defining acceptance criteria for the problem. The crafter role turns a request into a spec, a plan and a way to tell whether the work is done.",
        "Select a workflow template, then let specialist roles produce work and challenge it. The plugin registers the roles and slash commands; the agent prompts own the orchestration loop, so outcomes depend on the host, tools, permissions and models you configure.",
        "When a run finishes, inspect the artifacts and diffs it produced and run your own project checks. Model selection is configuration, not proof of independent reasoning, and human approval is recommended rather than an enforced runtime gate.",
        "Paths the prompts ask agents to produce: .opencode/teamwork/<session-id>/prompt_draft.md, plan.dag.json and final.md, plus .teamwork-runs/<run-id>/final.md. The prompts request these files; the plugin does not assert that they always exist or that their schemas are enforced automatically.",
      ],
    },
    {
      id: "patterns",
      navLabel: "Templates",
      heading: "Workflow templates",
      paragraphs: [
        "Six packaged templates guide how much structure a run uses. The orchestrator can select one from the prompt, and /teamwork accepts an explicit --topology override.",
      ],
    },
    {
      id: "install",
      navLabel: "Install",
      heading: "Install: preview before changing configuration",
      paragraphs: [
        "OpenCode must already be installed, with Node and npm for npx or Bun for bunx, and a configured provider and model you can use in the host. Provider authentication and fees are separate from this package.",
        "Preview first. The write command can replace the plugin array in your configuration, so back up the file and preserve any other plugin entries manually.",
        "Pinning the installer matters: the CLI stores a moving dependency in your config, so the pinned manual entry below is the one that actually fixes the documented release.",
      ],
    },
    {
      id: "configure",
      navLabel: "Configure",
      heading: "Configuration",
      paragraphs: [
        "Default configuration path: ~/.config/opencode/opencode.json. OPENCODE_CONFIG_DIR selects the directory, and install --config selects an explicit file. Back up before editing.",
        "The example below is the complete, valid JSON the release installer writes: a pinned plugin entry plus a role map. Treat it as the installer-written example, not as effective runtime per-role settings.",
        "In 0.2.1 the plugin's config hook replaces every team role with its prompt body, so any model or temperature you add to a role here does not govern runtime behavior. Model selection depends on your OpenCode host defaults; this page does not promise an unsupported fix. Keep any other plugin entries you already use.",
      ],
    },
    {
      id: "commands",
      navLabel: "Commands",
      heading: "Slash commands",
      paragraphs: [
        "The plugin registers seven slash commands. Arguments are passed through to the agent prompt; they are not parsed by a validated CLI argument parser.",
        "Use the split commands to inspect intermediate artifacts before committing to the next phase.",
      ],
    },
    {
      id: "release-status",
      navLabel: "Release status",
      heading: "Release status",
      paragraphs: [
        "Release status is stated in three parts so the shipped package is never confused with prompt-owned behavior or unpublished work.",
      ],
    },
    {
      id: "faq",
      navLabel: "FAQ",
      heading: "Frequently asked questions",
      paragraphs: [],
    },
  ],

  faq: [
    {
      question: "When is one agent enough?",
      answer:
        "For small, bounded tasks a single agent is usually cheaper and faster. The orchestration overhead is only worth it when a problem benefits from competing approaches or independent review.",
    },
    {
      question: "Does review guarantee correctness?",
      answer:
        "No. Review produces findings you still have to inspect, and you should run your own tests. A verifier report is evidence to evaluate, not a proof.",
    },
    {
      question: "Can I select different models?",
      answer:
        "In 0.2.1, editing the per-role model in this JSON does not reliably change runtime models: the plugin's config hook replaces each team role with its prompt body. Model selection follows your OpenCode host defaults, so treat per-role model entries as not effective runtime settings here.",
    },
    {
      question: "Where are results?",
      answer:
        "The prompts ask agents to write files such as prompt_draft.md, plan.dag.json and final.md. Inspect the actual run directory; existence and schemas are not enforced by the plugin.",
    },
    {
      question: "Is this an official product?",
      answer:
        "No. opencode-teamwork is an independent community project. No affiliation with Google, Antigravity, OpenCode or a model provider is implied.",
    },
  ],

  releaseRows: [
    {
      status: "released",
      title: "Released 0.2.1",
      text:
        "Role and command registration, packaged prompt templates and installer configuration. Workflows are prompt-owned.",
    },
    {
      status: "prompt-guided",
      title: "Prompt instructions, not guarantees",
      text:
        "Planning, worktree use, verification loops, artifact writing and budget guidance are prompt instructions. Outcomes depend on the host, tools, permissions, models and agent execution; inspect changes and run your own tests.",
    },
    {
      status: "development",
      title: "Development only",
      text:
        "v0.3.0 engine work on the teamwork-review-build branch is unpublished. It is not attached to any install command, and no tests or reliability claims are made for it here.",
    },
  ],

  links: {
    npm: {
      label: "npm package",
      href: "https://www.npmjs.com/package/opencode-teamwork",
    },
    repository: { label: "GitHub repository", href: REPO },
    issues: { label: "Issue tracker", href: `${REPO}/issues` },
    license: { label: "MIT license source", href: `${REPO}/blob/main/LICENSE` },
    commandTemplates: {
      label: "Command templates at the release commit",
      href: `${REPO}/tree/${releaseCommit}/src/cli/templates/commands`,
    },
    development: {
      label: "Unpublished development branch",
      href: `${REPO}/tree/teamwork-review-build`,
    },
  },

  warnings: {
    installerPin:
      "Pinning the installer to 0.2.1 does not pin the installed plugin: this CLI writes opencode-teamwork@latest. For the documented release, change that entry to opencode-teamwork@0.2.1 before starting OpenCode.",
    pluginArray:
      "The installer can replace the plugin array; preserve other plugin entries manually. Back up your OpenCode configuration first.",
    preview:
      "--print and --dry-run show the proposed patch, not the final merged file, and never write to disk.",
    provider:
      "Example based on the release's anthropic preset, not a model recommendation or availability guarantee. Provider authentication and fees are separate from this package.",
    runtimeModel:
      "Not effective runtime per-role settings: this is the JSON the installer writes, not configuration that governs runtime. In 0.2.1 the plugin's config hook replaces every team role with its prompt body, discarding any model or temperature set on the role. Model selection follows your OpenCode host defaults; no fix is promised here.",
    resetYes:
      "--yes bypasses the confirmation prompt, and --reset overwrites an existing configuration. Neither is a primary action here.",
    doctor:
      "doctor checks the default or environment config path for the plugin and role entries. It does not test provider authentication, model availability or workflow correctness, and it takes no --config override.",
    uninstallDataLoss:
      "Data-loss warning before you run this: uninstall rebuilds your configuration from scratch and keeps only the plugin and agent keys. Any other top-level keys you have set — including provider, theme and permission — are dropped. Back up opencode.json first, then restore the backup or re-add those keys afterwards.",
    uninstall:
      "uninstall edits your configuration file. It does not universally remove cached or global packages, so review the file afterwards.",
  },
};

const EXPECTED_INVENTORY = { roles: 10, commands: 7, patterns: 6 };
const KNOWN_STATUS = ["released", "prompt-guided", "development"];

const FORBIDDEN_CLAIMS = [
  /guaranteed isolation/i,
  /automatic isolation/i,
  /enforced budget/i,
  /resume-?safe engine/i,
  /zero[- ]cost/i,
  /atomic merge/i,
  /durable recovery/i,
  /deterministic dispatch/i,
];

const NEGATION = /\b(not|no|never|cannot|without|does not|do not|is not|are not)\b[^.]{0,24}$/i;

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function assertUniqueIds(label, items) {
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(`${label}: every entry needs a non-empty string id`);
    }
    if (seen.has(item.id)) {
      throw new Error(`${label}: duplicate id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

/**
 * Validate landing content structure and truth constraints.
 * Throws an actionable Error on the first problem found.
 */
export function validateContent(content = landingContent) {
  if (!content || typeof content !== "object") {
    throw new Error("content: expected an object");
  }

  if (content.documentedRelease !== documentedRelease) {
    throw new Error(
      `content.documentedRelease: expected "${documentedRelease}", got ${JSON.stringify(
        content.documentedRelease,
      )}`,
    );
  }
  if (content.releaseCommit !== releaseCommit) {
    throw new Error(
      `content.releaseCommit: expected "${releaseCommit}", got ${JSON.stringify(
        content.releaseCommit,
      )}`,
    );
  }

  assertUniqueIds("roles", content.roles ?? []);
  assertUniqueIds("commands", content.commands ?? []);
  assertUniqueIds("patterns", content.patterns ?? []);
  assertUniqueIds("snippets", content.snippets ?? []);

  const counts = {
    roles: (content.roles ?? []).length,
    commands: (content.commands ?? []).length,
    patterns: (content.patterns ?? []).length,
  };
  for (const [key, expected] of Object.entries(EXPECTED_INVENTORY)) {
    if (counts[key] !== expected) {
      throw new Error(
        `inventory mismatch: expected ${expected} ${key}, found ${counts[key]}`,
      );
    }
  }

  for (const row of content.releaseRows ?? []) {
    if (!KNOWN_STATUS.includes(row.status)) {
      throw new Error(`releaseRows: unknown status "${row.status}"`);
    }
  }

  const snippetIds = new Set((content.snippets ?? []).map((s) => s.id));
  for (const snippet of content.snippets ?? []) {
    if (!["sh", "text", "json"].includes(snippet.language)) {
      throw new Error(
        `snippets[${snippet.id}]: unsupported language "${snippet.language}"`,
      );
    }
    if (typeof snippet.text !== "string" || snippet.text.length === 0) {
      throw new Error(`snippets[${snippet.id}]: missing text`);
    }
    if (snippet.language === "json") {
      try {
        JSON.parse(snippet.text);
      } catch (err) {
        throw new Error(
          `snippets[${snippet.id}]: invalid JSON example (${err.message})`,
        );
      }
    }
  }
  if (!snippetIds.size) {
    throw new Error("snippets: at least one snippet is required");
  }

  for (const [key, link] of Object.entries(content.links ?? {})) {
    if (!link || typeof link.href !== "string") {
      throw new Error(`links.${key}: missing href`);
    }
    if (!/^https:\/\//.test(link.href)) {
      throw new Error(
        `links.${key}: invalid scheme, expected https (${link.href})`,
      );
    }
  }

  const strings = collectStrings(
    {
      hero: content.hero,
      illustration: content.illustration,
      sections: content.sections,
      roles: content.roles,
      commands: content.commands,
      patterns: content.patterns,
      faq: content.faq,
      releaseRows: content.releaseRows,
      warnings: content.warnings,
    },
    [],
  );
  for (const text of strings) {
    for (const pattern of FORBIDDEN_CLAIMS) {
      const match = pattern.exec(text);
      if (match) {
        const before = text.slice(0, match.index);
        if (!NEGATION.test(before)) {
          throw new Error(
            `forbidden claim in released copy: "${match[0]}" (${pattern})`,
          );
        }
      }
    }
  }

  return undefined;
}
