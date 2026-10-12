/**
 * Verdict core — deterministic, pure and fail-closed.
 *
 * `evaluateAudit` validates its input through the contracts boundary and then
 * folds criteria + evidence into an `AuditReport`. It performs no I/O, reads no
 * clock and uses no randomness, so identical input always produces identical
 * output.
 *
 * Trust rules (fail-closed):
 *   - only `RUNNER_CAPTURED` evidence is decisive; model assertions and imported
 *     logs are recorded as observations but never support or contradict;
 *
 * ## Provenance caller contract (not authentication)
 *
 * This reducer is pure and does no I/O, so it *cannot* authenticate anything.
 * `origin: "RUNNER_CAPTURED"` is an **assertion by the caller**, not proof.
 * Callers must only pass that origin when a trusted, verifier-owned capture
 * authority produced the record; the pure core trusts the label by contract and
 * documents that it is unauthenticated. The evidence-store replay (`report.ts`)
 * is the enforcing caller: it downgrades every untrusted record before entering
 * this core and re-derives artifact predicates from registered snapshot bytes.
 * Independently of that, this core refuses to let a static `ARTIFACT`
 * observation support a criterion that registers no byte-level predicate, so a
 * semantic artifact requirement can never be satisfied by merely claiming
 * `RUNNER_CAPTURED` through the public `evaluateAudit`/`evaluateUnknownAudit`
 * boundary.
 *
 *   - an execution-required criterion can only be supported by execution
 *     evidence; artifact/static evidence cannot certify execution;
 *   - only `COMPLETED` + `PASS` supports and only `COMPLETED` + `FAIL`
 *     contradicts; skipped/timeout/cancelled/failed checks never support;
 *   - process (`EXECUTION`) support additionally requires a clean `exitCode: 0`
 *     receipt: a missing or nonzero exit never supports, and a nonzero exit is
 *     not by itself a requirement contradiction (that needs explicit `FAIL`
 *     attribution);
 *   - exit 0 with an `UNKNOWN` result is not requirement-specific acceptance;
 *   - a suite-completeness criterion additionally needs reconciled discovery
 *     counts (`collected > 0`, `passed > 0`, `failed === 0`, no unapproved
 *     skips); a bare "known" label is never enough;
 *   - evidence bound to another task/candidate/revision makes the report STALE;
 *   - waivers annotate but never promote a state or the overall verdict.
 */

import {
  AUDIT_SCHEMA_VERSION,
  AuditValidationError,
  parseAuditInput,
  type AcceptanceType,
  type AuditInput,
  type AuditScope,
  type AuditValidationIssue,
  type Claim,
  type Criterion,
  type EvidenceKind,
  type EvidenceOrigin,
  type EvidenceRecord,
  type Span,
  type Waiver,
} from "./contracts.js";

/** Per-criterion / per-claim state. */
export type CriterionState = "SUPPORTED" | "CONTRADICTED" | "UNVERIFIED" | "BLOCKED";

/** Overall report outcome. */
export type OverallVerdict =
  | "VERIFIED_WITHIN_SCOPE"
  | "NOT_COMPLETE"
  | "INCOMPLETE_EVIDENCE"
  | "STALE";

/** The candidate identity an audit is pinned to. */
export interface AuditIdentity {
  taskId: string;
  taskRevision: string;
  candidateId: string;
}

/** Resolved verdict for one acceptance criterion. */
export interface CriterionResult {
  id: string;
  required: boolean;
  acceptanceType: AcceptanceType;
  state: CriterionState;
  /** Check IDs of trusted, non-stale evidence mapped to this criterion. */
  evidenceCheckIds: string[];
  /** Machine-readable explanation codes (stable, reportable). */
  reasons: string[];
  /** True if a waiver annotates this criterion (annotation, not proof). */
  waived: boolean;
}

/** Resolved verdict for one agent claim. */
export interface ClaimResult {
  id: string;
  span: Span;
  criterionIds: string[];
  state: CriterionState;
  reasons: string[];
}

/** Evidence that is recorded but not decisive for the verdict. */
export interface Observation {
  checkId: string;
  origin: EvidenceOrigin;
  criterionIds: string[];
  note: string;
}

export interface AuditReport {
  schemaVersion: number;
  /** False when the input failed validation; such reports never verify. */
  valid: boolean;
  overall: OverallVerdict;
  identity: AuditIdentity | null;
  scope: AuditScope | null;
  criteria: CriterionResult[];
  claims: ClaimResult[];
  waivers: Waiver[];
  observations: Observation[];
  reasons: string[];
  errors: AuditValidationIssue[];
}

const TRUSTED_ORIGIN: EvidenceOrigin = "RUNNER_CAPTURED";

function isStale(record: EvidenceRecord, identity: AuditIdentity): boolean {
  return (
    record.taskId !== identity.taskId ||
    record.candidateId !== identity.candidateId ||
    record.taskRevision !== identity.taskRevision
  );
}

/**
 * An execution-required criterion accepts only execution evidence. An artifact
 * (bounded static) criterion accepts artifact evidence, and execution evidence
 * is a strictly stronger way to demonstrate the same bounded condition.
 */
function kindCompatible(acceptanceType: AcceptanceType, kind: EvidenceKind): boolean {
  if (acceptanceType === "EXECUTION") return kind === "EXECUTION";
  return kind === "ARTIFACT" || kind === "EXECUTION";
}

/**
 * A static `ARTIFACT` observation is only decisive for an `ARTIFACT` criterion
 * that registers an explicit byte-level predicate (`artifactExpectation`). The
 * pure core cannot re-read bytes, so without a registered predicate a semantic
 * artifact claim can never be promoted by a claimed origin — this closes the
 * direct `evaluateUnknownAudit`/`RUNNER_CAPTURED` bypass. Execution evidence for
 * an artifact criterion is governed by the separate execution path.
 */
function artifactPredicateBound(criterion: Criterion, kind: EvidenceKind): boolean {
  if (kind !== "ARTIFACT") return true;
  return criterion.artifactExpectation !== undefined;
}

function isCompletedPass(record: EvidenceRecord): boolean {
  return record.completion === "COMPLETED" && record.result === "PASS";
}

function isCompletedFail(record: EvidenceRecord): boolean {
  return record.completion === "COMPLETED" && record.result === "FAIL";
}

/**
 * Process execution is narrowly defined here: a support-capable execution
 * receipt must show a clean process exit. Artifact evidence is a static
 * observation and carries no process exit. Non-process (e.g. HTTP) channels are
 * a later, versioned concern and must not be smuggled in by making execution
 * exit optional for everyone.
 */
function processExitProblem(record: EvidenceRecord): "PROCESS_EXIT_MISSING" | "PROCESS_EXIT_NONZERO" | null {
  if (record.kind !== "EXECUTION") return null;
  if (record.exitCode === undefined) return "PROCESS_EXIT_MISSING";
  if (record.exitCode !== 0) return "PROCESS_EXIT_NONZERO";
  return null;
}

function processExitSatisfied(record: EvidenceRecord): boolean {
  return processExitProblem(record) === null;
}

/**
 * Suite completeness is decided from reconciled counts, never a bare label.
 * Meaningful completeness requires at least one collected and one passing test,
 * no failures, and no unapproved skips. `approvedSkips` records skips a human
 * explicitly accepted; all other skips keep the criterion unverified.
 */
function suiteRequirementSatisfied(criterion: Criterion, record: EvidenceRecord): boolean {
  if (criterion.requiresSuiteCompleteness !== true) return true;
  const counts = record.discovery;
  if (counts === undefined) return false;
  const approved = counts.approvedSkips ?? 0;
  return (
    counts.collected > 0 &&
    counts.passed > 0 &&
    counts.failed === 0 &&
    counts.skipped - approved === 0
  );
}

function resolveCriterion(
  criterion: Criterion,
  evidence: EvidenceRecord[],
  identity: AuditIdentity,
  waived: boolean,
): CriterionResult {
  const mapped = evidence.filter((record) => record.criterionIds.includes(criterion.id));
  const decisive = mapped.filter(
    (record) => !isStale(record, identity) && record.origin === TRUSTED_ORIGIN,
  );

  const supports = decisive.filter(
    (record) =>
      isCompletedPass(record) &&
      processExitSatisfied(record) &&
      kindCompatible(criterion.acceptanceType, record.kind) &&
      artifactPredicateBound(criterion, record.kind) &&
      suiteRequirementSatisfied(criterion, record),
  );
  const contradicts = decisive.filter(
    (record) =>
      isCompletedFail(record) &&
      kindCompatible(criterion.acceptanceType, record.kind) &&
      artifactPredicateBound(criterion, record.kind),
  );
  const blocked = decisive.filter((record) => record.completion === "BLOCKED");

  let state: CriterionState;
  const reasons: string[] = [];

  for (const record of mapped) {
    if (isStale(record, identity)) reasons.push(`STALE_EVIDENCE_IGNORED:${record.checkId}`);
  }

  if (supports.length > 0 && contradicts.length > 0) {
    state = "CONTRADICTED";
    reasons.push("CONFLICTING_EVIDENCE");
  } else if (supports.length > 0) {
    state = "SUPPORTED";
  } else if (contradicts.length > 0) {
    state = "CONTRADICTED";
  } else if (blocked.length > 0) {
    state = "BLOCKED";
  } else {
    state = "UNVERIFIED";
  }

  if (state === "UNVERIFIED" && decisive.length === 0) {
    reasons.push(mapped.length > 0 ? "ONLY_UNTRUSTED_EVIDENCE" : "NO_EVIDENCE");
  }

  const kindMismatch = decisive.some(
    (record) =>
      record.completion === "COMPLETED" &&
      (record.result === "PASS" || record.result === "FAIL") &&
      !kindCompatible(criterion.acceptanceType, record.kind),
  );
  if (kindMismatch) reasons.push("EVIDENCE_KIND_INCOMPATIBLE");

  const artifactUnbound = decisive.some(
    (record) => record.kind === "ARTIFACT" && !artifactPredicateBound(criterion, record.kind),
  );
  if (artifactUnbound) reasons.push("ARTIFACT_NOT_BOUND");

  const exitProblems = decisive
    .filter((record) => isCompletedPass(record))
    .map((record) => processExitProblem(record));
  if (exitProblems.includes("PROCESS_EXIT_NONZERO")) reasons.push("PROCESS_EXIT_NONZERO");
  if (exitProblems.includes("PROCESS_EXIT_MISSING")) reasons.push("PROCESS_EXIT_MISSING");

  const suiteUnknown = decisive.some(
    (record) => isCompletedPass(record) && !suiteRequirementSatisfied(criterion, record),
  );
  if (suiteUnknown) reasons.push("SUITE_DISCOVERY_UNKNOWN");

  const nonDecisive = decisive.some(
    (record) => record.completion !== "COMPLETED" && record.completion !== "BLOCKED",
  );
  if (nonDecisive && state === "UNVERIFIED") reasons.push("NON_DECISIVE_COMPLETION");

  return {
    id: criterion.id,
    required: criterion.required,
    acceptanceType: criterion.acceptanceType,
    state,
    evidenceCheckIds: decisive.map((record) => record.checkId),
    reasons,
    waived,
  };
}

function resolveClaimState(mapped: CriterionState[]): CriterionState {
  if (mapped.length === 0) return "UNVERIFIED";
  if (mapped.includes("CONTRADICTED")) return "CONTRADICTED";
  if (mapped.includes("BLOCKED")) return "BLOCKED";
  if (mapped.includes("UNVERIFIED")) return "UNVERIFIED";
  return "SUPPORTED";
}

function resolveClaim(claim: Claim, stateById: Map<string, CriterionState>): ClaimResult {
  const mapped: CriterionState[] = [];
  for (const id of claim.criterionIds) {
    const state = stateById.get(id);
    if (state) mapped.push(state);
  }
  return {
    id: claim.id,
    span: claim.span,
    criterionIds: [...claim.criterionIds],
    state: resolveClaimState(mapped),
    reasons: claim.criterionIds.length === 0 ? ["UNMAPPED_CLAIM"] : [],
  };
}

function buildObservations(evidence: EvidenceRecord[]): Observation[] {
  return evidence
    .filter((record) => record.origin !== TRUSTED_ORIGIN)
    .map((record) => ({
      checkId: record.checkId,
      origin: record.origin,
      criterionIds: [...record.criterionIds],
      note:
        record.origin === "MODEL_ASSERTED"
          ? "model assertion is not captured execution evidence"
          : "imported evidence has unknown provenance and is not decisive",
    }));
}

function reduceAudit(input: AuditInput): AuditReport {
  const identity: AuditIdentity = {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    candidateId: input.candidateId,
  };

  const waivedIds = new Set(
    input.waivers
      .map((entry) => entry.criterionId)
      .filter((id): id is string => id !== undefined),
  );

  const criteria = input.criteria.map((criterion) =>
    resolveCriterion(criterion, input.evidence, identity, waivedIds.has(criterion.id)),
  );
  const stateById = new Map(criteria.map((result) => [result.id, result.state]));
  const claims = input.claims.map((claim) => resolveClaim(claim, stateById));

  const hasStale = input.evidence.some((record) => isStale(record, identity));
  const required = criteria.filter((result) => result.required);

  let overall: OverallVerdict;
  const reasons: string[] = [];

  if (hasStale) {
    overall = "STALE";
    reasons.push("IDENTITY_MISMATCH");
  } else if (input.criteria.length === 0) {
    overall = "INCOMPLETE_EVIDENCE";
    reasons.push("NO_CRITERIA");
  } else if (required.length === 0) {
    overall = "INCOMPLETE_EVIDENCE";
    reasons.push("NO_REQUIRED_CRITERIA");
  } else if (required.some((result) => result.state === "CONTRADICTED")) {
    overall = "NOT_COMPLETE";
    reasons.push("REQUIRED_CONTRADICTED");
  } else if (required.every((result) => result.state === "SUPPORTED")) {
    overall = "VERIFIED_WITHIN_SCOPE";
    reasons.push("ALL_REQUIRED_SUPPORTED");
  } else {
    overall = "INCOMPLETE_EVIDENCE";
    reasons.push("REQUIRED_INCOMPLETE");
  }

  return {
    schemaVersion: input.schemaVersion,
    valid: true,
    overall,
    identity,
    scope: input.scope,
    criteria,
    claims,
    waivers: [...input.waivers],
    observations: buildObservations(input.evidence),
    reasons,
    errors: [],
  };
}

/**
 * Evaluate an already-typed input. Because TypeScript types are not a runtime
 * guarantee, the input is re-validated here; invalid input throws
 * `AuditValidationError` rather than producing a trusted report.
 */
export function evaluateAudit(input: AuditInput): AuditReport {
  return reduceAudit(parseAuditInput(input));
}

/**
 * Validated boundary for untrusted runtime input (`unknown`). On validation
 * failure it returns a fail-closed report (`valid: false`, overall
 * `INCOMPLETE_EVIDENCE`) instead of throwing.
 */
export function evaluateUnknownAudit(value: unknown): AuditReport {
  let input: AuditInput;
  try {
    input = parseAuditInput(value);
  } catch (error) {
    const issues =
      error instanceof AuditValidationError
        ? error.issues
        : [{ path: "", code: "unknown", message: String(error) }];
    return {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      valid: false,
      overall: "INCOMPLETE_EVIDENCE",
      identity: null,
      scope: null,
      criteria: [],
      claims: [],
      waivers: [],
      observations: [],
      reasons: ["INPUT_INVALID"],
      errors: issues,
    };
  }
  return reduceAudit(input);
}
