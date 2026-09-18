/**
 * The Teamwork run engine.
 *
 * This is the module that makes the repo's central claim true: the LLM
 * proposes a plan and does the work, but the *run* — dispatch order,
 * attempt accounting, budget enforcement, terminal states, the dead-letter
 * queue — is owned by code. The engine never talks to a model; agents call
 * these functions through the tools in `src/tools.ts`.
 *
 * Design notes:
 *   - Single writer per run directory. Transitions append to the event log
 *     (see `src/events.ts`); `state.json` is a derived snapshot.
 *   - Every function is pure with respect to the filesystem except the
 *     append, so the whole scheduler is unit-testable without a model,
 *     a network, or git.
 *   - Budget is enforced here, not in a prompt. `dispatchable()` returns
 *     nothing once the cap is hit, which is the only kind of budget control
 *     that survives a long run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent,
  deriveSession,
  readEvents,
  verifyChain,
  writeSnapshot,
  type DerivedSession,
  type RunEvent,
} from "./events.js";
import {
  DEFAULT_POLICY,
  getTopology,
  isTopology,
  ladderRung,
  resolveRoute,
  type Policy,
} from "./policy.js";

export type TaskStatus =
  | "PENDING"
  | "DISPATCHED"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "DEADLETTER";

export interface DagTask {
  taskId: string;
  title: string;
  description?: string;
  /** taskIds this task depends on. Must exist; cycles are rejected. */
  dependsOn?: string[];
  acceptanceCriteria?: string[];
  taskClass?: string;
  assignedModel?: string;
  maxRounds?: number;
  /** Set by the engine on dispatch. */
  worktreePath?: string;
}

export interface Plan {
  sessionId: string;
  topology: string;
  tasks: DagTask[];
  workingDirectory?: string;
  budgetUsd?: number;
  maxConcurrency?: number;
  haltAtPct?: number;
}

export interface VerificationCheck {
  name: string;
  type: "programmatic" | "adversarial" | "rubric";
  passed: boolean;
  /** For executed checks: the command, its exit code, its output hash. */
  cmd?: string;
  exitCode?: number;
  stdoutSha256?: string;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface VerificationReport {
  taskId: string;
  verifierAgent: string;
  verifierModel: string;
  timestamp: string;
  status: "PASS" | "FAIL";
  checks: VerificationCheck[];
  feedbackForWorker: string;
  fatalFindings?: Array<{
    where: string;
    why: string;
    fix?: string;
    reproduction?: string;
  }>;
}

export interface RoundInput {
  taskId: string;
  report: VerificationReport;
  costUsd?: number;
  tokens?: { input: number; output: number };
  wallClockSeconds?: number;
}

export interface RoundOutcome {
  accepted: boolean;
  taskId: string;
  status: TaskStatus;
  attempt: number;
  maxRounds: number;
  reason?: string;
  /** Included when the report was rejected as evidence-free. */
  rejection?: string;
  nextModel?: string;
}

export interface StatusSummary {
  sessionId: string;
  topology?: string;
  state: DerivedSession["state"];
  costUsd: number;
  budgetUsd: number;
  pctOfBudget: number;
  rounds: number;
  tasks: Array<{
    taskId: string;
    title: string;
    status: TaskStatus;
    attempts: number;
    dependsOn: string[];
    costUsd: number;
  }>;
  pending: string[];
  deadletter: string[];
  chain: { ok: boolean; length: number; tipHash: string; reason?: string };
}

// ─── Plan validation + scheduling ────────────────────────────────────

export interface PlanValidation {
  ok: boolean
  errors: string[];
}

export function validatePlan(plan: Plan): PlanValidation {
  const errors: string[] = [];
  if (!plan.sessionId) errors.push("sessionId is required");
  if (!isTopology(plan.topology)) {
    errors.push(
      `unknown topology "${plan.topology}" — expected one of ${["small-focused", "iterative-coding", "distributed-coding", "long-proof", "massive-proof-swarm", "document-review"].join(", ")}`,
    );
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push("plan must contain at least one task");
    return { ok: false, errors };
  }

  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!t.taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.taskId)) {
      errors.push(`invalid taskId "${t.taskId}" (use 1-64 chars of [A-Za-z0-9._-])`);
      continue;
    }
    if (ids.has(t.taskId)) errors.push(`duplicate taskId "${t.taskId}"`);
    ids.add(t.taskId);
  }
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push(`task "${t.taskId}" depends on unknown task "${dep}"`);
      if (dep === t.taskId) errors.push(`task "${t.taskId}" depends on itself`);
    }
  }
  const cycle = findCycle(plan.tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);

  return { ok: errors.length === 0, errors };
}

/** Depth-first cycle detection. Returns the cycle path, or null. */
export function findCycle(tasks: DagTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const state = color.get(id) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GREY) {
      const at = stack.indexOf(id);
      return [...stack.slice(at), id];
    }
    color.set(id, GREY);
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const t of tasks) {
    const found = visit(t.taskId);
    if (found) return found;
  }
  return null;
}

/**
 * Group tasks into dispatch waves. Wave N contains every task whose
 * dependencies are all in waves < N. Independent tasks land in the same
 * wave, which is what makes them parallel.
 */
export function dispatchWaves(plan: Plan): string[][] {
  const remaining = new Map(plan.tasks.map((t) => [t.taskId, new Set(t.dependsOn ?? [])]));
  const waves: string[][] = [];
  const placed = new Set<string>();

  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const [id, deps] of remaining) {
      let ready = true;
      for (const d of deps) {
        if (!placed.has(d)) ready = false;
      }
      if (ready) wave.push(id);
    }
    if (wave.length === 0) break; // cycle — validatePlan rejects these first
    for (const id of wave) {
      remaining.delete(id);
      placed.add(id);
    }
    waves.push(wave);
  }
  return waves;
}

// ─── Verification report validation (structure, not vibes) ───────────

/**
 * A PASS is a claim that something executed. This is the code-level
 * enforcement of the verifier's own rule ("run the actual command, don't
 * read code and judge"): a PASS backed only by rubric opinions, or by
 * programmatic checks with no recorded command/exit code, is rejected
 * outright and the round does not count as verified.
 */
export function validateReport(
  report: VerificationReport,
  requiredChecks: string[] = [],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!report.taskId) errors.push("report.taskId is required");
  if (report.status !== "PASS" && report.status !== "FAIL") {
    errors.push('report.status must be "PASS" or "FAIL"');
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    errors.push("report.checks must contain at least one check");
    return { ok: false, errors };
  }

  for (const check of report.checks) {
    if (!check.name) errors.push("every check needs a name");
    if (!["programmatic", "adversarial", "rubric"].includes(check.type)) {
      errors.push(`check "${check.name}" has invalid type "${check.type}"`);
    }
    const executed = check.type === "programmatic" || check.type === "adversarial";
    if (executed && (typeof check.exitCode !== "number" || !check.cmd)) {
      errors.push(
        `check "${check.name}" (${check.type}) must record cmd + exitCode — evidence-free checks cannot support a verdict`,
      );
    }
    if (check.type === "programmatic" && check.passed && check.exitCode !== 0) {
      errors.push(`check "${check.name}" passed but exitCode is ${check.exitCode}`);
    }
    if (check.type === "programmatic" && !check.passed && check.exitCode === 0) {
      errors.push(`check "${check.name}" failed but exitCode is 0`);
    }
  }

  if (report.status === "PASS") {
    const executed = report.checks.filter(
      (c) => (c.type === "programmatic" || c.type === "adversarial") && typeof c.exitCode === "number",
    );
    if (executed.length === 0) {
      errors.push(
        "a PASS requires at least one executed check with a recorded exit code — reading the diff and judging is not a verification",
      );
    }
    if (executed.some((c) => !c.passed)) {
      errors.push("a PASS cannot contain a failed executed check");
    }
    const names = new Set(report.checks.map((c) => c.name));
    for (const required of requiredChecks) {
      if (!names.has(required) && !report.checks.some((c) => c.type === required.split(":")[0])) {
        errors.push(`required check "${required}" is missing from the report`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ─── The engine ──────────────────────────────────────────────────────

export interface EngineOptions {
  runDir: string;
  sessionId: string;
  topology: string;
  tasks: DagTask[];
  policy?: Policy;
  budgetUsd?: number;
  maxConcurrency?: number;
  haltAtPct?: number;
  workingDirectory?: string;
  now?: () => string;
}

export class Engine {
  readonly runDir: string;
  readonly sessionId: string;
  readonly topology: string;
  readonly tasks: DagTask[];
  readonly policy: Policy;
  readonly budgetUsd: number;
  readonly maxConcurrency: number;
  readonly haltAtPct: number;
  readonly workingDirectory: string;
  private readonly now: () => string;

  private constructor(opts: EngineOptions) {
    this.runDir = opts.runDir;
    this.sessionId = opts.sessionId;
    this.topology = opts.topology;
    this.tasks = opts.tasks;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    const topo = getTopology(opts.topology);
    this.budgetUsd =
      opts.budgetUsd ?? this.policy.budget.perSessionUsd ?? topo?.defaultMaxCostUsd ?? 20;
    this.maxConcurrency = opts.maxConcurrency ?? topo?.defaultConcurrency ?? 2;
    this.haltAtPct = opts.haltAtPct ?? this.policy.budget.haltAtPct ?? 80;
    this.workingDirectory = opts.workingDirectory ?? process.cwd();
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Start a new run: validates the plan, then writes plan + first events. */
  static create(opts: EngineOptions): Engine {
    const engine = new Engine(opts);
    const validation = validatePlan({
      sessionId: engine.sessionId,
      topology: engine.topology,
      tasks: engine.tasks,
      budgetUsd: engine.budgetUsd,
      maxConcurrency: engine.maxConcurrency,
    });
    if (!validation.ok) {
      throw new Error(`invalid plan:\n  - ${validation.errors.join("\n  - ")}`);
    }
    mkdirSync(engine.runDir, { recursive: true });
    appendEvent(engine.runDir, {
      type: "session.start",
      sessionId: engine.sessionId,
      ts: engine.now(),
      data: {
        topology: engine.topology,
        budgetUsd: engine.budgetUsd,
        haltAtPct: engine.haltAtPct,
        maxConcurrency: engine.maxConcurrency,
        workingDirectory: engine.workingDirectory,
        policyVersion: engine.policy.version,
      },
    });
    appendEvent(engine.runDir, {
      type: "plan.written",
      sessionId: engine.sessionId,
      ts: engine.now(),
      data: {
        tasks: engine.tasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          dependsOn: t.dependsOn ?? [],
          taskClass: t.taskClass ?? null,
          assignedModel: t.assignedModel ?? null,
        })),
      },
    });
    writeFileSync(
      join(engine.runDir, "plan.dag.json"),
      `${JSON.stringify(
        {
          sessionId: engine.sessionId,
          topology: engine.topology,
          modelAllocation: { sentinel: undefined, defaultWorker: undefined, verifier: undefined },
          budget: { maxCostUsd: engine.budgetUsd, currentCostUsd: 0 },
          tasks: engine.tasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            ...(t.description !== undefined ? { description: t.description } : {}),
            ...(t.assignedModel !== undefined ? { assignedModel: t.assignedModel } : {}),
            dependencies: t.dependsOn ?? [],
            status: "PENDING" as const,
            acceptanceCriteria: t.acceptanceCriteria ?? [],
            artifacts: [],
          })),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    engine.snapshot();
    return engine;
  }

  /** Rehydrate from the event log. Throws if the log is missing/corrupt. */
  static resume(runDir: string, opts?: { policy?: Policy }): Engine {
    const events = readEvents(runDir);
    if (events.length === 0) throw new Error(`no events in ${runDir}`);
    const chain = verifyChain(events);
    if (!chain.ok) {
      throw new Error(`event log is corrupt at seq ${chain.brokenAt}: ${chain.reason}`);
    }
    const derived = deriveSession(events);
    const planPath = join(runDir, "plan.dag.json");
    let tasks: DagTask[] = [];
    if (existsSync(planPath)) {
      const plan = JSON.parse(readFileSync(planPath, "utf-8")) as {
        tasks?: Array<Record<string, unknown>>;
      };
      tasks = (plan.tasks ?? []).map((t) => ({
        taskId: String(t.taskId),
        title: String(t.title ?? t.taskId),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        dependsOn: Array.isArray(t.dependencies) ? (t.dependencies as string[]) : [],
        acceptanceCriteria: Array.isArray(t.acceptanceCriteria)
          ? (t.acceptanceCriteria as string[])
          : [],
        ...(typeof t.taskClass === "string" ? { taskClass: t.taskClass } : {}),
      }));
    }
    const startEvent = events.find((e) => e.type === "session.start");
    const startData = (startEvent?.data ?? {}) as Record<string, unknown>;
    return new Engine({
      runDir,
      sessionId: derived.sessionId,
      topology: derived.topology ?? String(startData.topology ?? "small-focused"),
      tasks,
      ...(opts?.policy ? { policy: opts.policy } : {}),
      budgetUsd: derived.budgetUsd,
      haltAtPct: derived.haltAtPct,
      ...(typeof startData.maxConcurrency === "number"
        ? { maxConcurrency: startData.maxConcurrency }
        : {}),
      ...(typeof startData.workingDirectory === "string"
        ? { workingDirectory: startData.workingDirectory }
        : {}),
    });
  }

  events(): RunEvent[] {
    return readEvents(this.runDir);
  }

  status(): StatusSummary {
    const events = this.events();
    const derived = deriveSession(events);
    const chain = verifyChain(events);
    const tasks = derived.order.map((id) => {
      const t = derived.tasks[id]!;
      return {
        taskId: t.taskId,
        title: t.title,
        status: t.status as TaskStatus,
        attempts: t.attempts,
        dependsOn: t.dependsOn,
        costUsd: Number(t.costUsd.toFixed(4)),
      };
    });
    return {
      sessionId: derived.sessionId,
      ...(derived.topology ? { topology: derived.topology } : {}),
      state: derived.state,
      costUsd: Number(derived.costUsd.toFixed(4)),
      budgetUsd: derived.budgetUsd,
      pctOfBudget: derived.budgetUsd > 0 ? (derived.costUsd / derived.budgetUsd) * 100 : 0,
      rounds: derived.rounds,
      tasks,
      pending: tasks.filter((t) => t.status === "PENDING").map((t) => t.taskId),
      deadletter: derived.deadletter,
      chain: {
        ok: chain.ok,
        length: chain.length,
        tipHash: chain.tipHash,
        ...(chain.reason ? { reason: chain.reason } : {}),
      },
    };
  }

  /** Persist the derived snapshot next to the log. */
  snapshot(): DerivedSession {
    const derived = deriveSession(this.events());
    writeSnapshot(this.runDir, derived);
    return derived;
  }

  /** True when the budget cap (not the warning threshold) is reached. */
  budgetExhausted(): boolean {
    const derived = deriveSession(this.events());
    return derived.budgetUsd > 0 && derived.costUsd >= derived.budgetUsd;
  }

  haltReason(): string | null {
    const derived = deriveSession(this.events());
    if (derived.budgetUsd > 0 && derived.costUsd >= derived.budgetUsd) {
      return `budget exhausted ($${derived.costUsd.toFixed(2)} of $${derived.budgetUsd.toFixed(2)})`;
    }
    const status = this.status();
    const open = status.tasks.filter(
      (t) => t.status !== "COMPLETED" && t.status !== "FAILED" && t.status !== "DEADLETTER",
    );
    const pending = status.pending.length;
    if (open.length === 0) return null;
    if (pending === 0 && open.every((t) => t.status === "DEADLETTER" || t.status === "FAILED")) {
      return "no dispatchable tasks remain";
    }
    return null;
  }

  /**
   * Tasks ready to run: every dependency COMPLETED, task not terminal,
   * within the concurrency cap, and under budget. This is the function the
   * sentinel asks instead of deciding for itself.
   */
  dispatchable(limit?: number): DagTask[] {
    const derived = deriveSession(this.events());
    if (derived.budgetUsd > 0 && derived.costUsd >= derived.budgetUsd) {
      appendEvent(this.runDir, {
        type: "budget.exhausted",
        sessionId: this.sessionId,
        ts: this.now(),
        data: { costUsd: derived.costUsd, budgetUsd: derived.budgetUsd },
      });
      return [];
    }

    const inFlight = Object.values(derived.tasks).filter(
      (t) => t.status === "DISPATCHED" || t.status === "VERIFYING",
    ).length;
    const capacity = Math.max(0, (limit ?? this.maxConcurrency) - inFlight);
    if (capacity === 0) return [];

    const ready = this.tasks.filter((t) => {
      const state = derived.tasks[t.taskId];
      if (!state) return (t.dependsOn ?? []).length === 0;
      if (state.status !== "PENDING") return false;
      return (t.dependsOn ?? []).every((d) => derived.tasks[d]?.status === "COMPLETED");
    });

    return ready.slice(0, capacity);
  }

  /** Model for this task's next attempt: cheapest rung first, escalate on failure. */
  modelFor(taskId: string, attempt: number): string | undefined {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) return undefined;
    const rule = resolveRoute(this.policy, task.taskClass);
    return ladderRung(rule, attempt, task.assignedModel);
  }

  requiredChecksFor(taskId: string): string[] {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) return [];
    return resolveRoute(this.policy, task.taskClass).requiredChecks ?? [];
  }

  /** Record that a task was handed to a worker. */
  dispatch(taskId: string, meta?: Record<string, unknown>): void {
    const task = this.tasks.find((t) => t.taskId === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    const attempt = deriveSession(this.events()).tasks[taskId]?.attempts ?? 0;
    appendEvent(this.runDir, {
      type: "task.dispatched",
      sessionId: this.sessionId,
      taskId,
      ts: this.now(),
      data: {
        attempt,
        model: meta?.model ?? this.modelFor(taskId, attempt) ?? null,
        worktreePath: task.worktreePath ?? null,
        ...meta,
      },
    });
    this.snapshot();
  }

  /**
   * Record a verifier round. This is where retries, dead-lettering, budget
   * warnings and terminal states are decided — all in code.
   */
  recordRound(input: RoundInput): RoundOutcome {
    const derived = deriveSession(this.events());
    const task = this.tasks.find((t) => t.taskId === input.taskId);
    if (!task) {
      return {
        accepted: false,
        taskId: input.taskId,
        status: "FAILED",
        attempt: 0,
        maxRounds: 0,
        rejection: `unknown task ${input.taskId}`,
      };
    }
    const maxRounds = task.maxRounds ?? getTopology(this.topology)?.defaultMaxRounds ?? 4;

    const validation = validateReport(input.report, this.requiredChecksFor(input.taskId));
    if (!validation.ok) {
      return {
        accepted: false,
        taskId: input.taskId,
        status: (derived.tasks[input.taskId]?.status ?? "PENDING") as TaskStatus,
        attempt: derived.tasks[input.taskId]?.attempts ?? 0,
        maxRounds,
        rejection: validation.errors.join("; "),
      };
    }

    const attempt = (derived.tasks[input.taskId]?.attempts ?? 0) + 1;
    appendEvent(this.runDir, {
      type: "verification.report",
      sessionId: this.sessionId,
      taskId: input.taskId,
      ts: this.now(),
      data: {
        attempt,
        status: input.report.status,
        report: {
          status: input.report.status,
          verifierAgent: input.report.verifierAgent,
          verifierModel: input.report.verifierModel,
          checks: input.report.checks.map((c) => ({
            name: c.name,
            type: c.type,
            passed: c.passed,
            cmd: c.cmd ?? null,
            exitCode: c.exitCode ?? null,
            stdoutSha256: c.stdoutSha256 ?? null,
          })),
          fatalFindings: input.report.fatalFindings ?? [],
        },
        costUsd: input.costUsd ?? 0,
        tokens: input.tokens ?? { input: 0, output: 0 },
        wallClockSeconds: input.wallClockSeconds ?? 0,
      },
    });

    let status: TaskStatus;
    let reason: string | undefined;
    if (input.report.status === "PASS") {
      status = "COMPLETED";
      appendEvent(this.runDir, {
        type: "task.completed",
        sessionId: this.sessionId,
        taskId: input.taskId,
        ts: this.now(),
        data: { attempt, costUsd: input.costUsd ?? 0 },
      });
    } else if (attempt >= maxRounds) {
      status = "DEADLETTER";
      reason = `maxRounds (${maxRounds}) exhausted`;
      appendEvent(this.runDir, {
        type: "task.deadletter",
        sessionId: this.sessionId,
        taskId: input.taskId,
        ts: this.now(),
        data: { attempt, maxRounds, reason },
      });
    } else {
      status = "PENDING";
      reason = `round ${attempt}/${maxRounds} failed — re-dispatch`;
      appendEvent(this.runDir, {
        type: "task.round",
        sessionId: this.sessionId,
        taskId: input.taskId,
        ts: this.now(),
        data: { attempt, maxRounds, pass: false, costUsd: input.costUsd ?? 0 },
      });
    }

    // Budget bookkeeping + terminal state.
    const after = deriveSession(this.events());
    const pct = after.budgetUsd > 0 ? (after.costUsd / after.budgetUsd) * 100 : 0;
    if (after.budgetUsd > 0 && pct >= this.haltAtPct && after.costUsd < after.budgetUsd) {
      appendEvent(this.runDir, {
        type: "budget.warning",
        sessionId: this.sessionId,
        ts: this.now(),
        data: { costUsd: after.costUsd, budgetUsd: after.budgetUsd, pct: Number(pct.toFixed(1)) },
      });
    }

    const allTerminal = after.order.every((id) => {
      const s = after.tasks[id]?.status;
      return s === "COMPLETED" || s === "FAILED" || s === "DEADLETTER";
    });
    if (allTerminal && after.order.length > 0) {
      appendEvent(this.runDir, {
        type: "session.done",
        sessionId: this.sessionId,
        ts: this.now(),
        data: {
          completed: after.order.filter((id) => after.tasks[id]?.status === "COMPLETED").length,
          deadletter: after.deadletter,
          costUsd: after.costUsd,
        },
      });
    }
    this.snapshot();

    return {
      accepted: true,
      taskId: input.taskId,
      status,
      attempt,
      maxRounds,
      ...(reason ? { reason } : {}),
      ...(status === "PENDING" ? { nextModel: this.modelFor(input.taskId, attempt) } : {}),
    };
  }

  /** Park every remaining dispatchable task (user stop, unrecoverable error). */
  abort(reason: string): void {
    const derived = deriveSession(this.events());
    for (const id of derived.order) {
      const t = derived.tasks[id];
      if (!t) continue;
      if (t.status === "PENDING" || t.status === "DISPATCHED" || t.status === "VERIFYING") {
        appendEvent(this.runDir, {
          type: "task.deadletter",
          sessionId: this.sessionId,
          taskId: id,
          ts: this.now(),
          data: { reason: `aborted: ${reason}` },
        });
      }
    }
    appendEvent(this.runDir, {
      type: "session.error",
      sessionId: this.sessionId,
      ts: this.now(),
      data: { reason },
    });
    this.snapshot();
  }
}
