/**
 * The Teamwork tool surface.
 *
 * These are the tools the sentinel/orchestrator agent calls instead of
 * "remembering" the run in its context. Everything a run needs — the event
 * log, the DAG, attempt accounting, the budget, the dead-letter queue — lives
 * behind them, so the run survives context compaction, model swaps and
 * restarts.
 *
 * Contract:
 *   teamwork_plan     — validate a plan, create the run, provision worktrees
 *   teamwork_dispatch — ask "what should run now?" (topological + budget-aware)
 *   teamwork_verify   — submit a verifier report; the engine decides the outcome
 *   teamwork_status   — derive the run state from the event log
 *   teamwork_resume   — rebuild a run after a restart
 *
 * Only ENGINE_ROLES may drive the engine; a worker calling `teamwork_dispatch`
 * gets an error string, not a task.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import {
  PlanDagSchema,
  SpecSchema,
  VerificationReportSchema,
  parseArtifact,
} from "./artifacts.js";
import { Engine, dispatchWaves, type DagTask, type VerificationReport } from "./engine.js";
import { verifyChain, readEvents, deriveSession, writeSnapshot } from "./events.js";
import { ENGINE_ROLES } from "./guard.js";
import { DEFAULT_POLICY, TOPOLOGY_NAMES, type Policy } from "./policy.js";
import { createWorktreeManager, runDirFor } from "./worktree.js";

// ─── Shared helpers ──────────────────────────────────────────────────

export function mintSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${rand}`;
}

export function loadPolicy(projectDir: string): Policy {
  const path = join(projectDir, ".teamwork", "policy.json");
  if (!existsSync(path)) return DEFAULT_POLICY;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<Policy>;
    return {
      ...DEFAULT_POLICY,
      ...raw,
      budget: { ...DEFAULT_POLICY.budget, ...(raw.budget ?? {}) },
      routing: { ...DEFAULT_POLICY.routing, ...(raw.routing ?? {}) },
      promptFragments: { ...DEFAULT_POLICY.promptFragments, ...(raw.promptFragments ?? {}) },
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

function openRun(projectDir: string, sessionId: string): Engine {
  return Engine.resume(runDirFor(projectDir, sessionId), { policy: loadPolicy(projectDir) });
}

function gate(context: ToolContext, toolName: string): string | null {
  if (ENGINE_ROLES.includes(context.agent)) return null;
  return (
    `teamwork: "${toolName}" may only be called by an orchestrating agent ` +
    `(${ENGINE_ROLES.join(", ")}). You are "${context.agent}". ` +
    `Do your task and return your result; the sentinel drives the run.`
  );
}

function statusLine(engine: Engine): string {
  const s = engine.status();
  const counts = s.tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(counts)
    .map(([k, v]) => `${v} ${k.toLowerCase()}`)
    .join(", ");
  return `state=${s.state} tasks: ${parts || "none"} | rounds=${s.rounds} | cost=$${s.costUsd.toFixed(2)}/$${s.budgetUsd.toFixed(2)} (${s.pctOfBudget.toFixed(0)}%) | log=${s.chain.length} events, chain ${s.chain.ok ? "ok" : "BROKEN"}`;
}

function nextActions(engine: Engine): string {
  const status = engine.status();
  const dispatchable = engine.dispatchable();
  const lines: string[] = [];
  if (status.deadletter.length > 0) {
    lines.push(`dead-lettered: ${status.deadletter.join(", ")} (report these to the user, do not retry)`);
  }
  if (engine.budgetExhausted()) {
    lines.push("BUDGET EXHAUSTED — stop dispatching, present partial results");
    return lines.join("\n");
  }
  if (dispatchable.length === 0 && status.pending.length > 0) {
    lines.push(`blocked: ${status.pending.join(", ")} waiting on dependencies or concurrency cap`);
  }
  if (dispatchable.length > 0) {
    lines.push(`next: ${dispatchable.map((t) => t.taskId).join(", ")}`);
  }
  if (status.tasks.every((t) => t.status === "COMPLETED" || t.status === "DEADLETTER" || t.status === "FAILED")) {
    lines.push("all tasks terminal — write final.md and present");
  }
  return lines.join("\n") || "nothing to do";
}

// ─── teamwork_plan ───────────────────────────────────────────────────

const taskArg = tool.schema.object({
  taskId: tool.schema.string().describe("stable id, [A-Za-z0-9._-]{1,64}"),
  title: tool.schema.string(),
  description: tool.schema.string().optional(),
  dependsOn: tool.schema.array(tool.schema.string()).optional(),
  acceptanceCriteria: tool.schema.array(tool.schema.string()).optional(),
  taskClass: tool.schema
    .string()
    .optional()
    .describe("policy key, e.g. taskClass:bugfix-single-file — selects the model ladder and required checks"),
  maxRounds: tool.schema.number().int().positive().optional(),
});

export const teamworkPlan: ToolDefinition = tool({
  description:
    "Start a Teamwork run: validate the task DAG, create the run directory, write plan.dag.json and per-task spec.json, provision one git worktree per worker, and report the dispatch waves. Call this ONCE, before any dispatch. The engine rejects cycles, unknown dependencies, and unknown topologies.",
  args: {
    topology: tool.schema.enum(TOPOLOGY_NAMES as unknown as [string, ...string[]]),
    tasks: tool.schema.array(taskArg).min(1),
    sessionId: tool.schema.string().optional().describe("reuse an id to resume; omit to mint one"),
    budgetUsd: tool.schema.number().positive().optional(),
    maxConcurrency: tool.schema.number().int().positive().optional(),
    worktrees: tool.schema.boolean().optional().describe("default true in a git repo"),
  },
  async execute(args, context) {
    const denied = gate(context, "teamwork_plan");
    if (denied) return denied;

    const sessionId = args.sessionId ?? mintSessionId();
    const runDir = runDirFor(context.directory, sessionId);
    const policy = loadPolicy(context.directory);

    const tasks: DagTask[] = args.tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.dependsOn !== undefined ? { dependsOn: t.dependsOn } : {}),
      ...(t.acceptanceCriteria !== undefined ? { acceptanceCriteria: t.acceptanceCriteria } : {}),
      ...(t.taskClass !== undefined ? { taskClass: t.taskClass } : {}),
      ...(t.maxRounds !== undefined ? { maxRounds: t.maxRounds } : {}),
    }));

    let engine: Engine;
    try {
      engine = Engine.create({
        runDir,
        sessionId,
        topology: args.topology,
        tasks,
        policy,
        ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}),
        ...(args.maxConcurrency !== undefined ? { maxConcurrency: args.maxConcurrency } : {}),
        workingDirectory: context.directory,
      });
    } catch (err) {
      return `plan rejected — ${(err as Error).message}`;
    }

    // Plan artifact is schema-validated on the way out, so a downstream
    // reader can trust it (this replaces "the model wrote some JSON").
    const planDag = {
      sessionId,
      topology: args.topology,
      modelAllocation: {},
      budget: { maxCostUsd: engine.budgetUsd, currentCostUsd: 0 },
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.taskClass !== undefined ? { taskClass: t.taskClass } : {}),
        ...(t.maxRounds !== undefined ? { maxRounds: t.maxRounds } : {}),
        dependencies: t.dependsOn ?? [],
        status: "PENDING" as const,
        acceptanceCriteria: t.acceptanceCriteria ?? [],
        artifacts: [],
      })),
    };
    const parsedPlan = parseArtifact(PlanDagSchema, planDag, "plan.dag.json");
    if (!parsedPlan.ok) return `plan artifact is invalid — ${parsedPlan.error}`;

    // Worktrees: one per task, plus the sentinel's.
    const wm = createWorktreeManager();
    const worktreeNotes: string[] = [];
    const wantWorktrees = args.worktrees ?? true;
    if (wantWorktrees && wm.isGitRepo({ cwd: context.directory })) {
      const sentinel = wm.initSession(sessionId, { cwd: context.directory });
      worktreeNotes.push(`sentinel: ${sentinel.path}`);
      for (const task of tasks) {
        const name = `builder-${task.taskId}`.slice(0, 32);
        try {
          const info = wm.addAgent(name, sessionId, { cwd: context.directory });
          task.worktreePath = info.path;
          worktreeNotes.push(`${task.taskId}: ${info.path} (branch ${info.branch})`);
        } catch (err) {
          worktreeNotes.push(`${task.taskId}: worktree failed — ${(err as Error).message}`);
        }
      }
    } else {
      worktreeNotes.push("skipped (not a git repo, or worktrees: false)");
    }

    // Scoped specs, one per task, schema-validated.
    const specErrors: string[] = [];
    for (const task of tasks) {
      const spec = {
        taskId: task.taskId,
        sessionId,
        title: task.title,
        description: task.description ?? "",
        requirements: task.acceptanceCriteria ?? [],
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        verification: { programmatic: [], adversarial: [], rubric: [] },
        localChecks: [],
        dependencies: task.dependsOn ?? [],
        pitfalls: [],
        ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
        budget: { maxRounds: task.maxRounds ?? 4, maxCostUsd: policy.budget.perTaskUsd },
      };
      const parsed = parseArtifact(SpecSchema, spec, `spec-${task.taskId}.json`);
      if (!parsed.ok) {
        specErrors.push(parsed.error);
        continue;
      }
      writeFileSync(
        join(runDir, `spec-${task.taskId}.json`),
        `${JSON.stringify(parsed.value, null, 2)}\n`,
        "utf-8",
      );
    }
    if (specErrors.length > 0) {
      engine.abort(`spec validation failed: ${specErrors.join("; ")}`);
      return `run aborted — ${specErrors.join("; ")}`;
    }

    const waves = dispatchWaves({
      sessionId,
      topology: args.topology,
      tasks,
    });

    return [
      `run created: ${sessionId}`,
      `run dir: ${runDir}`,
      `topology: ${args.topology} | concurrency cap: ${engine.maxConcurrency} | budget: $${engine.budgetUsd.toFixed(2)} (halt at ${engine.haltAtPct}%)`,
      `waves: ${waves.map((w, i) => `[${i + 1}] ${w.join(" + ")}`).join("  ")}`,
      worktreeNotes.length > 0 ? `worktrees:\n  ${worktreeNotes.join("\n  ")}` : "",
      `specs written: ${tasks.map((t) => `spec-${t.taskId}.json`).join(", ")}`,
      "",
      statusLine(engine),
      "",
      "Next: call teamwork_dispatch to get the first wave.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  },
});

// ─── teamwork_dispatch ───────────────────────────────────────────────

export const teamworkDispatch: ToolDefinition = tool({
  description:
    "Ask the engine which tasks run now. Returns ONLY tasks whose dependencies are COMPLETED, that are under the concurrency cap, and that the budget still allows — with the model to use, the spec path and the worktree. Then spawn one worker subagent per returned task. Call this repeatedly; do not decide order yourself.",
  args: {
    sessionId: tool.schema.string(),
    taskId: tool.schema.string().optional().describe("dispatch a specific task instead of the next wave"),
    limit: tool.schema.number().int().positive().optional(),
  },
  async execute(args, context) {
    const denied = gate(context, "teamwork_dispatch");
    if (denied) return denied;

    let engine: Engine;
    try {
      engine = openRun(context.directory, args.sessionId);
    } catch (err) {
      return `cannot open run ${args.sessionId} — ${(err as Error).message}`;
    }
    if (engine.budgetExhausted()) {
      return `BUDGET EXHAUSTED — stop. ${statusLine(engine)}`;
    }

    const ready = args.taskId
      ? engine.dispatchable(engine.maxConcurrency).filter((t) => t.taskId === args.taskId)
      : engine.dispatchable(args.limit);
    if (ready.length === 0) {
      const single = args.taskId
        ? engine.dispatchable(engine.maxConcurrency).some((t) => t.taskId === args.taskId)
        : false;
      if (args.taskId && !single) {
        return `${args.taskId} is not dispatchable — its dependencies are unfinished, it is already terminal, or the cap is full.\n${statusLine(engine)}\n${nextActions(engine)}`;
      }
      return `nothing dispatchable right now.\n${statusLine(engine)}\n${nextActions(engine)}`;
    }

    const runDir = runDirFor(context.directory, args.sessionId);
    const lines: string[] = [];
    for (const task of ready) {
      const attempt = deriveSession(readEvents(runDir)).tasks[task.taskId]?.attempts ?? 0;
      const model = engine.modelFor(task.taskId, attempt);
      const checks = engine.requiredChecksFor(task.taskId);
      engine.dispatch(task.taskId, { model: model ?? null });
      lines.push(
        [
          `task ${task.taskId} (attempt ${attempt + 1})`,
          task.title ? `  title: ${task.title}` : "",
          `  spec: ${join(runDir, `spec-${task.taskId}.json`)}`,
          task.worktreePath ? `  worktree: ${task.worktreePath}` : "",
          model ? `  model: ${model}` : "",
          checks.length > 0 ? `  required checks for PASS: ${checks.join(", ")}` : "",
        ]
          .filter((l) => l !== "")
          .join("\n"),
      );
    }

    return [
      `dispatching ${ready.length} task(s):`,
      ...lines,
      "",
      "For each: spawn a team/worker subagent with the spec path and worktree. When it returns,",
      "spawn team/verifier against the same worktree + patch, then call teamwork_verify with the report.",
      "",
      statusLine(engine),
    ].join("\n");
  },
});

// ─── teamwork_verify ─────────────────────────────────────────────────

const checkArg = tool.schema.object({
  name: tool.schema.string(),
  type: tool.schema.enum(["programmatic", "adversarial", "rubric"]),
  passed: tool.schema.boolean(),
  cmd: tool.schema.string().optional().describe("the command that was executed"),
  exitCode: tool.schema.number().int().optional().describe("its exit code (required for programmatic/adversarial)"),
  stdoutSha256: tool.schema.string().optional().describe("sha256 of the captured stdout"),
  durationMs: tool.schema.number().optional(),
  output: tool.schema.string().optional(),
  error: tool.schema.string().optional(),
});

export const teamworkVerify: ToolDefinition = tool({
  description:
    "Submit a verifier report for a task. The engine validates it (a PASS must contain at least one executed check with a recorded exit code), then decides: COMPLETED, re-dispatch with feedback, or dead-letter after maxRounds. Returns what to do next.",
  args: {
    sessionId: tool.schema.string(),
    taskId: tool.schema.string(),
    reportPath: tool.schema
      .string()
      .optional()
      .describe("path to verification_report.json written by the verifier (preferred)"),
    status: tool.schema.enum(["PASS", "FAIL"]).optional().describe("required if reportPath is omitted"),
    verifierAgent: tool.schema.string().optional(),
    verifierModel: tool.schema.string().optional(),
    checks: tool.schema.array(checkArg).optional(),
    feedbackForWorker: tool.schema.string().optional(),
    fatalFindings: tool.schema
      .array(
        tool.schema.object({
          where: tool.schema.string(),
          why: tool.schema.string(),
          fix: tool.schema.string().optional(),
          reproduction: tool.schema.string().optional(),
        }),
      )
      .optional(),
    costUsd: tool.schema.number().nonnegative().optional(),
  },
  async execute(args, context) {
    const denied = gate(context, "teamwork_verify");
    if (denied) return denied;

    let engine: Engine;
    try {
      engine = openRun(context.directory, args.sessionId);
    } catch (err) {
      return `cannot open run ${args.sessionId} — ${(err as Error).message}`;
    }

    let raw: unknown;
    if (args.reportPath) {
      if (!existsSync(args.reportPath)) {
        return `no report at ${args.reportPath} — the verifier must write it before you submit`;
      }
      try {
        raw = JSON.parse(readFileSync(args.reportPath, "utf-8"));
      } catch (err) {
        return `report at ${args.reportPath} is not valid JSON — ${(err as Error).message}`;
      }
    } else {
      raw = {
        taskId: args.taskId,
        verifierAgent: args.verifierAgent ?? "team/verifier",
        verifierModel: args.verifierModel ?? "unknown",
        timestamp: new Date().toISOString(),
        status: args.status,
        checks: args.checks ?? [],
        feedbackForWorker: args.feedbackForWorker ?? "",
        fatalFindings: args.fatalFindings ?? [],
      };
    }

    const parsed = parseArtifact(VerificationReportSchema, raw, "verification_report.json");
    if (!parsed.ok) return `report rejected — ${parsed.error}`;

    const outcome = engine.recordRound({
      taskId: args.taskId,
      report: parsed.value as VerificationReport,
      ...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
    });

    if (!outcome.accepted) {
      return [
        `report REJECTED for ${args.taskId} (round not counted):`,
        `  ${outcome.rejection}`,
        "",
        "Fix the evidence and resubmit. A PASS needs at least one executed check with cmd + exitCode.",
      ].join("\n");
    }

    const head =
      outcome.status === "COMPLETED"
        ? `task ${args.taskId} COMPLETED (round ${outcome.attempt}/${outcome.maxRounds})`
        : outcome.status === "DEADLETTER"
          ? `task ${args.taskId} DEAD-LETTERED after ${outcome.attempt}/${outcome.maxRounds} rounds — ${outcome.reason}`
          : `task ${args.taskId} FAILED round ${outcome.attempt}/${outcome.maxRounds}`;

    return [
      head,
      outcome.nextModel ? `  next attempt escalates to: ${outcome.nextModel}` : "",
      outcome.status === "PENDING" ? `  feed the verifier's feedback back to a fresh worker` : "",
      "",
      statusLine(engine),
      nextActions(engine),
    ]
      .filter((l) => l !== "")
      .join("\n");
  },
});

// ─── teamwork_status / teamwork_resume ───────────────────────────────

export const teamworkStatus: ToolDefinition = tool({
  description:
    "Derive the run state from the append-only event log: per-task status, attempts, cost against budget, dead-letter queue, and whether the hash chain is intact. Use this instead of remembering state in context.",
  args: {
    sessionId: tool.schema.string(),
  },
  async execute(args, context) {
    const runDir = runDirFor(context.directory, args.sessionId);
    if (!existsSync(runDir)) return `no run at ${runDir}`;
    let engine: Engine;
    try {
      engine = openRun(context.directory, args.sessionId);
    } catch (err) {
      return `run ${args.sessionId} could not be replayed — ${(err as Error).message}`;
    }
    const s = engine.status();
    const rows = s.tasks.map(
      (t) =>
        `  ${t.taskId.padEnd(24)} ${t.status.padEnd(11)} attempts=${t.attempts} dep=[${t.dependsOn.join(",")}] $${t.costUsd.toFixed(3)}`,
    );
    return [
      statusLine(engine),
      `session: ${s.sessionId} | topology: ${s.topology ?? "?"} | chain ${s.chain.ok ? "verified" : `BROKEN (${s.chain.reason})`}`,
      ...rows,
      "",
      nextActions(engine),
    ].join("\n");
  },
});

export const teamworkResume: ToolDefinition = tool({
  description:
    "Rebuild a run from its event log after a restart, compaction or crash. Verifies the hash chain first (a tampered log is refused), rewrites the derived state.json, and reports exactly where the run stopped and what to do next.",
  args: {
    sessionId: tool.schema.string(),
    list: tool.schema.boolean().optional().describe("list every run in this project instead"),
  },
  async execute(args, context) {
    if (args.list) {
      const base = join(context.directory, ".opencode", "teamwork");
      if (!existsSync(base)) return "no runs in this project";
      const { readdirSync } = await import("node:fs");
      const ids = readdirSync(base).filter((name) => existsSync(join(base, name, "events.jsonl")));
      return ids.length === 0 ? "no runs in this project" : `runs:\n${ids.map((i) => `  ${i}`).join("\n")}`;
    }
    const runDir = runDirFor(context.directory, args.sessionId);
    if (!existsSync(runDir)) return `no run at ${runDir}`;
    const events = readEvents(runDir);
    if (events.length === 0) return `run ${args.sessionId} has no events`;

    const chain = verifyChain(events);
    if (!chain.ok) {
      return `REFUSING to resume ${args.sessionId}: event log is corrupt at seq ${chain.brokenAt} (${chain.reason}). Investigate before continuing — the log is the only record of what ran.`;
    }
    const derived = deriveSession(events);
    writeSnapshot(runDir, derived);
    const engine = openRun(context.directory, args.sessionId);
    const last = events[events.length - 1]!;
    return [
      `resumed ${args.sessionId} from ${events.length} events (chain verified)`,
      `last event: ${last.type}${last.taskId ? ` (${last.taskId})` : ""} at ${last.ts}`,
      "",
      statusLine(engine),
      nextActions(engine),
    ].join("\n");
  },
});

export const TEAMWORK_TOOLS: Record<string, ToolDefinition> = {
  teamwork_plan: teamworkPlan,
  teamwork_dispatch: teamworkDispatch,
  teamwork_verify: teamworkVerify,
  teamwork_status: teamworkStatus,
  teamwork_resume: teamworkResume,
};

/** Ensure the run directory exists before tools are used. */
export function ensureRunDir(projectDir: string, sessionId: string): string {
  const dir = runDirFor(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
