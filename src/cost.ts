/**
 * Cost / budget tracker for Teamwork.
 *
 * Each agent call reports its token + cost usage. We aggregate per
 * session. When the session approaches its budget cap (default 80%),
 * the Sentinel is expected to halt non-essential workers and prompt
 * the user.
 *
 * The model catalog is a static table of rough USD-per-1k-token
 * rates. This is intentionally coarse — the user can override.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ModelRate {
  input: number;  // USD per 1k input tokens
  output: number; // USD per 1k output tokens
}

export interface CostEntry {
  agentName: string;
  model: string;
  taskId: string;
  tokensUsed: { input: number; output: number };
  costUsd: number;
  wallClockSeconds: number;
  toolCalls: number;
  timestamp: string; // ISO8601
}

export interface CostState {
  sessionId: string;
  budget: { maxSessionCostUsd: number; alertThresholdPct: number };
  rates: Record<string, ModelRate>;
  entries: CostEntry[];
  totals: {
    costUsd: number;
    tokensUsed: { input: number; output: number };
    wallClockSeconds: number;
    toolCalls: number;
  };
}

// Model catalog — these are baseline rates. Override per-run.
const DEFAULT_RATES: Record<string, ModelRate> = {
  "anthropic/claude-opus-4-5":   { input: 0.015, output: 0.075 },
  "anthropic/claude-sonnet-4-5": { input: 0.003, output: 0.015 },
  "anthropic/claude-haiku-4-5":  { input: 0.0008, output: 0.004 },
  "openai/gpt-5.2":              { input: 0.005, output: 0.020 },
  "openai/gpt-5-mini":           { input: 0.0002, output: 0.0008 },
  "google/gemini-3.1-pro":       { input: 0.00125, output: 0.005 },
  "google/gemini-3-flash":       { input: 0.000075, output: 0.0003 },
  "openrouter/meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
  "openrouter/meta-llama/llama-3.3-70b-instruct":     { input: 0.00059, output: 0.00079 },
};

function costPath(sessionDir: string): string {
  return join(sessionDir, "costs.json");
}

function loadOrInit(sessionId: string, sessionDir: string, maxBudget: number): CostState {
  const path = costPath(sessionDir);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return {
    sessionId,
    budget: { maxSessionCostUsd: maxBudget, alertThresholdPct: 80 },
    rates: DEFAULT_RATES,
    entries: [],
    totals: { costUsd: 0, tokensUsed: { input: 0, output: 0 }, wallClockSeconds: 0, toolCalls: 0 },
  };
}

function save(state: CostState, sessionDir: string): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(costPath(sessionDir), JSON.stringify(state, null, 2));
}

function estimateCost(model: string, input: number, output: number, rates: Record<string, ModelRate>): number {
  const rate = rates[model] ?? rates["anthropic/claude-sonnet-4-5"]!;
  return (input / 1000) * rate.input + (output / 1000) * rate.output;
}

export interface CostTracker {
  record(entry: Omit<CostEntry, "costUsd" | "timestamp">): CostEntry;
  getTotal(): number;
  getPctOfBudget(): number;
  shouldHalt(): boolean;
  state(): CostState;
  flush(): void;
}

export function createCostTracker(
  sessionId: string,
  sessionDir: string,
  options?: { maxBudget?: number; customRates?: Record<string, ModelRate> },
): CostTracker {
  const state = loadOrInit(sessionId, sessionDir, options?.maxBudget ?? 20);
  if (options?.customRates) {
    state.rates = { ...state.rates, ...options.customRates };
  }
  return {
    record(entry) {
      const costUsd = estimateCost(entry.model, entry.tokensUsed.input, entry.tokensUsed.output, state.rates);
      const full: CostEntry = { ...entry, costUsd, timestamp: new Date().toISOString() };
      state.entries.push(full);
      state.totals.costUsd += costUsd;
      state.totals.tokensUsed.input += entry.tokensUsed.input;
      state.totals.tokensUsed.output += entry.tokensUsed.output;
      state.totals.wallClockSeconds += entry.wallClockSeconds;
      state.totals.toolCalls += entry.toolCalls;
      save(state, sessionDir);
      return full;
    },
    getTotal() {
      return state.totals.costUsd;
    },
    getPctOfBudget() {
      return (state.totals.costUsd / state.budget.maxSessionCostUsd) * 100;
    },
    shouldHalt() {
      return this.getPctOfBudget() >= state.budget.alertThresholdPct;
    },
    state() {
      return state;
    },
    flush() {
      save(state, sessionDir);
    },
  };
}
