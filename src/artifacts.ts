/**
 * Typed artifact bus schemas for Teamwork.
 *
 * Every agent communicates via JSON artifacts on disk, not raw
 * conversation. The schemas here are the source of truth. The
 * Zod schema is exported so plugins / users can validate.
 */

import { z } from "zod";

// spec.json — the worker's task spec (scoped from the global spec)
export const SpecSchema = z.object({
  taskId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  description: z.string(),
  requirements: z.array(z.string()),       // $R_i$ for THIS task
  acceptanceCriteria: z.array(z.string()), // markdown checkboxes
  verification: z.object({
    programmatic: z.array(z.string()).default([]),  // commands to run
    adversarial: z.array(z.string()).default([]),   // the verifier adds these
    rubric: z.array(z.string()).optional(),         // for non-code tasks
  }),
  localChecks: z.array(z.string()).default([]),     // what the worker runs itself
  assignedModel: z.string().optional(),
  dependencies: z.array(z.string()).default([]),    // taskIds
  worktreePath: z.string().optional(),
  budget: z.object({ maxRounds: z.number().default(4), maxCostUsd: z.number().default(5) }).optional(),
  pitfalls: z.array(z.string()).default([]),        // from past rounds
});
export type Spec = z.infer<typeof SpecSchema>;

// patch.diff — git diff produced by the worker
// (No schema; the file IS the diff. The path is what matters.)

// summary.md — the worker's self-report
// (Markdown. Plain text. No schema; the structure is in the agent's prompt.)

// verification_report.json — the verifier's structured report
export const VerificationCheckSchema = z.object({
  name: z.string(),
  type: z.enum(["programmatic", "adversarial", "rubric"]),
  passed: z.boolean(),
  output: z.string().max(2048).optional(),
  error: z.string().optional(),
});

export const VerificationReportSchema = z.object({
  taskId: z.string(),
  verifierAgent: z.string(),
  verifierModel: z.string(),
  timestamp: z.string(),
  status: z.enum(["PASS", "FAIL"]),
  checks: z.array(VerificationCheckSchema),
  feedbackForWorker: z.string(),
  fatalFindings: z.array(z.object({
    where: z.string(),
    why: z.string(),
    fix: z.string().optional(),
    reproduction: z.string().optional(),
  })).default([]),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

// plan.dag.json — the task DAG built by the Sentinel
export const DagTaskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  assignedWorker: z.string().optional(),    // agent name
  assignedModel: z.string().optional(),
  worktreePath: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  status: z.enum(["PENDING", "RUNNING", "VERIFYING", "COMPLETED", "FAILED"]).default("PENDING"),
  acceptanceCriteria: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  metrics: z.object({
    tokensUsed: z.number().default(0),
    costUsd: z.number().default(0),
  }).optional(),
});

export const PlanDagSchema = z.object({
  sessionId: z.string(),
  topology: z.string(),
  modelAllocation: z.object({
    sentinel: z.string().optional(),
    defaultWorker: z.string().optional(),
    verifier: z.string().optional(),
  }),
  budget: z.object({
    maxCostUsd: z.number(),
    currentCostUsd: z.number().default(0),
  }),
  tasks: z.array(DagTaskSchema),
});
export type PlanDag = z.infer<typeof PlanDagSchema>;

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
