/**
 * Append-only, hash-chained run event log.
 *
 * This is the source of truth for a Teamwork run. `state.json` is now a
 * DERIVED snapshot (see deriveSession) — the LLM never owns the record of
 * what happened, because an LLM-written snapshot can silently skip or
 * misreport transitions.
 *
 * Properties:
 *   - append-only: events are never rewritten, only appended
 *   - tamper-evident: each event carries prevHash + hash (sha256 over the
 *     canonical JSON of the event with its hash removed)
 *   - replayable: deriveSession(events) reconstructs the run state, so a
 *     crashed/resumed run can be rebuilt from disk
 *
 * One event per line, JSONL. `events.jsonl` lives in the run directory
 * (`.opencode/teamwork/<session-id>/`).
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const GENESIS_HASH = "0".repeat(64);

export type EventType =
  | "session.start"
  | "plan.written"
  | "worktree.created"
  | "task.dispatched"
  | "task.round"
  | "verification.report"
  | "task.completed"
  | "task.failed"
  | "task.deadletter"
  | "budget.warning"
  | "budget.exhausted"
  | "session.done"
  | "session.error";

export interface RunEvent {
  seq: number;
  ts: string;
  type: EventType;
  sessionId: string;
  taskId?: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface TaskDerived {
  taskId: string;
  title: string;
  status: "PENDING" | "DISPATCHED" | "VERIFYING" | "COMPLETED" | "FAILED" | "DEADLETTER";
  attempts: number;
  costUsd: number;
  dependsOn: string[];
  lastReport?: Record<string, unknown>;
}

export interface DerivedSession {
  sessionId: string;
  topology?: string;
  state: "PENDING" | "RUNNING" | "DONE" | "ERROR";
  tasks: Record<string, TaskDerived>;
  order: string[];
  budgetUsd: number;
  haltAtPct: number;
  costUsd: number;
  rounds: number;
  deadletter: string[];
  lastSeq: number;
  tipHash: string;
}

const TIP_CACHE = new Map<string, RunEvent>();

export function eventLogPath(runDir: string): string {
  return join(runDir, "events.jsonl");
}

/** Canonical JSON: keys sorted, so the hash is stable across engines. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function hashEvent(prevHash: string, event: Omit<RunEvent, "hash">): string {
  return createHash("sha256").update(`${prevHash}\n${canonical(event)}`).digest("hex");
}

function readTip(runDir: string): RunEvent | null {
  const path = eventLogPath(runDir);
  const key = path;
  const cached = TIP_CACHE.get(key);
  if (cached) return cached;
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const parsed = JSON.parse(last) as RunEvent;
  TIP_CACHE.set(key, parsed);
  return parsed;
}

export interface AppendInput {
  type: EventType;
  sessionId: string;
  taskId?: string;
  data?: Record<string, unknown>;
  ts?: string;
}

/**
 * Append one event and return it (with seq/prevHash/hash filled in).
 * Sequential by construction: the hash chain is built from the previous
 * event's hash, so two concurrent appends to the same run must be
 * serialized by the caller (the Engine does this — it is single-writer
 * per run, which is also why only one process may own a run directory).
 */
export function appendEvent(runDir: string, input: AppendInput): RunEvent {
  mkdirSync(runDir, { recursive: true });
  const tip = readTip(runDir);
  const prevHash = tip?.hash ?? GENESIS_HASH;
  const seq = (tip?.seq ?? 0) + 1;

  const draft: Omit<RunEvent, "hash"> = {
    seq,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    sessionId: input.sessionId,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    prevHash,
  };
  const event: RunEvent = { ...draft, hash: hashEvent(prevHash, draft) };
  appendFileSync(eventLogPath(runDir), `${JSON.stringify(event)}\n`, "utf-8");
  TIP_CACHE.set(eventLogPath(runDir), event);
  return event;
}

export function readEvents(runDir: string): RunEvent[] {
  const path = eventLogPath(runDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunEvent);
}

export interface ChainCheck {
  ok: boolean;
  brokenAt?: number;
  reason?: string;
  length: number;
  tipHash: string;
}

/** Verify the hash chain end to end. A broken chain means the log was edited. */
export function verifyChain(events: RunEvent[]): ChainCheck {
  let prev = GENESIS_HASH;
  let seq = 0;
  for (const ev of events) {
    seq += 1;
    if (ev.seq !== seq) {
      return { ok: false, brokenAt: ev.seq, reason: `expected seq ${seq}, found ${ev.seq}`, length: events.length, tipHash: prev };
    }
    if (ev.prevHash !== prev) {
      return { ok: false, brokenAt: ev.seq, reason: "prevHash does not match the previous event", length: events.length, tipHash: prev };
    }
    const { hash, ...rest } = ev;
    const expect = hashEvent(prev, rest as Omit<RunEvent, "hash">);
    if (expect !== hash) {
      return { ok: false, brokenAt: ev.seq, reason: "hash mismatch (event was modified)", length: events.length, tipHash: prev };
    }
    prev = hash;
  }
  const tip = events[events.length - 1];
  return { ok: true, length: events.length, tipHash: tip?.hash ?? GENESIS_HASH };
}

/**
 * Replay the log into run state. This is what the sentinel, the CLI and
 * the TUI all read — never `state.json`.
 */
export function deriveSession(events: RunEvent[]): DerivedSession {
  const first = events[0];
  const sessionId = first?.sessionId ?? "";
  const tasks: Record<string, TaskDerived> = {};
  const order: string[] = [];
  let topology: string | undefined;
  let budgetUsd = 0;
  let haltAtPct = 80;
  let costUsd = 0;
  let rounds = 0;
  let state: DerivedSession["state"] = "PENDING";

  const ensure = (taskId: string): TaskDerived => {
    const existing = tasks[taskId];
    if (existing) return existing;
    const created: TaskDerived = {
      taskId,
      title: taskId,
      status: "PENDING",
      attempts: 0,
      costUsd: 0,
      dependsOn: [],
    };
    tasks[taskId] = created;
    order.push(taskId);
    return created;
  };

  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "session.start":
        state = "RUNNING";
        if (typeof d.topology === "string") topology = d.topology;
        if (typeof d.budgetUsd === "number") budgetUsd = d.budgetUsd;
        if (typeof d.haltAtPct === "number") haltAtPct = d.haltAtPct;
        break;
      case "plan.written": {
        const raw = d.tasks;
        if (Array.isArray(raw)) {
          for (const t of raw as Array<Record<string, unknown>>) {
            const id = String(t.taskId ?? "");
            if (!id) continue;
            const task = ensure(id);
            if (typeof t.title === "string") task.title = t.title;
            task.dependsOn = Array.isArray(t.dependsOn) ? (t.dependsOn as string[]) : [];
          }
        }
        break;
      }
      case "task.dispatched": {
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        task.status = "DISPATCHED";
        break;
      }
      case "verification.report": {
        // A round is one verifier verdict. `task.round` is an informational
        // follow-up on the same round, so it must not be counted again.
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        rounds += 1;
        if (typeof d.costUsd === "number") {
          task.costUsd += d.costUsd;
          costUsd += d.costUsd;
        }
        if (typeof d.attempt === "number") task.attempts = d.attempt;
        if (d.report && typeof d.report === "object") {
          task.lastReport = d.report as Record<string, unknown>;
        }
        task.status = "VERIFYING";
        break;
      }
      case "task.round": {
        if (!ev.taskId) break;
        const task = ensure(ev.taskId);
        if (typeof d.attempt === "number") task.attempts = d.attempt;
        task.status = "PENDING";
        break;
      }
      case "task.completed":
        if (ev.taskId) ensure(ev.taskId).status = "COMPLETED";
        break;
      case "task.failed":
        if (ev.taskId) ensure(ev.taskId).status = "FAILED";
        break;
      case "task.deadletter":
        if (ev.taskId) ensure(ev.taskId).status = "DEADLETTER";
        break;
      case "budget.exhausted":
        if (typeof d.costUsd === "number") costUsd = Math.max(costUsd, d.costUsd);
        break;
      case "session.done":
        state = "DONE";
        break;
      case "session.error":
        state = "ERROR";
        break;
      default:
        break;
    }
  }

  const deadletter = order.filter((id) => tasks[id]?.status === "DEADLETTER");
  const tip = events[events.length - 1];
  return {
    sessionId,
    ...(topology ? { topology } : {}),
    state,
    tasks,
    order,
    budgetUsd,
    haltAtPct,
    costUsd,
    rounds,
    deadletter,
    lastSeq: tip?.seq ?? 0,
    tipHash: tip?.hash ?? GENESIS_HASH,
  };
}

/** Write the derived snapshot. Derived data only — never hand-edited. */
export function writeSnapshot(runDir: string, derived: DerivedSession): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    `${JSON.stringify(derived, null, 2)}\n`,
    "utf-8",
  );
}

/** Test/resume helper: forget the cached tip so the file is re-read. */
export function resetTipCache(): void {
  TIP_CACHE.clear();
}
