/**
 * Typed artifact bus schemas for Teamwork.
 *
 * Every agent communicates via JSON artifacts on disk, not raw conversation.
 * The schemas here are the source of truth, and they are now actually
 * enforced: the engine's tools validate every spec, plan and verification
 * report against them before the artifact is accepted (see `src/tools.ts`,
 * `src/engine.ts#validateReport`). Malformed JSON used to pass silently —
 * that is how a fabricated `verification_report.json` could be read as a PASS.
 *
 * Evidence fields (`cmd`, `exitCode`, `stdoutSha256`, `durationMs`) exist so a
 * PASS can be tied to a command that actually ran. `validateReport` in the
 * engine refuses a PASS without them.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { TOPOLOGY_NAMES } from "./policy.js";

// spec.json — the worker's task spec (scoped from the global spec)
export const SpecSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  description: z.string().default(""),
  requirements: z.array(z.string()).default([]), // $R_i$ for THIS task
  acceptanceCriteria: z.array(z.string()).default([]), // markdown checkboxes
  verification: z
    .object({
      programmatic: z.array(z.string()).default([]), // commands to run
      adversarial: z.array(z.string()).default([]), // the verifier adds these
      rubric: z.array(z.string()).optional(), // for non-code tasks
    })
    .default({ programmatic: [], adversarial: [] }),
  localChecks: z.array(z.string()).default([]), // what the worker runs itself
  assignedModel: z.string().optional(),
  dependencies: z.array(z.string()).default([]), // taskIds
  worktreePath: z.string().optional(),
  budget: z
    .object({ maxRounds: z.number().default(4), maxCostUsd: z.number().default(5) })
    .optional(),
  pitfalls: z.array(z.string()).default([]), // from past rounds
});
export type Spec = z.infer<typeof SpecSchema>;

// patch.diff — git diff produced by the worker
// (No schema; the file IS the diff. The path is what matters.)

// summary.md — the worker's self-report
// (Markdown. Plain text. No schema; the structure is in the agent's prompt.)

// verification_report.json — the verifier's structured report
export const VerificationCheckSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["programmatic", "adversarial", "rubric"]),
  passed: z.boolean(),
  /** The command that was executed. Required for programmatic/adversarial. */
  cmd: z.string().optional(),
  /** Exit code of that command. Required for programmatic/adversarial. */
  exitCode: z.number().int().optional(),
  /** sha256 of the captured stdout — evidence can be re-checked later. */
  stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.string().max(2048).optional(),
  error: z.string().optional(),
});

export const VerificationReportSchema = z.object({
  taskId: z.string().min(1),
  verifierAgent: z.string().min(1),
  verifierModel: z.string().min(1),
  timestamp: z.string().min(1),
  status: z.enum(["PASS", "FAIL"]),
  checks: z.array(VerificationCheckSchema).min(1),
  feedbackForWorker: z.string().default(""),
  fatalFindings: z
    .array(
      z.object({
        where: z.string(),
        why: z.string(),
        fix: z.string().optional(),
        reproduction: z.string().optional(),
      }),
    )
    .default([]),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

// plan.dag.json — the task DAG built by the Sentinel
export const DagTaskSchema = z.object({
  taskId: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  taskClass: z.string().optional(),
  assignedWorker: z.string().optional(), // agent name
  assignedModel: z.string().optional(),
  worktreePath: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  status: z
    .enum(["PENDING", "DISPATCHED", "VERIFYING", "COMPLETED", "FAILED", "DEADLETTER"])
    .default("PENDING"),
  acceptanceCriteria: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  maxRounds: z.number().int().positive().optional(),
  metrics: z
    .object({
      tokensUsed: z.number().default(0),
      costUsd: z.number().default(0),
    })
    .optional(),
});

export const PlanDagSchema = z.object({
  sessionId: z.string().min(1),
  topology: z.string().refine((t) => TOPOLOGY_NAMES.includes(t), {
    message: `topology must be one of ${TOPOLOGY_NAMES.join(", ")}`,
  }),
  modelAllocation: z
    .object({
      sentinel: z.string().optional(),
      defaultWorker: z.string().optional(),
      verifier: z.string().optional(),
    })
    .default({}),
  budget: z.object({
    maxCostUsd: z.number().nonnegative(),
    currentCostUsd: z.number().nonnegative().default(0),
  }),
  tasks: z.array(DagTaskSchema).min(1),
});
export type PlanDag = z.infer<typeof PlanDagSchema>;

/** Parse with a readable, actionable error. Used by the engine's tools. */
export function parseArtifact<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues
    .slice(0, 8)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `${label} failed schema validation — ${issues}` };
}

// prompt_draft.md — the Phase-1 spec from the crafter
// (Markdown. The structure is in the crafter's prompt.)

// final.md — the result presented to the user
// (Markdown. The Sentinel writes this; the schema is "see /teamwork prompt".)

// Export all schemas under a single namespace for convenience.
export const Artifact = {
  Spec: SpecSchema,
  VerificationCheck: VerificationCheckSchema,
  VerificationReport: VerificationReportSchema,
  DagTask: DagTaskSchema,
  PlanDag: PlanDagSchema,
};

export const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
