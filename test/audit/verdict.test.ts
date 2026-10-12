/**
 * Task 1 — pure, fail-closed verdict core tests.
 *
 * RED first: every case below is written against the still-absent
 * `src/audit/contracts.ts` and `src/audit/verdict.ts` boundary, so the first run
 * fails to import. GREEN only after the validated contracts and deterministic
 * reducer exist.
 *
 * Design invariants under test:
 *   - untrusted runtime input MUST validate (never trust TS types);
 *   - a plain model assertion never certifies execution;
 *   - artifact/static evidence never certifies an execution-required criterion;
 *   - skipped/nonexecuted/cancelled evidence never supports;
 *   - process execution support additionally requires a clean (exit 0) process
 *     exit; a missing or nonzero exit is never requirement-specific acceptance;
 *   - process failure is only a requirement contradiction when explicitly
 *     attributed (a `FAILED` check is not a requirement contradiction);
 *   - suite completeness needs reconciled discovery counts with collected > 0,
 *     passed > 0, failed == 0 and no unapproved skips — a bare "known" label is
 *     not enough;
 *   - empty/no-required contract never vacuously verifies;
 *   - evidence from another taskId/candidate/revision yields STALE;
 *   - waivers remain annotations, never proof;
 *   - evaluation is pure (no input mutation) and deterministic.
 */

import { describe, expect, test } from "bun:test";
import {
  AUDIT_SCHEMA_VERSION,
  AuditValidationError,
  parseAuditInput,
  type AuditInput,
  type AuditReport,
} from "../../src/audit/contracts.js";
import { evaluateAudit, evaluateUnknownAudit } from "../../src/audit/verdict.js";

type CriterionInput = AuditInput["criteria"][number];
type ClaimInput = AuditInput["claims"][number];
type EvidenceInput = AuditInput["evidence"][number];
type WaiverInput = AuditInput["waivers"][number];

function span(text: string, start = 0) {
  return { text, start, end: start + text.length };
}

function criterion(id: string, over: Partial<CriterionInput> = {}): CriterionInput {
  return {
    id,
    span: span(`criterion ${id}`),
    required: true,
    acceptanceType: "EXECUTION",
    ...over,
  };
}

function claim(id: string, criterionIds: string[], over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    id,
    span: span(`claim ${id}`),
    criterionIds,
    ...over,
  };
}

function evidence(
  checkId: string,
  criterionIds: string[],
  over: Partial<EvidenceInput> = {},
): EvidenceInput {
  const kind = over.kind ?? "EXECUTION";
  return {
    checkId,
    taskId: "task-1",
    candidateId: "cand-1",
    taskRevision: "rev-1",
    criterionIds,
    kind,
    origin: "RUNNER_CAPTURED",
    completion: "COMPLETED",
    result: "PASS",
    // Process execution carries a real process exit; artifact evidence has none.
    ...(kind === "EXECUTION" ? { exitCode: 0 } : {}),
    ...over,
  };
}

type DiscoveryInput = NonNullable<EvidenceInput["discovery"]>;

function discovery(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return { collected: 1, passed: 1, failed: 0, skipped: 0, ...over };
}

function waiver(id: string, over: Partial<WaiverInput> = {}): WaiverInput {
  return {
    id,
    reason: "accepted residual risk",
    ...over,
  };
}

function baseInput(over: Partial<AuditInput> = {}): AuditInput {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    taskId: "task-1",
    taskRevision: "rev-1",
    candidateId: "cand-1",
    scope: { description: "repository task" },
    criteria: [criterion("R1")],
    claims: [],
    evidence: [evidence("chk-1", ["R1"])],
    waivers: [],
    ...over,
  };
}

function criterionState(report: AuditReport, id: string) {
  return report.criteria.find((c) => c.id === id)?.state;
}

function claimState(report: AuditReport, id: string) {
  return report.claims.find((c) => c.id === id)?.state;
}

function expectInvalid(value: unknown) {
  const report = evaluateUnknownAudit(value);
  expect(report.valid).toBe(false);
  expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  expect(report.errors.length).toBeGreaterThan(0);
  return report;
}

describe("evaluateAudit overall verdicts", () => {
  test("missing required evidence yields INCOMPLETE_EVIDENCE", () => {
    const report = evaluateAudit(baseInput({ evidence: [] }));
    expect(report.valid).toBe(true);
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
  });

  test("required contradiction yields NOT_COMPLETE", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { result: "FAIL" })],
      }),
    );
    expect(report.overall).toBe("NOT_COMPLETE");
    expect(criterionState(report, "R1")).toBe("CONTRADICTED");
  });

  test("all required supported within bounded conditions yields VERIFIED_WITHIN_SCOPE", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [
          criterion("R1", { acceptanceType: "EXECUTION" }),
          criterion("R2", {
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
          }),
        ],
        evidence: [
          evidence("chk-1", ["R1"], { kind: "EXECUTION", result: "PASS", exitCode: 0 }),
          evidence("chk-2", ["R2"], { kind: "ARTIFACT", result: "PASS" }),
        ],
      }),
    );
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
    expect(criterionState(report, "R2")).toBe("SUPPORTED");
  });

  test("stale candidate identity yields STALE", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { candidateId: "cand-2" })],
      }),
    );
    expect(report.overall).toBe("STALE");
  });

  test("task-revision mismatch yields STALE", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { taskRevision: "rev-2" })],
      }),
    );
    expect(report.overall).toBe("STALE");
  });

  test("empty criteria never vacuously verifies", () => {
    const report = evaluateAudit(baseInput({ criteria: [], evidence: [] }));
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });

  test("no required criteria never vacuously verifies", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { required: false })],
        evidence: [evidence("chk-1", ["R1"])],
      }),
    );
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
  });

  test("optional unsupported claim is visible but does not fail mandatory work", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1"), criterion("R2", { required: false })],
        claims: [claim("C1", ["R2"])],
        evidence: [evidence("chk-1", ["R1"])],
      }),
    );
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
    expect(criterionState(report, "R2")).toBe("UNVERIFIED");
    expect(claimState(report, "C1")).toBe("UNVERIFIED");
    expect(report.claims.some((c) => c.id === "C1")).toBe(true);
  });

  test("waiver never converts a criterion to SUPPORTED nor the overall to verified", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [],
        waivers: [waiver("W1", { criterionId: "R1" })],
      }),
    );
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.waivers).toHaveLength(1);
    expect(report.criteria.find((c) => c.id === "R1")?.waived).toBe(true);
  });

  test("waiver does not rescue a contradicted required criterion", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { result: "FAIL" })],
        waivers: [waiver("W1", { criterionId: "R1" })],
      }),
    );
    expect(report.overall).toBe("NOT_COMPLETE");
    expect(criterionState(report, "R1")).toBe("CONTRADICTED");
  });

  test("blocked required check yields BLOCKED criterion and INCOMPLETE_EVIDENCE overall", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-1", ["R1"], { completion: "BLOCKED", result: "UNKNOWN" }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("BLOCKED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });
});

describe("evidence trust and type boundaries", () => {
  test("model-asserted execution evidence cannot certify execution", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-1", ["R1"], {
            origin: "MODEL_ASSERTED",
            kind: "EXECUTION",
            result: "PASS",
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).not.toBe("SUPPORTED");
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.observations.some((o) => o.checkId === "chk-1")).toBe(true);
  });

  test("imported evidence cannot certify a criterion", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { origin: "IMPORTED", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(report.observations.some((o) => o.checkId === "chk-1")).toBe(true);
  });

  test("skipped evidence never supports", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { completion: "SKIPPED", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });

  test("timed-out evidence never supports", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { completion: "TIMEOUT", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
  });

  test("cancelled evidence never supports", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { completion: "CANCELLED", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
  });

  test("check-process failure does not contradict the requirement", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [evidence("chk-1", ["R1"], { completion: "FAILED", result: "FAIL" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });

  test("process exit 0 alone does not prove requirement-specific acceptance", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-1", ["R1"], { result: "UNKNOWN", exitCode: 0 }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("artifact evidence cannot support an execution-required criterion", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { acceptanceType: "EXECUTION" })],
        evidence: [evidence("chk-1", ["R1"], { kind: "ARTIFACT", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("artifact evidence can support a bounded artifact condition", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [
          criterion("R1", {
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
          }),
        ],
        evidence: [evidence("chk-1", ["R1"], { kind: "ARTIFACT", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("an unbound semantic artifact criterion is never supported by a claimed capture", () => {
    const report = evaluateUnknownAudit(
      baseInput({
        criteria: [criterion("R1", { acceptanceType: "ARTIFACT" })],
        evidence: [evidence("chk-1", ["R1"], { kind: "ARTIFACT", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.criteria[0]?.reasons).toContain("ARTIFACT_NOT_BOUND");
  });

  test("missing suite discovery cannot assert suite completeness", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [evidence("chk-1", ["R1"], { result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("counted suite discovery with a passing run supports a suite-completeness criterion", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            result: "PASS",
            discovery: discovery({ collected: 5, passed: 5, failed: 0, skipped: 0 }),
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("a same-process nondecisive run (COMPLETED/INCONCLUSIVE with green counts) cannot support suite completeness", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            result: "INCONCLUSIVE",
            discovery: discovery({ collected: 5, passed: 5, failed: 0, skipped: 0 }),
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("contradictory pass and fail records do not silently resolve to success", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-pass", ["R1"], { result: "PASS" }),
          evidence("chk-fail", ["R1"], { result: "FAIL" }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).not.toBe("SUPPORTED");
    expect(criterionState(report, "R1")).toBe("CONTRADICTED");
    expect(report.overall).toBe("NOT_COMPLETE");
  });
});

describe("round-1 repair: process exit, suite counts and task identity", () => {
  test("completed PASS with nonzero process exit cannot support", () => {
    const report = evaluateAudit(
      baseInput({ evidence: [evidence("chk-1", ["R1"], { result: "PASS", exitCode: 1 })] }),
    );
    expect(criterionState(report, "R1")).not.toBe("SUPPORTED");
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(report.criteria[0]?.reasons).toContain("PROCESS_EXIT_NONZERO");
  });

  test("missing process exit cannot support an execution criterion", () => {
    const record = evidence("chk-1", ["R1"]);
    delete (record as { exitCode?: number }).exitCode;
    const report = evaluateAudit(baseInput({ evidence: [record] }));
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(report.criteria[0]?.reasons).toContain("PROCESS_EXIT_MISSING");
  });

  test("a nonzero process exit is not a blanket requirement contradiction", () => {
    const report = evaluateAudit(
      baseInput({ evidence: [evidence("chk-1", ["R1"], { result: "PASS", exitCode: 2 })] }),
    );
    expect(criterionState(report, "R1")).not.toBe("CONTRADICTED");
  });

  test("process-error attribution preserved: a FAILED check is not a requirement contradiction", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-1", ["R1"], { completion: "FAILED", result: "FAIL", exitCode: 1 }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });

  test("explicitly attributed process failure still contradicts", () => {
    const report = evaluateAudit(
      baseInput({
        evidence: [
          evidence("chk-1", ["R1"], { completion: "COMPLETED", result: "FAIL", exitCode: 1 }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("CONTRADICTED");
    expect(report.overall).toBe("NOT_COMPLETE");
  });

  test("valid counted suite pass supports a suite-completeness criterion", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({ collected: 5, passed: 5, failed: 0, skipped: 0 }),
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("zero collected tests cannot certify suite completeness", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], { discovery: discovery({ collected: 0, passed: 0 }) }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
  });

  test("all-skipped suite cannot certify suite completeness", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({ collected: 3, passed: 0, failed: 0, skipped: 3 }),
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
  });

  test("a suite with failures cannot certify suite completeness", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({ collected: 3, passed: 2, failed: 1, skipped: 0 }),
          }),
        ],
      }),
    );
    expect(criterionState(report, "R1")).toBe("UNVERIFIED");
  });

  test("approved skips are allowed but unapproved skips are not", () => {
    const approved = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({
              collected: 4,
              passed: 3,
              failed: 0,
              skipped: 1,
              approvedSkips: 1,
            }),
          }),
        ],
      }),
    );
    expect(criterionState(approved, "R1")).toBe("SUPPORTED");
    expect(approved.overall).toBe("VERIFIED_WITHIN_SCOPE");

    const unapproved = evaluateAudit(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({ collected: 4, passed: 3, failed: 0, skipped: 1 }),
          }),
        ],
      }),
    );
    expect(criterionState(unapproved, "R1")).toBe("UNVERIFIED");
  });

  test("incompatible discovery counts are rejected at the boundary", () => {
    expectInvalid(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({ collected: 3, passed: 2, failed: 2, skipped: 0 }),
          }),
        ],
      }),
    );
  });

  test("approvedSkips greater than skipped is rejected", () => {
    expectInvalid(
      baseInput({
        criteria: [criterion("R1", { requiresSuiteCompleteness: true })],
        evidence: [
          evidence("chk-1", ["R1"], {
            discovery: discovery({
              collected: 3,
              passed: 3,
              failed: 0,
              skipped: 0,
              approvedSkips: 1,
            }),
          }),
        ],
      }),
    );
  });

  test("evidence with a wrong taskId yields STALE, never current verified", () => {
    const report = evaluateAudit(
      baseInput({ evidence: [evidence("chk-1", ["R1"], { taskId: "task-2" })] }),
    );
    expect(report.overall).toBe("STALE");
    expect(report.overall).not.toBe("VERIFIED_WITHIN_SCOPE");
    expect(criterionState(report, "R1")).not.toBe("SUPPORTED");
  });

  test("static artifact evidence still supports without a process exit", () => {
    const report = evaluateAudit(
      baseInput({
        criteria: [
          criterion("R1", {
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
          }),
        ],
        evidence: [evidence("chk-1", ["R1"], { kind: "ARTIFACT", result: "PASS" })],
      }),
    );
    expect(criterionState(report, "R1")).toBe("SUPPORTED");
    expect(report.overall).toBe("VERIFIED_WITHIN_SCOPE");
  });
});

describe("schema validation boundary", () => {
  test("rejects duplicate criterion IDs", () => {
    expectInvalid(baseInput({ criteria: [criterion("R1"), criterion("R1")] }));
  });

  test("rejects duplicate check IDs", () => {
    expectInvalid(
      baseInput({
        evidence: [evidence("chk-1", ["R1"]), evidence("chk-1", ["R1"])],
      }),
    );
  });

  test("rejects duplicate claim IDs", () => {
    expectInvalid(baseInput({ claims: [claim("C1", ["R1"]), claim("C1", ["R1"])] }));
  });

  test("rejects unknown criterion references in evidence", () => {
    expectInvalid(baseInput({ evidence: [evidence("chk-1", ["MISSING"])] }));
  });

  test("rejects unknown criterion references in claims", () => {
    expectInvalid(baseInput({ claims: [claim("C1", ["MISSING"])] }));
  });

  test("rejects unknown criterion references in waivers", () => {
    expectInvalid(baseInput({ waivers: [waiver("W1", { criterionId: "MISSING" })] }));
  });

  test("rejects invalid evidence statuses", () => {
    expectInvalid(baseInput({ evidence: [evidence("chk-1", ["R1"], { completion: "MAYBE" as never })] }));
    expectInvalid(baseInput({ evidence: [evidence("chk-1", ["R1"], { result: "OK" as never })] }));
    expectInvalid(baseInput({ evidence: [evidence("chk-1", ["R1"], { origin: "TRUST_ME" as never })] }));
    expectInvalid(baseInput({ evidence: [evidence("chk-1", ["R1"], { kind: "VIBES" as never })] }));
  });

  test("rejects missing scope", () => {
    const { scope: _scope, ...rest } = baseInput();
    expectInvalid(rest);
  });

  test("rejects malformed scope", () => {
    expectInvalid(baseInput({ scope: { description: "" } }));
    expectInvalid(baseInput({ scope: "everything" as never }));
  });

  test("rejects malformed span", () => {
    expectInvalid(
      baseInput({ criteria: [criterion("R1", { span: { text: "abc", start: 0, end: 2 } })] }),
    );
  });

  test("rejects unsupported schema version", () => {
    expectInvalid(baseInput({ schemaVersion: 999 as never }));
  });

  test("validates the optional artifactExpectation field", () => {
    const parsed = parseAuditInput(
      baseInput({
        criteria: [
          criterion("R1", {
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
          }),
        ],
      }),
    );
    expect(parsed.criteria[0]!.artifactExpectation?.path).toBe("artifact.txt");

    // presence/digest must agree
    expectInvalid(
      baseInput({
        criteria: [
          criterion("R1", {
            acceptanceType: "ARTIFACT",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: null },
          }),
        ],
      }),
    );
    // a predicate on an execution criterion is meaningless
    expectInvalid(
      baseInput({
        criteria: [
          criterion("R1", {
            acceptanceType: "EXECUTION",
            artifactExpectation: { path: "artifact.txt", presence: "present", digest: "a".repeat(64) },
          }),
        ],
      }),
    );
  });

  test("redacted spans record original offsets separately", () => {
    const display = "[REDACTED:assigned-secret]";
    const parsed = parseAuditInput(
      baseInput({
        criteria: [
          criterion("R1", {
            span: {
              text: display,
              start: 0,
              end: display.length,
              redacted: true,
              originalStart: 0,
              originalEnd: 40,
            },
          }),
        ],
      }),
    );
    expect(parsed.criteria[0]!.span.redacted).toBe(true);
    expect(parsed.criteria[0]!.span.originalStart).toBe(0);
    expect(parsed.criteria[0]!.span.originalEnd).toBe(40);

    // A redacted span must not omit its original offsets.
    expectInvalid(
      baseInput({
        criteria: [
          criterion("R1", {
            span: { text: display, start: 0, end: display.length, redacted: true },
          }),
        ],
      }),
    );
    // Original offsets are invalid when nothing was redacted.
    expectInvalid(
      baseInput({
        criteria: [
          criterion("R1", { span: { text: "abc", start: 0, end: 3, originalStart: 0, originalEnd: 5 } }),
        ],
      }),
    );
  });

  test("rejects non-object input", () => {
    expectInvalid(null);
    expectInvalid("not an audit");
    expectInvalid(42);
  });

  test("rejects unknown boundary keys", () => {
    expectInvalid({ ...baseInput(), injected: "trust me" });
  });

  test("evaluateAudit throws AuditValidationError on invalid input", () => {
    expect(() => evaluateAudit(baseInput({ criteria: [criterion("R1"), criterion("R1")] }))).toThrow(
      AuditValidationError,
    );
  });

  test("parseAuditInput returns a normalized, typed input", () => {
    const parsed = parseAuditInput(baseInput());
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.schemaVersion).toBe(AUDIT_SCHEMA_VERSION);
  });

  test("evaluateUnknownAudit fails closed on invalid input", () => {
    const report = evaluateUnknownAudit({ nonsense: true });
    expect(report.valid).toBe(false);
    expect(report.overall).toBe("INCOMPLETE_EVIDENCE");
    expect(report.identity).toBeNull();
    expect(report.criteria).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

describe("purity and determinism", () => {
  test("does not mutate the original input", () => {
    const input = baseInput({
      criteria: [
        criterion("R1"),
        criterion("R2", { required: false, acceptanceType: "ARTIFACT" }),
      ],
      claims: [claim("C1", ["R2"])],
      evidence: [
        evidence("chk-1", ["R1"]),
        evidence("chk-2", ["R2"], { kind: "ARTIFACT" }),
      ],
    });
    const before = JSON.stringify(input);
    deepFreeze(input);
    expect(() => evaluateAudit(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  test("is deterministic across repeated calls", () => {
    const input = baseInput({
      criteria: [criterion("R1"), criterion("R2", { required: false })],
      claims: [claim("C1", ["R2"])],
      evidence: [evidence("chk-1", ["R1"])],
    });
    const first = JSON.stringify(evaluateAudit(input));
    const second = JSON.stringify(evaluateAudit(input));
    expect(second).toBe(first);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
