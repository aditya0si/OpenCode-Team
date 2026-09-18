/**
 * Compatibility layer for run state.
 *
 * The old module claimed to be a "session state machine" and had the LLM
 * write `state.json` after every step. That made the record of what happened
 * a model claim rather than a fact, and an interrupted run could resume into a
 * state that never occurred.
 *
 * State now lives in the append-only hash-chained event log (`events.jsonl`,
 * see `src/events.ts`), and `state.json` is a DERIVED snapshot written by the
 * engine. Nothing model-authored is authoritative.
 *
 * These exports are kept so existing callers keep compiling; new code should
 * use `src/events.ts` (deriveSession / appendEvent) and `src/engine.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveSession,
  readEvents,
  verifyChain,
  writeSnapshot,
  type DerivedSession,
  type EventType,
} from "./events.js";
import type { Topology } from "./policy.js";

/**
 * @deprecated The sentinel's state is derived from the event log. Kept only so
 * legacy callers can name the phases.
 */
export type SentinelState =
  | "PENDING"
  | "LOAD_SPEC"
  | "WORKTREE_INIT"
  | "DAG_BUILD"
  | "DISPATCH_LOOP"
  | "DISPATCH"
  | "WORKER_RUN"
  | "VERIFIER_RUN"
  | "RETRY"
  | "MERGE"
  | "PRESENT_PARTIAL"
  | "DONE";

/**
 * @deprecated Use `DerivedSession` from `src/events.ts`. The legacy shape
 * carried an `integrityMode` that nothing read and a topology union that did
 * not match any pattern file.
 */
export interface SessionState extends DerivedSession {
  /** @deprecated pitfalls live in the run artifacts, not in derived state. */
  notes: string[];
}

function statePath(sessionDir: string): string {
  return join(sessionDir, "state.json");
}

/**
 * Read the run state. Prefers the event log (authoritative, replayable) and
 * falls back to the last snapshot for runs created before the log existed.
 */
export function loadSessionState(sessionDir: string): SessionState | null {
  const events = readEvents(sessionDir);
  if (events.length > 0) {
    const derived = deriveSession(events);
    return { ...derived, notes: [] };
  }
  const path = statePath(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DerivedSession;
    return { ...parsed, notes: [] };
  } catch {
    return null;
  }
}

/** Replay the log and refresh the snapshot. */
export function refreshSnapshot(sessionDir: string): DerivedSession | null {
  const events = readEvents(sessionDir);
  if (events.length === 0) return null;
  const derived = deriveSession(events);
  writeSnapshot(sessionDir, derived);
  return derived;
}

/**
 * @deprecated Callers must not write state. Use `appendEvent` (or one of the
 * engine methods, which validate and append for you).
 */
export function saveSessionState(_sessionDir: string, _state: SessionState): never {
  throw new Error(
    "saveSessionState is removed: run state is derived from the append-only event log. " +
      "Use appendEvent() from src/events.ts, or the engine methods (dispatch/recordRound).",
  );
}

export interface LogIntegrity {
  ok: boolean;
  length: number;
  reason?: string;
}

/** Convenience: is this run's log intact? */
export function checkLog(sessionDir: string): LogIntegrity {
  const events = readEvents(sessionDir);
  const chain = verifyChain(events);
  return {
    ok: chain.ok,
    length: chain.length,
    ...(chain.reason ? { reason: chain.reason } : {}),
  };
}

export type { DerivedSession, EventType, Topology };
