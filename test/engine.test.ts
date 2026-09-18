/**
 * Engine, event-log and config-injection tests.
 *
 * These run without a model, a network, or git: the whole point of moving the
 * run loop into code is that the scheduler becomes testable. `bun test`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Engine,
  dispatchWaves,
  findCycle,
  validatePlan,
  validateReport,
  type DagTask,
} from "../src/engine.js";
import {
  appendEvent,
  deriveSession,
  readEvents,
  verifyChain,
} from "../src/events.js";
import { agentConfigFor, AGENT_TEMPLATES, getAllCommands } from "../src/templates.js";
import { TOPOLOGIES, assertTopologiesResolve, getTopology, isTopology } from "../src/policy.js";
import { RoleRegistry, isWriteTool } from "../src/guard.js";
import { assertAgentName, assertSessionId } from "../src/worktree.js";
import { parseCommandFlags } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "teamwork-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const runDir = (id = "s1") => join(root, ".opencode", "teamwork", id);

function tasks(...specs: Array<[string, string[]]>): DagTask[] {
  return specs.map(([id, deps]) => ({ taskId: id, title: `task ${id}`, dependsOn: deps }));
}

function passReport(taskId: string) {
  return {
    taskId,
    verifierAgent: "team/verifier",
    verifierModel: "test/model",
    timestamp: new Date().toISOString(),
    status: "PASS" as const,
    checks: [
      {
        name: "unit",
        type: "programmatic" as const,
        passed: true,
        cmd: "bun test",
        exitCode: 0,
        stdoutSha256: "0".repeat(64),
      },
    ],
    feedbackForWorker: "",
    fatalFindings: [],
  };
}

function failReport(taskId: string) {
  return {
    ...passReport(taskId),
    status: "FAIL" as const,
    checks: [
      {
        name: "unit",
        type: "programmatic" as const,
        passed: false,
        cmd: "bun test",
        exitCode: 1,
        output: "AssertionError: expected 5, got 4",
      },
    ],
    feedbackForWorker: "off-by-one in the loop bound",
  };
}

// ─── Scheduling ──────────────────────────────────────────────────────

describe("plan validation and scheduling", () => {
  test("groups independent tasks into the same wave", () => {
    const plan = {
      sessionId: "s1",
      topology: "distributed-coding",
      tasks: tasks(["T1", []], ["T2", ["T1"]], ["T3", []], ["T4", ["T2", "T3"]]),
    };
    expect(dispatchWaves(plan)).toEqual([["T1", "T3"], ["T2"], ["T4"]]);
  });

  test("rejects cycles, unknown deps, duplicates and bad topologies", () => {
    const cycle = {
      sessionId: "s1",
      topology: "small-focused",
      tasks: tasks(["A", ["B"]], ["B", ["A"]]),
    };
    expect(findCycle(cycle.tasks)).toEqual(["A", "B", "A"]);
    const v = validatePlan(cycle);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("cycle");

    const bad = validatePlan({
      sessionId: "s1",
      topology: "proof", // the old, non-existent name
      tasks: tasks(["A", ["ghost"]], ["A", []]),
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toContain("unknown topology");
    expect(bad.errors.join(" ")).toContain("unknown task");
    expect(bad.errors.join(" ")).toContain("duplicate");
  });

  test("every topology name maps to a pattern file on disk", () => {
    const check = assertTopologiesResolve();
    expect(check.resolvedDir).not.toBeNull();
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
    for (const t of TOPOLOGIES) {
      expect(isTopology(t.name)).toBe(true);
      expect(getTopology(t.name)?.file).toBe(t.file);
    }
  });
});

// ─── Engine ──────────────────────────────────────────────────────────

describe("engine", () => {
  test("dispatches in topological order and honours the concurrency cap", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "distributed-coding",
      tasks: tasks(["T1", []], ["T2", ["T1"]], ["T3", []]),
      maxConcurrency: 2,
      now: () => "2026-09-19T00:00:00.000Z",
    });

    const first = engine.dispatchable();
    expect(first.map((t) => t.taskId)).toEqual(["T1", "T3"]); // cap of 2, T2 blocked
    for (const t of first) engine.dispatch(t.taskId);

    // Both in flight -> no capacity.
    expect(engine.dispatchable()).toEqual([]);

    engine.recordRound({ taskId: "T1", report: passReport("T1") });
    engine.recordRound({ taskId: "T3", report: passReport("T3") });

    const second = engine.dispatchable();
    expect(second.map((t) => t.taskId)).toEqual(["T2"]); // dependency now met
  });

  test("retries on FAIL, then dead-letters after maxRounds", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "small-focused",
      tasks: [{ taskId: "T1", title: "flaky", dependsOn: [], maxRounds: 3 }],
    });

    const r1 = engine.recordRound({ taskId: "T1", report: failReport("T1") });
    expect(r1.accepted).toBe(true);
    expect(r1.status).toBe("PENDING");
    expect(r1.attempt).toBe(1);
    expect(r1.nextModel).toBeDefined();

    const r2 = engine.recordRound({ taskId: "T1", report: failReport("T1") });
    expect(r2.status).toBe("PENDING");
    expect(r2.attempt).toBe(2);

    const r3 = engine.recordRound({ taskId: "T1", report: failReport("T1") });
    expect(r3.status).toBe("DEADLETTER");
    expect(r3.reason).toContain("maxRounds");

    const status = engine.status();
    expect(status.deadletter).toEqual(["T1"]);
    expect(status.tasks[0]?.attempts).toBe(3);
  });

  test("escalates the model per failed round via the ladder", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "distributed-coding",
      tasks: [
        { taskId: "T1", title: "x", dependsOn: [], taskClass: "taskClass:bugfix-single-file" },
      ],
    });
    expect(engine.modelFor("T1", 0)).toBe("anthropic/claude-sonnet-4-5");
    expect(engine.modelFor("T1", 1)).toBe("anthropic/claude-opus-4-5");
    expect(engine.modelFor("T1", 9)).toBe("anthropic/claude-opus-4-5"); // holds at the top rung
  });

  test("stops dispatching when the budget is exhausted, in code", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "distributed-coding",
      tasks: tasks(["T1", []], ["T2", []]),
      budgetUsd: 1,
    });
    expect(engine.dispatchable().length).toBeGreaterThan(0);

    engine.recordRound({ taskId: "T1", report: passReport("T1"), costUsd: 1.5 });
    expect(engine.budgetExhausted()).toBe(true);
    expect(engine.dispatchable()).toEqual([]);

    const types = engine.events().map((e) => e.type);
    expect(types).toContain("budget.exhausted");
  });

  test("marks the session done when every task is terminal", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "small-focused",
      tasks: tasks(["T1", []], ["T2", ["T1"]]),
    });
    engine.recordRound({ taskId: "T1", report: passReport("T1") });
    engine.recordRound({ taskId: "T2", report: passReport("T2") });
    expect(engine.status().state).toBe("DONE");
  });
});

// ─── The PASS must be evidence ───────────────────────────────────────

describe("verification report validation", () => {
  test("refuses a PASS with no executed check", () => {
    const report = {
      ...passReport("T1"),
      checks: [
        { name: "looks right", type: "rubric" as const, passed: true, output: "seems fine" },
      ],
    };
    const v = validateReport(report);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("at least one executed check");
  });

  test("refuses a PASS whose executed check has no exit code", () => {
    const report = {
      ...passReport("T1"),
      checks: [{ name: "unit", type: "programmatic" as const, passed: true }],
    };
    const v = validateReport(report);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("must record cmd + exitCode");
  });

  test("refuses a PASS containing a failed executed check", () => {
    const report = {
      ...passReport("T1"),
      checks: [
        ...passReport("T1").checks,
        { name: "adversarial", type: "adversarial" as const, passed: false, cmd: "fuzz", exitCode: 1 },
      ],
    };
    expect(validateReport(report).ok).toBe(false);
  });

  test("requires the policy's mandatory checks for the task class", () => {
    const v = validateReport(passReport("T1"), ["adversarial:privilege-escalation"]);
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toContain("required check");
  });

  test("a rejected report does not count as a round", () => {
    const engine = Engine.create({
      runDir: runDir(),
      sessionId: "s1",
      topology: "small-focused",
      tasks: tasks(["T1", []]),
    });
    const bad = {
      ...passReport("T1"),
      checks: [{ name: "vibes", type: "rubric" as const, passed: true }],
    };
    const outcome = engine.recordRound({ taskId: "T1", report: bad as never });
    expect(outcome.accepted).toBe(false);
    expect(outcome.rejection).toContain("executed check");
    expect(engine.status().tasks[0]?.attempts).toBe(0);
  });
});

// ─── Event log ───────────────────────────────────────────────────────

describe("event log", () => {
  test("chains events and detects tampering", () => {
    const dir = runDir();
    appendEvent(dir, { type: "session.start", sessionId: "s1" });
    appendEvent(dir, { type: "plan.written", sessionId: "s1" });
    appendEvent(dir, { type: "task.completed", sessionId: "s1", taskId: "T1" });

    const events = readEvents(dir);
    expect(events.length).toBe(3);
    expect(verifyChain(events).ok).toBe(true);
    expect(events[2]?.prevHash).toBe(events[1]?.hash);

    // Rewrite history: flip a task id and keep the old hash.
    const lines = readFileSync(join(dir, "events.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const altered = JSON.parse(lines[2]!);
    altered.taskId = "T9";
    lines[2] = JSON.stringify(altered);
    writeFileSync(join(dir, "events.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    const check = verifyChain(readEvents(dir));
    expect(check.ok).toBe(false);
    expect(check.brokenAt).toBe(3);
  });

  test("replays a run: resume rebuilds state after a restart", () => {
    const dir = runDir();
    const first = Engine.create({
      runDir: dir,
      sessionId: "s1",
      topology: "small-focused",
      tasks: tasks(["T1", []], ["T2", ["T1"]]),
    });
    first.recordRound({ taskId: "T1", report: passReport("T1"), costUsd: 0.25 });

    const resumed = Engine.resume(dir);
    const status = resumed.status();
    expect(status.tasks.find((t) => t.taskId === "T1")?.status).toBe("COMPLETED");
    expect(status.tasks.find((t) => t.taskId === "T2")?.status).toBe("PENDING");
    expect(status.costUsd).toBeCloseTo(0.25, 5);
    expect(resumed.dispatchable().map((t) => t.taskId)).toEqual(["T2"]);
  });

  test("deriveSession sums cost and rounds from events only", () => {
    const dir = runDir();
    const engine = Engine.create({
      runDir: dir,
      sessionId: "s1",
      topology: "small-focused",
      tasks: tasks(["T1", []]),
    });
    engine.recordRound({ taskId: "T1", report: failReport("T1"), costUsd: 0.1 });
    engine.recordRound({ taskId: "T1", report: passReport("T1"), costUsd: 0.2 });
    const derived = deriveSession(readEvents(dir));
    expect(derived.rounds).toBe(2);
    expect(derived.costUsd).toBeCloseTo(0.3, 5);
    expect(derived.tasks["T1"]?.status).toBe("COMPLETED");
  });
});

// ─── Config injection (the P0 regression) ────────────────────────────

describe("agent config injection", () => {
  test("injects real config keys instead of frontmatter-in-a-prompt", () => {
    const verifier = AGENT_TEMPLATES.find((a) => a.name === "verifier");
    expect(verifier).toBeDefined();
    const config = agentConfigFor(verifier!);

    expect(config.mode).toBe("subagent");
    expect(config.permission.edit).toBe("deny"); // enforced, not narrated
    expect(config.permission.task).toBe("deny"); // no runaway fan-out
    expect(config.temperature).toBe(0);
    // The prompt must NOT contain the YAML frontmatter any more.
    expect(config.prompt.startsWith("---")).toBe(false);
    expect(config.prompt).not.toContain("permission:");
    expect(config.description?.length ?? 0).toBeGreaterThan(10);
  });

  test("preserves a model the user already configured (installer regression)", () => {
    const sentinel = AGENT_TEMPLATES.find((a) => a.name === "sentinel")!;
    const config = agentConfigFor(sentinel, { model: "anthropic/claude-opus-4-5" });
    expect(config.model).toBe("anthropic/claude-opus-4-5"); // not clobbered by the template default
  });

  test("every team agent declares an explicit mode and permission block", () => {
    for (const agent of AGENT_TEMPLATES) {
      const config = agentConfigFor(agent);
      expect(["primary", "subagent", "all"]).toContain(config.mode);
      expect(["allow", "deny", "ask"]).toContain(config.permission.edit);
      expect(config.prompt.length).toBeGreaterThan(200);
    }
  });

  test("commands carry no template language OpenCode cannot expand", () => {
    for (const cmd of getAllCommands()) {
      expect(cmd.template).not.toContain("{{");
      expect(cmd.agent.startsWith("team/")).toBe(true);
    }
    const teamwork = getAllCommands().find((c) => c.name === "teamwork")!;
    const occurrences = teamwork.template.split("$ARGUMENTS").length - 1;
    expect(occurrences).toBe(1); // was duplicated in the old template
  });
});

// ─── Runtime guard ───────────────────────────────────────────────────

describe("role guard", () => {
  test("blocks write tools for read-only roles and allows workers", () => {
    const roles = new RoleRegistry();
    roles.remember("sess-verifier", "team/verifier");
    roles.remember("sess-worker", "team/worker");
    roles.remember("sess-build", "build");

    expect(roles.blockReason("sess-verifier", "edit")).toContain("read-only");
    expect(roles.blockReason("sess-verifier", "write")).toContain("read-only");
    expect(roles.blockReason("sess-verifier", "bash")).toBeNull(); // the verifier must run tests
    expect(roles.blockReason("sess-worker", "edit")).toBeNull();
    expect(roles.blockReason("sess-build", "edit")).toBeNull(); // users' own agents untouched
    expect(isWriteTool("apply_patch")).toBe(true);
  });

  test("a user override of the permission block is respected", () => {
    const roles = new RoleRegistry();
    roles.remember("s", "team/verifier");
    roles.setPermissions("team/verifier", {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      task: "allow",
    });
    expect(roles.blockReason("s", "edit")).toBeNull();
  });
});

// ─── Worktree safety ─────────────────────────────────────────────────

describe("worktree safety", () => {
  test("rejects agent names that could escape the run directory", () => {
    expect(() => assertAgentName("builder-T1")).not.toThrow();
    expect(() => assertAgentName("../../etc/passwd")).toThrow();
    expect(() => assertAgentName("a; rm -rf /")).toThrow();
    expect(() => assertAgentName("$(whoami)")).toThrow();
    expect(() => assertSessionId("2026-09-19T00-00-00-abc123")).not.toThrow();
    expect(() => assertSessionId("../../x")).toThrow();
  });
});

// ─── Command flag parsing ────────────────────────────────────────────

describe("command flags", () => {
  const mint = () => "minted-id";

  test("parses --topology, --budget and --concurrency in code", () => {
    const f = parseCommandFlags(
      '--topology long-proof --budget 42 --concurrency=3 "prove Knuth cycles"',
      mint,
    );
    expect(f.topology).toBe("long-proof");
    expect(f.budgetUsd).toBe(42);
    expect(f.maxConcurrency).toBe(3);
    expect(f.request).toBe('"prove Knuth cycles"');
    expect(f.warnings).toEqual([]);
  });

  test("mints a session id and warns about an unknown topology", () => {
    const f = parseCommandFlags("--topology proof fix the bug", mint);
    expect(f.sessionId).toBe("minted-id");
    expect(f.topology).toBeUndefined();
    expect(f.warnings[0]).toContain("unknown --topology");
    expect(f.request).toBe("fix the bug");
  });

  test("rejects non-numeric budgets", () => {
    const f = parseCommandFlags("--budget lots fix it", mint);
    expect(f.budgetUsd).toBeUndefined();
    expect(f.warnings.join(" ")).toContain("--budget");
  });
});
