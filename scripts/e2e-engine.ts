/**
 * End-to-end run of the engine against a REAL git repository.
 *
 * Unit tests prove the scheduler's logic; this proves the whole loop works on
 * this machine: real worktrees, real branch creation, real evidence capture
 * from a real command, a real event log, budget enforcement, retry, dead
 * letter, and cleanup. No models are involved — a scripted "worker" writes a
 * file and a scripted "verifier" runs the repo's check command and records its
 * exit code, which is exactly the shape an agent-driven run produces.
 *
 * Usage: bun run e2e
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, type VerificationReport } from "../src/engine.js";
import { readEvents, verifyChain } from "../src/events.js";
import { createWorktreeManager, git, runDirFor } from "../src/worktree.js";

let failures = 0;
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The repo's own acceptance check: exits 0 only when `ok.txt` exists. */
const CHECK_SCRIPT = `import { existsSync } from "node:fs";
if (!existsSync("ok.txt")) { console.error("ok.txt missing"); process.exit(1); }
console.log("ok");
`;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "teamwork-e2e-"));
  const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf-8" });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf-8");
  writeFileSync(join(dir, "check.mjs"), CHECK_SCRIPT, "utf-8");
  writeFileSync(join(dir, ".gitignore"), ".opencode/\n", "utf-8");
  git(["add", "."], dir);
  const commit = spawnSync(
    "git",
    ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-m", "chore: fixture"],
    { cwd: dir, encoding: "utf-8" },
  );
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return dir;
}

/** Stand-in for a team/worker: edits its own worktree and commits. */
function fakeWorker(worktree: string, taskId: string, round: number, doesTheWork: boolean): void {
  if (doesTheWork) {
    if (round === 0) {
      writeFileSync(join(worktree, "ok.txt"), `work for ${taskId}\n`, "utf-8");
    } else {
      appendFileSync(join(worktree, "ok.txt"), `fixed in round ${round}\n`, "utf-8");
    }
  }
  git(["add", "-A"], worktree);
  spawnSync(
    "git",
    ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-m", `${taskId} round ${round}`, "--allow-empty"],
    { cwd: worktree, encoding: "utf-8" },
  );
}

/**
 * Stand-in for a team/verifier: runs the real command, records cmd + exit code
 * + stdout hash, and reports what actually happened.
 */
function fakeVerifier(worktree: string, taskId: string): VerificationReport {
  const run = spawnSync("node", ["check.mjs"], { cwd: worktree, encoding: "utf-8" });
  const stdout = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const exitCode = run.status ?? 1;
  const passed = exitCode === 0;

  const status = spawnSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf-8" });
  const clean = (status.stdout ?? "").trim().length === 0;

  return {
    taskId,
    verifierAgent: "team/verifier",
    verifierModel: "e2e/scripted",
    timestamp: new Date().toISOString(),
    status: passed ? "PASS" : "FAIL",
    checks: [
      {
        name: "acceptance:ok.txt",
        type: "programmatic",
        passed,
        cmd: "node check.mjs",
        exitCode,
        stdoutSha256: sha(stdout),
        output: stdout.slice(0, 200),
        ...(passed ? {} : { error: "exercised command exited non-zero" }),
      },
      {
        name: "worktree-clean",
        type: "programmatic",
        passed: clean,
        cmd: "git status --porcelain",
        exitCode: status.status ?? 1,
        stdoutSha256: sha(status.stdout ?? ""),
      },
    ],
    feedbackForWorker: passed ? "" : "run `node check.mjs` in your worktree and make it exit 0",
    fatalFindings: passed
      ? []
      : [{ where: "ok.txt", why: "missing", fix: "write ok.txt", reproduction: "node check.mjs" }],
  };
}

const repo = makeRepo();
const runId = "e2e-run";
const runDir = runDirFor(repo, runId);

try {
  console.log(`\n[1] Plan a 4-task DAG with real worktrees (repo: ${repo})`);
  const engine = Engine.create({
    runDir,
    sessionId: runId,
    topology: "distributed-coding",
    tasks: [
      { taskId: "T1", title: "first", dependsOn: [] },
      { taskId: "T2", title: "depends on T1", dependsOn: ["T1"] },
      { taskId: "T3", title: "independent", dependsOn: [] },
      { taskId: "T4", title: "never satisfies its check", dependsOn: [], maxRounds: 2 },
    ],
    maxConcurrency: 3,
    budgetUsd: 5,
    workingDirectory: repo,
  });

  const wm = createWorktreeManager();
  const sentinel = wm.initSession(runId, { cwd: repo });
  check("sentinel worktree exists", existsSync(sentinel.path), sentinel.path);
  const worktrees: Record<string, string> = {};
  for (const task of ["T1", "T2", "T3", "T4"]) {
    const info = wm.addAgent(`builder-${task}`, runId, { cwd: repo });
    worktrees[task] = info.path;
    check(`worktree for ${task} on branch ${info.branch}`, existsSync(info.path));
  }
  check("run directory created", existsSync(runDir));

  console.log("\n[2] The engine refuses an evidence-free PASS");
  const bogus = {
    taskId: "T1",
    verifierAgent: "team/verifier",
    verifierModel: "e2e/scripted",
    timestamp: new Date().toISOString(),
    status: "PASS" as const,
    checks: [{ name: "read the diff", type: "rubric" as const, passed: true }],
    feedbackForWorker: "",
    fatalFindings: [],
  };
  const rejected = engine.recordRound({ taskId: "T1", report: bogus as never });
  check("rubric-only PASS rejected", !rejected.accepted, rejected.rejection ?? "was accepted");
  check("rejected report did not count as a round", engine.status().rounds === 0);

  console.log("\n[3] Drive the loop until the engine says stop");
  let safety = 0;
  const dispatchOrder: string[] = [];
  const roundLog: string[] = [];
  while (safety < 20) {
    safety += 1;
    const ready = engine.dispatchable();
    if (ready.length === 0) break;
    for (const task of ready) {
      engine.dispatch(task.taskId);
      dispatchOrder.push(task.taskId);
      const wt = worktrees[task.taskId]!;
      const attempt = engine.status().tasks.find((t) => t.taskId === task.taskId)?.attempts ?? 0;
      // T4's worker never produces ok.txt, so its check really fails twice.
      fakeWorker(wt, task.taskId, attempt, task.taskId !== "T4");
      const report = fakeVerifier(wt, task.taskId);
      const outcome = engine.recordRound({ taskId: task.taskId, report, costUsd: 0.3 });
      roundLog.push(`${task.taskId}:${outcome.status}`);
      check(
        `${task.taskId} round ${outcome.attempt}/${outcome.maxRounds} -> ${outcome.status}`,
        outcome.accepted,
        outcome.rejection,
      );
    }
  }
  console.log(`    rounds: ${roundLog.join("  ")}`);

  console.log("\n[4] Assert the run's shape");
  const status = engine.status();
  check("T1 before T2 (dependency order)", dispatchOrder.indexOf("T1") < dispatchOrder.indexOf("T2"));
  check(
    "independent T3 ran in the first wave",
    dispatchOrder.indexOf("T3") < dispatchOrder.indexOf("T2"),
  );
  check("T1 completed", status.tasks.find((t) => t.taskId === "T1")?.status === "COMPLETED");
  check("T2 completed", status.tasks.find((t) => t.taskId === "T2")?.status === "COMPLETED");
  check("T3 completed", status.tasks.find((t) => t.taskId === "T3")?.status === "COMPLETED");
  check(
    "T4 dead-lettered after 2 rounds",
    status.deadletter.includes("T4"),
    JSON.stringify(status.deadletter),
  );
  check("session reached DONE", status.state === "DONE", status.state);
  check("cost accumulated in the log", status.costUsd > 0, `cost=${status.costUsd}`);
  check("hash chain intact", status.chain.ok, status.chain.reason);
  const completed = status.tasks.filter((t) => t.status === "COMPLETED").length;
  check("3 of 4 tasks completed, 1 parked for a human", completed === 3 && status.deadletter.length === 1);

  console.log("\n[5] Evidence is retrievable from the log");
  const reportEvent = engine
    .events()
    .find((e) => e.type === "verification.report" && e.taskId === "T3");
  const data = (reportEvent?.data ?? {}) as Record<string, unknown>;
  const checks = (data.report as { checks?: Array<Record<string, unknown>> } | undefined)?.checks ?? [];
  check("T3's report carries a real command and exit code", checks.some((c) => c["cmd"] === "node check.mjs" && c["exitCode"] === 0));
  check("T3's stdout hash was recorded", typeof checks[0]?.["stdoutSha256"] === "string");

  console.log("\n[6] Tamper detection and resume");
  const tampered = readEvents(runDir).map((e, i, all) =>
    i === all.length - 1 ? { ...e, data: { injected: true } } : e,
  );
  check("chain check catches an altered event", verifyChain(tampered).ok === false);

  const resumed = Engine.resume(runDir);
  const resumedStatus = resumed.status();
  check("resume replays identical task states", resumedStatus.deadletter.join() === status.deadletter.join());
  check("resume replays identical cost", Math.abs(resumedStatus.costUsd - status.costUsd) < 1e-9);
  check("resumed run is not dispatchable", resumed.dispatchable().length === 0);

  console.log("\n[7] Budget enforcement");
  const capped = Engine.create({
    runDir: runDirFor(repo, "e2e-budget"),
    sessionId: "e2e-budget",
    topology: "small-focused",
    tasks: [{ taskId: "B1", title: "x", dependsOn: [] }],
    budgetUsd: 0.5,
  });
  // A genuine FAIL: `node check.mjs` exits 1 in the base repo (no ok.txt).
  const realFail = {
    taskId: "B1",
    verifierAgent: "team/verifier",
    verifierModel: "e2e/scripted",
    timestamp: new Date().toISOString(),
    status: "FAIL" as const,
    checks: [
      {
        name: "acceptance:ok.txt",
        type: "programmatic" as const,
        passed: false,
        cmd: "node check.mjs",
        exitCode: 1,
      },
    ],
    feedbackForWorker: "write ok.txt",
    fatalFindings: [],
  };
  capped.recordRound({ taskId: "B1", report: realFail as never, costUsd: 0.75 });
  check("round recorded before the cap was hit", capped.status().rounds === 1);
  check("dispatch stops once the cap is hit", capped.dispatchable().length === 0);
  check("budget.exhausted was logged", capped.events().some((e) => e.type === "budget.exhausted"));

  console.log("\n[8] Cleanup");
  wm.cleanupSession(runId, { cwd: repo });
  const listed = wm.list(runId, { cwd: repo });
  check("worktrees removed and pruned", listed.length === 0, JSON.stringify(listed));
  check("sentinel worktree directory gone", !existsSync(sentinel.path));
} finally {
  rmSync(repo, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n✗ e2e failed: ${failures} check(s)\n`);
  process.exit(1);
}
console.log("\n✓ e2e passed — engine, worktrees, evidence capture, budget, dead-letter, resume, cleanup.\n");
