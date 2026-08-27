/**
 * Session state machine for Teamwork.
 *
 * Persists the Sentinel's progress to
 * `.opencode/teamwork/<session-id>/state.json` after every
 * transition. On RESUME, the Sentinel re-reads this file and
 * picks up where it left off.
 *
 * Pure data — no I/O outside of readFileSync/writeFileSync on
 * the well-known path.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

export interface TaskState {
  taskId: string;
  status: "PENDING" | "RUNNING" | "VERIFYING" | "COMPLETED" | "FAILED";
  attempts: number;
  lastVerifierReport?: string; // path
  lastPatch?: string;          // path
  assignedAgent?: string;
  assignedModel?: string;
  worktreePath?: string;
  dependencies: string[];
  acceptanceCriteria: string[];
  artifacts: string[];
  metrics?: { tokensUsed: number; costUsd: number };
}

export interface SessionState {
  sessionId: string;
  topology: "small-focused" | "large-swarm" | "proof" | "massive-proof" | "doc-review";
  integrityMode: "development" | "demo" | "benchmark";
  workingDirectory: string;
  state: SentinelState;
  startedAt: string;
  updatedAt: string;
  tasks: TaskState[];
  pitfalls: string[];        // answer-agnostic mistakes from past rounds
  notes: string[];           // free-form observations
}

function statePath(sessionDir: string): string {
  return join(sessionDir, "state.json");
}

export function loadSessionState(sessionDir: string): SessionState | null {
  const path = statePath(sessionDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveSessionState(sessionDir: string, state: SessionState): void {
  mkdirSync(sessionDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(sessionDir), JSON.stringify(state, null, 2));
}

export function newSessionState(opts: {
  sessionId: string;
  topology: SessionState["topology"];
  integrityMode: SessionState["integrityMode"];
  workingDirectory: string;
}): SessionState {
  const now = new Date().toISOString();
  return {
    sessionId: opts.sessionId,
    topology: opts.topology,
    integrityMode: opts.integrityMode,
    workingDirectory: opts.workingDirectory,
    state: "PENDING",
    startedAt: now,
    updatedAt: now,
    tasks: [],
    pitfalls: [],
    notes: [],
  };
}

export function addPitfall(sessionDir: string, pitfall: string): void {
  const state = loadSessionState(sessionDir);
  if (!state) return;
  if (!state.pitfalls.includes(pitfall)) {
    state.pitfalls.push(pitfall);
    saveSessionState(sessionDir, state);
  }
}

export function transition(
  sessionDir: string,
  nextState: SentinelState,
  notes?: string,
): SessionState {
  const state = loadSessionState(sessionDir);
  if (!state) throw new Error(`No session state in ${sessionDir}`);
  state.state = nextState;
  if (notes) state.notes.push(notes);
  saveSessionState(sessionDir, state);
  return state;
}
