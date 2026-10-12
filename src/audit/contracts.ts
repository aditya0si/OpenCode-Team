/**
 * Audit contracts — the validated provenance boundary for the completion
 * auditor.
 *
 * Everything crossing this boundary is untrusted: task criteria, agent claims
 * and evidence records may arrive from a model, an imported log or a runner.
 * TypeScript types are erased at runtime, so `parseAuditInput` is the only
 * sanctioned way to turn `unknown` into `AuditInput`. Invalid input fails
 * closed (throws `AuditValidationError`) and is never treated as trusted.
 *
 * Scope note: this schema is a *provenance* boundary. It records where evidence
 * came from and how much it may be trusted; it does not authenticate a JSON
 * receipt, contain a malicious runner, or prove a supplied string token is
 * genuine. Trusted capture/store integration is a later task's job. A label
 * such as `RUNNER_CAPTURED` is an assertion by the caller, not proof.
 */

import { z } from "zod";

/**
 * Bumped whenever the validated shape changes incompatibly.
 *
 * v2 (round-1 repair): every evidence record now carries its own `taskId`, and
 * `discovery` is reconciled test counts instead of a bare `KNOWN`/`UNKNOWN`
 * label. Both are incompatible with v1 records.
 *
 * Round-2 repair is **backward compatible** and deliberately does *not* bump
 * this version: the new `CriterionSchema.artifactExpectation` and the new
 * optional `SpanSchema.redacted`/`originalStart`/`originalEnd` fields are all
 * optional. A v2 document that predates them still validates unchanged, and a
 * document that omits them is still complete. No previously-valid field changed
 * meaning, so no version bump is warranted.
 */
export const AUDIT_SCHEMA_VERSION = 2;

/** Hard size limits so untrusted input cannot grow without bound. */
export const LIMITS = {
  maxIdLength: 128,
  maxSpanLength: 4096,
  maxTextLength: 8192,
  maxSourceLength: 2048,
  maxPathLength: 1024,
  maxLimitationLength: 1024,
  maxCriteria: 256,
  maxClaims: 512,
  maxEvidence: 2048,
  maxCriterionRefs: 64,
  maxLimitations: 32,
  maxWaivers: 64,
  maxPaths: 256,
} as const;

/**
 * Strict identifier shape. Keeps IDs single-token, bounded and free of
 * whitespace/control characters so they cannot be used to smuggle paths or
 * multi-line content into a report.
 */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const IdSchema = z.string().min(1).max(LIMITS.maxIdLength).regex(ID_PATTERN, {
  message: "id must match [A-Za-z0-9][A-Za-z0-9._:-]*",
});

function addIssue(
  ctx: z.RefinementCtx,
  message: string,
  path: Array<string | number>,
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
}

/**
 * An exact span in a source text. `end - start` MUST equal `text.length` so a
 * stored span cannot drift from the words it displays.
 *
 * Redaction never silently rewrites a span into a seemingly-exact replacement.
 * When the displayed `text` had to be redacted, `redacted` is set and the true
 * original offsets are recorded **separately** in `originalStart`/`originalEnd`
 * (numeric offsets only — the original secret text is never persisted). In that
 * case `start` remains the original start, `end` is `start + text.length` for
 * display exactness, and the display length may differ from the original
 * extent. A non-redacted span carries none of these fields.
 */
export const SpanSchema = z
  .object({
    text: z.string().min(1).max(LIMITS.maxSpanLength),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    redacted: z.boolean().optional(),
    originalStart: z.number().int().min(0).optional(),
    originalEnd: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.end - s.start !== s.text.length) {
      addIssue(ctx, "span must be exact: end - start must equal text length", ["end"]);
    }
    const hasOriginal = s.originalStart !== undefined || s.originalEnd !== undefined;
    if (s.redacted === true) {
      if (s.originalStart === undefined || s.originalEnd === undefined) {
        addIssue(
          ctx,
          "a redacted span must record its original offsets separately",
          ["originalStart"],
        );
      } else if (s.originalEnd <= s.originalStart) {
        addIssue(ctx, "a redacted span must record a positive original extent", ["originalEnd"]);
      }
    } else if (hasOriginal) {
      addIssue(
        ctx,
        "original offsets are only valid when the span display was redacted",
        ["originalStart"],
      );
    }
  });

export const AcceptanceTypeSchema = z.enum(["EXECUTION", "ARTIFACT"]);
export const EvidenceKindSchema = z.enum(["EXECUTION", "ARTIFACT"]);
export const EvidenceOriginSchema = z.enum([
  "RUNNER_CAPTURED",
  "IMPORTED",
  "MODEL_ASSERTED",
]);
export const EvidenceCompletionSchema = z.enum([
  "COMPLETED",
  "SKIPPED",
  "TIMEOUT",
  "CANCELLED",
  "FAILED",
  "BLOCKED",
]);
export const EvidenceResultSchema = z.enum(["PASS", "FAIL", "INCONCLUSIVE", "UNKNOWN"]);
/**
 * Reconciled test-discovery counts for a candidate suite run.
 *
 * A bare "known" label is not evidence of completeness: a zero-test or
 * all-skipped suite used to satisfy a suite-completeness criterion by asserting
 * `KNOWN`. The schema now requires explicit counts whose sum reconciles
 * (`passed + failed + skipped === collected`) and that approved skips do not
 * exceed skips. Whether the counts are *sufficient* for completeness is a
 * verdict decision, not a schema one.
 */
export const DiscoverySchema = z
  .object({
    collected: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    approvedSkips: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.passed + value.failed + value.skipped !== value.collected) {
      addIssue(
        ctx,
        "discovery counts must reconcile: passed + failed + skipped === collected",
        ["collected"],
      );
    }
    if ((value.approvedSkips ?? 0) > value.skipped) {
      addIssue(ctx, "discovery approvedSkips cannot exceed skipped", ["approvedSkips"]);
    }
  });

export const AuditScopeSchema = z
  .object({
    description: z.string().min(1).max(LIMITS.maxTextLength),
    paths: z
      .array(z.string().min(1).max(LIMITS.maxPathLength))
      .max(LIMITS.maxPaths)
      .optional(),
    exclusions: z
      .array(z.string().min(1).max(LIMITS.maxPathLength))
      .max(LIMITS.maxPaths)
      .optional(),
  })
  .strict();

/**
 * A registered byte-level acceptance predicate for an `ARTIFACT` criterion.
 *
 * An artifact criterion is only meaningful when it names the exact file whose
 * bytes it claims to accept. `presence: "present"` requires a concrete
 * `digest`; `presence: "absent"` requires `digest: null`. This deliberately
 * cannot express "some file exists" or a semantic claim: a criterion without a
 * predicate can never be satisfied by a static artifact observation.
 */
export const ArtifactExpectationSchema = z
  .object({
    path: z.string().min(1).max(LIMITS.maxPathLength),
    presence: z.enum(["present", "absent"]),
    digest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.presence === "present" && value.digest === null) {
      addIssue(ctx, "a present artifact expectation requires a concrete digest", ["digest"]);
    }
    if (value.presence === "absent" && value.digest !== null) {
      addIssue(ctx, "an absent artifact expectation must not carry a digest", ["digest"]);
    }
  });

export const CriterionSchema = z
  .object({
    id: IdSchema,
    span: SpanSchema,
    required: z.boolean(),
    acceptanceType: AcceptanceTypeSchema,
    requiresSuiteCompleteness: z.boolean().optional(),
    statement: z.string().min(1).max(LIMITS.maxTextLength).optional(),
    artifactExpectation: ArtifactExpectationSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A byte-level artifact predicate on an execution criterion is meaningless
    // and could only be an attempt to smuggle a semantic claim. The pure core
    // additionally refuses to let an artifact observation support a criterion
    // that registers no predicate at all.
    if (value.artifactExpectation !== undefined && value.acceptanceType !== "ARTIFACT") {
      addIssue(
        ctx,
        "artifactExpectation is only valid for an ARTIFACT criterion",
        ["artifactExpectation"],
      );
    }
  });

export const ClaimSchema = z
  .object({
    id: IdSchema,
    span: SpanSchema,
    criterionIds: z.array(IdSchema).max(LIMITS.maxCriterionRefs),
    text: z.string().min(1).max(LIMITS.maxTextLength).optional(),
  })
  .strict();

export const EvidenceRecordSchema = z
  .object({
    checkId: IdSchema,
    taskId: IdSchema,
    candidateId: IdSchema,
    taskRevision: IdSchema,
    criterionIds: z.array(IdSchema).min(1).max(LIMITS.maxCriterionRefs),
    kind: EvidenceKindSchema,
    origin: EvidenceOriginSchema,
    completion: EvidenceCompletionSchema,
    result: EvidenceResultSchema,
    discovery: DiscoverySchema.optional(),
    exitCode: z.number().int().optional(),
    source: z.string().min(1).max(LIMITS.maxSourceLength).optional(),
    limitations: z
      .array(z.string().min(1).max(LIMITS.maxLimitationLength))
      .max(LIMITS.maxLimitations)
      .optional(),
  })
  .strict();

export const WaiverSchema = z
  .object({
    id: IdSchema,
    criterionId: IdSchema.optional(),
    reason: z.string().min(1).max(LIMITS.maxTextLength),
    approvedBy: z.string().min(1).max(LIMITS.maxIdLength).optional(),
  })
  .strict();

export const AuditInputSchema = z
  .object({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
    taskId: IdSchema,
    taskRevision: IdSchema,
    candidateId: IdSchema,
    scope: AuditScopeSchema,
    criteria: z.array(CriterionSchema).max(LIMITS.maxCriteria).default([]),
    claims: z.array(ClaimSchema).max(LIMITS.maxClaims).default([]),
    evidence: z.array(EvidenceRecordSchema).max(LIMITS.maxEvidence).default([]),
    waivers: z.array(WaiverSchema).max(LIMITS.maxWaivers).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const criterionIds = new Set<string>();
    value.criteria.forEach((criterion, index) => {
      if (criterionIds.has(criterion.id)) {
        addIssue(ctx, `duplicate criterion id: ${criterion.id}`, ["criteria", index, "id"]);
      }
      criterionIds.add(criterion.id);
    });

    const claimIds = new Set<string>();
    value.claims.forEach((claim, index) => {
      if (claimIds.has(claim.id)) {
        addIssue(ctx, `duplicate claim id: ${claim.id}`, ["claims", index, "id"]);
      }
      claimIds.add(claim.id);
      for (const ref of claim.criterionIds) {
        if (!criterionIds.has(ref)) {
          addIssue(ctx, `claim ${claim.id} references unknown criterion: ${ref}`, [
            "claims",
            index,
            "criterionIds",
          ]);
        }
      }
    });

    const checkIds = new Set<string>();
    value.evidence.forEach((record, index) => {
      if (checkIds.has(record.checkId)) {
        addIssue(ctx, `duplicate check id: ${record.checkId}`, ["evidence", index, "checkId"]);
      }
      checkIds.add(record.checkId);
      for (const ref of record.criterionIds) {
        if (!criterionIds.has(ref)) {
          addIssue(ctx, `evidence ${record.checkId} references unknown criterion: ${ref}`, [
            "evidence",
            index,
            "criterionIds",
          ]);
        }
      }
    });

    const waiverIds = new Set<string>();
    value.waivers.forEach((entry, index) => {
      if (waiverIds.has(entry.id)) {
        addIssue(ctx, `duplicate waiver id: ${entry.id}`, ["waivers", index, "id"]);
      }
      waiverIds.add(entry.id);
      if (entry.criterionId !== undefined && !criterionIds.has(entry.criterionId)) {
        addIssue(ctx, `waiver ${entry.id} references unknown criterion: ${entry.criterionId}`, [
          "waivers",
          index,
          "criterionId",
        ]);
      }
    });
  });

export type AuditInput = z.infer<typeof AuditInputSchema>;
export type AuditScope = z.infer<typeof AuditScopeSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type Waiver = z.infer<typeof WaiverSchema>;
export type Span = z.infer<typeof SpanSchema>;
export type ArtifactExpectation = z.infer<typeof ArtifactExpectationSchema>;
export type AcceptanceType = z.infer<typeof AcceptanceTypeSchema>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceOrigin = z.infer<typeof EvidenceOriginSchema>;
export type EvidenceCompletion = z.infer<typeof EvidenceCompletionSchema>;
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export type Discovery = z.infer<typeof DiscoverySchema>;

/** A single, reportable validation problem. */
export interface AuditValidationIssue {
  /** Dotted path into the rejected input, e.g. `evidence.0.result`. */
  path: string;
  /** Zod issue code, e.g. `invalid_enum_value` or `custom`. */
  code: string;
  message: string;
}

export class AuditValidationError extends Error {
  readonly issues: AuditValidationIssue[];

  constructor(issues: AuditValidationIssue[]) {
    super(`audit input failed validation (${issues.length} issue(s))`);
    this.name = "AuditValidationError";
    this.issues = issues;
  }
}

function toIssue(issue: z.ZodIssue): AuditValidationIssue {
  return {
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  };
}

/**
 * Validate untrusted runtime input. Throws `AuditValidationError` on any
 * malformed, duplicated or dangling reference. Never trusts TS types.
 */
export function parseAuditInput(value: unknown): AuditInput {
  const result = AuditInputSchema.safeParse(value);
  if (!result.success) {
    throw new AuditValidationError(result.error.issues.map(toIssue));
  }
  return result.data;
}
