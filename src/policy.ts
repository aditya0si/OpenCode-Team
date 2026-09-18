/**
 * The topology + routing policy registry.
 *
 * Single source of truth for topology names. Before this file existed the
 * pattern *files* said `long-proof` / `distributed-coding` / `document-review`
 * while the sentinel prompt and `state.ts` said `proof` / `large-swarm` /
 * `doc-review` — four of five names in the routing table resolved to no file.
 * Anything that needs a topology name imports it from here, and
 * `assertTopologiesResolve()` (called at plugin load and in tests) fails hard
 * if a name stops mapping to a pattern file.
 *
 * The policy is data: `routing` maps a task class to a model ladder and a
 * topology. A later milestone lets the learning loop propose a typed delta
 * over exactly these fields (see docs/self-improvement.md) — nothing here is
 * hidden inside a prompt.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TopologyInfo {
  name: string;
  file: string;
  summary: string;
  defaultConcurrency: number;
  defaultMaxRounds: number;
  defaultMaxCostUsd: number;
}

export const TOPOLOGIES = [
  {
    name: "small-focused",
    file: "small-focused.md",
    summary: "1 builder + 1 reviewer loop",
    defaultConcurrency: 1,
    defaultMaxRounds: 2,
    defaultMaxCostUsd: 3,
  },
  {
    name: "iterative-coding",
    file: "iterative-coding.md",
    summary: "single proposer + falsifier + verify loop (no synthesis)",
    defaultConcurrency: 1,
    defaultMaxRounds: 4,
    defaultMaxCostUsd: 5,
  },
  {
    name: "distributed-coding",
    file: "distributed-coding.md",
    summary: "N workers in parallel + verifiers, merged by the sentinel",
    defaultConcurrency: 4,
    defaultMaxRounds: 4,
    defaultMaxCostUsd: 20,
  },
  {
    name: "long-proof",
    file: "long-proof.md",
    summary: "1 strategist + 3-5 searchers + a formal checker",
    defaultConcurrency: 3,
    defaultMaxRounds: 6,
    defaultMaxCostUsd: 40,
  },
  {
    name: "massive-proof-swarm",
    file: "massive-proof-swarm.md",
    summary: "meta-coordinator + 100+ searchers (opt-in)",
    defaultConcurrency: 8,
    defaultMaxRounds: 24,
    defaultMaxCostUsd: 200,
  },
  {
    name: "document-review",
    file: "document-review.md",
    summary: "1 chair + 3 critics + 1 aggregator",
    defaultConcurrency: 3,
    defaultMaxRounds: 2,
    defaultMaxCostUsd: 12,
  },
] as const satisfies readonly TopologyInfo[];

export type Topology = (typeof TOPOLOGIES)[number]["name"];

export const TOPOLOGY_NAMES: readonly string[] = TOPOLOGIES.map((t) => t.name);

export function getTopology(name: string): TopologyInfo | undefined {
  return TOPOLOGIES.find((t) => t.name === name);
}

export function isTopology(name: string): name is Topology {
  return TOPOLOGY_NAMES.includes(name);
}

// ─── Model routing policy ────────────────────────────────────────────

export interface RouteRule {
  /** Model ladder, cheapest first. The router escalates on repeated failure. */
  ladder: string[];
  topology?: Topology;
  /** Extra verification checks this task class must run to PASS. */
  requiredChecks?: string[];
}

export interface Policy {
  version: number;
  budget: { perTaskUsd: number; perSessionUsd: number; haltAtPct: number };
  routing: Record<string, RouteRule>;
  /** Prompt fragment files, keyed by role (data, not code). */
  promptFragments: Record<string, string>;
}

export const DEFAULT_POLICY: Policy = {
  version: 1,
  budget: { perTaskUsd: 2.5, perSessionUsd: 20, haltAtPct: 80 },
  routing: {
    // Cheapest-first ladders. The engine escalates a task one rung per
    // failed round and records the rung it used, so the learning loop can
    // measure "escalate on repeat failure" against the traces.
    "default": { ladder: ["anthropic/claude-sonnet-4-5"] },
    "taskClass:bugfix-single-file": {
      ladder: ["anthropic/claude-sonnet-4-5", "anthropic/claude-opus-4-5"],
      topology: "small-focused",
    },
    "taskClass:refactor-multi-file": {
      ladder: ["google/gemini-3-flash", "anthropic/claude-sonnet-4-5"],
      topology: "distributed-coding",
    },
    "taskClass:proof": {
      ladder: ["google/gemini-3-flash", "google/gemini-3.1-pro"],
      topology: "long-proof",
    },
    "taskClass:auth-change": {
      ladder: ["anthropic/claude-sonnet-4-5"],
      requiredChecks: ["adversarial:privilege-escalation"],
    },
  },
  promptFragments: {},
};

export function resolveRoute(policy: Policy, taskClass: string | undefined): RouteRule {
  if (taskClass && policy.routing[taskClass]) return policy.routing[taskClass];
  return policy.routing["default"] ?? { ladder: [] };
}

/** Pick the ladder rung for a given attempt (0-based). Escalates, then holds. */
export function ladderRung(rule: RouteRule, attempt: number, fallbackModel?: string): string | undefined {
  if (rule.ladder.length === 0) return fallbackModel;
  const idx = Math.min(Math.max(attempt, 0), rule.ladder.length - 1);
  return rule.ladder[idx] ?? fallbackModel;
}

// ─── Pattern file resolution ─────────────────────────────────────────

/**
 * Where the pattern markdown lives once built:
 *   dist/cli/templates/patterns/*.md   (cpSync'd from src/cli/templates/patterns)
 * `import.meta.url` resolves to dist/policy.js or dist/cli/index.js depending
 * on the entry point, so we probe a couple of roots rather than guessing.
 */
export function patternsDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "cli", "templates", "patterns"), // dist/policy.js → dist/cli/templates/patterns
    join(here, "..", "cli", "templates", "patterns"), // dist/x/y.js
    join(here, "templates", "patterns"), // dist/cli/index.js → dist/cli/templates/patterns
    join(here, "..", "..", "src", "cli", "templates", "patterns"), // dev checkout
    join(here, "..", "src", "cli", "templates", "patterns"),
  ];
}

export function resolvePatternsDir(): string | null {
  for (const dir of patternsDirCandidates()) {
    if (existsSync(join(dir, "small-focused.md"))) return dir;
  }
  return null;
}

export interface TopologyResolution {
  ok: boolean;
  missing: string[];
  resolvedDir: string | null;
}

/** Every topology name must map to a real pattern file. Fails closed. */
export function assertTopologiesResolve(): TopologyResolution {
  const dir = resolvePatternsDir();
  if (!dir) {
    return { ok: false, missing: TOPOLOGIES.map((t) => t.file), resolvedDir: null };
  }
  const missing = TOPOLOGIES.filter((t) => !existsSync(join(dir, t.file))).map((t) => t.file);
  return { ok: missing.length === 0, missing, resolvedDir: dir };
}
