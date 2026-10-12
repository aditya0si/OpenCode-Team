/**
 * Task 3 — deterministic replay and readable, replayable report rendering.
 *
 * `replayAudit` is a pure reduction: it maps the stored records back through the
 * Task 1 verdict core and produces an `AuditReport` document. It reads no clock,
 * no randomness and no network, so the same `AuditRecords` always produces the
 * same document. It fails closed (overall `INCOMPLETE_EVIDENCE`, `valid: false`)
 * whenever trust cannot be reconstructed: no binding, a broken hash chain, an
 * invalid snapshot copy, or input the verdict core rejects.
 *
 * Rendering treats **all** task/claim/criterion text and evidence output as
 * untrusted. Those values are only ever emitted inside HTML-escaped `<pre>`
 * blocks or `|`-escaped table cells, so injected markdown headings, HTML, code
 * fences and link targets cannot masquerade as verifier conclusions. The real
 * status sections are generated deterministically from the reduced verdict, and
 * the JSON and Markdown forms reference exactly the same evidence IDs and scope.
 */

import {
  AUDIT_SCHEMA_VERSION,
  type AuditInput,
  type Criterion,
  type Claim,
  type EvidenceOrigin,
  type EvidenceRecord,
  type AuditScope,
  type Span,
} from "./contracts.js";
import {
  evaluateAudit,
  type AuditReport as VerdictReport,
  type ClaimResult,
  type CriterionResult,
  type Observation,
} from "./verdict.js";
import {
  EVIDENCE_STORE_SCHEMA_VERSION,
  STORE_TRUST_ASSUMPTION,
  type AuditRecords,
  type ArtifactRef,
  type BoundTask,
  type RecordOutput,
  type StoredRecordView,
} from "./evidence-store.js";

export const REPORT_SCHEMA_VERSION = 1;

export interface ReportStore {
  storeId: string;
  schemaVersion: number;
  policyVersion: number;
  createdInSession: boolean;
  reconstruction: "created" | "reopened";
  lifecycle: "OPEN" | "CANCELLED";
  chainValid: boolean;
  chainLength: number;
  chainHead: string;
  copyValid: boolean;
}

export interface ReportSnapshot {
  candidateId: string;
  baseRevision: string | null;
  delta: true;
  partial: boolean;
  fileCount: number;
  policyVersion: number;
  copyValid: boolean;
}

export interface ReportTask {
  taskId: string;
  taskRevision: string;
  candidateId: string;
  scope: AuditScope;
  statement: string;
  criteria: Criterion[];
  claims: Claim[];
  snapshot: ReportSnapshot;
}

export interface ReportEvidenceRecord {
  checkId: string;
  taskId: string;
  taskRevision: string;
  candidateId: string;
  criterionIds: string[];
  kind: string;
  claimedOrigin: EvidenceOrigin;
  effectiveOrigin: EvidenceOrigin;
  provenance: "CAPTURED" | "IMPORTED";
  trusted: boolean;
  trustReasons: string[];
  terminal: boolean;
  terminalReason?: string;
  completion: string;
  result: string;
  discovery: StoredRecordView["discovery"];
  exitCode?: number;
  signal?: string;
  argv: string[];
  cwd?: string;
  startedAt?: string;
  endedAt?: string;
  runner?: string;
  snapshotCandidateId?: string;
  artifact?: ArtifactRef;
  output: RecordOutput | null;
  referencedOutputs: string[];
  environment: Record<string, string>;
  source?: string;
  limitations: string[];
  redactions: string[];
  sequence: number;
  previousHash: string;
  hash: string;
}

export interface ReportExclusion {
  path: string;
  reason: string;
  detail?: string;
  size?: number;
}

export interface AuditReport {
  reportSchemaVersion: number;
  evidenceStoreSchemaVersion: number;
  valid: boolean;
  store: ReportStore;
  task: ReportTask | null;
  verdict: VerdictReport;
  records: ReportEvidenceRecord[];
  observations: Observation[];
  exclusions: ReportExclusion[];
  limitations: string[];
  trust: {
    trustedExecutionCaptures: number;
    note: string;
  };
  errors: string[];
}

const OVERALL_LINE_PREFIX = "Overall: **";

function buildObservations(records: StoredRecordView[]): Observation[] {
  return records
    .filter((record) => record.effectiveOrigin !== "RUNNER_CAPTURED")
    .map((record) => ({
      checkId: record.checkId,
      origin: record.effectiveOrigin,
      criterionIds: [...record.criterionIds],
      note:
        record.effectiveOrigin === "MODEL_ASSERTED"
          ? "model assertion is not captured execution evidence"
          : "imported/uncaptured record is not decisive",
    }));
}

function toEvidenceRecord(record: StoredRecordView): EvidenceRecord {
  const evidence: EvidenceRecord = {
    checkId: record.checkId,
    taskId: record.taskId,
    candidateId: record.candidateId,
    taskRevision: record.taskRevision,
    criterionIds: [...record.criterionIds],
    kind: record.kind,
    origin: record.effectiveOrigin,
    completion: record.completion,
    result: record.result,
  };
  if (record.discovery !== undefined) evidence.discovery = record.discovery;
  if (record.exitCode !== undefined) evidence.exitCode = record.exitCode;
  if (record.source !== undefined) evidence.source = record.source;
  if (record.limitations.length > 0) evidence.limitations = [...record.limitations];
  return evidence;
}

function failClosedVerdict(records: AuditRecords, reason: string): VerdictReport {
  const task = records.task;
  const criteria: CriterionResult[] = (task?.criteria ?? []).map((criterion) => ({
    id: criterion.id,
    required: criterion.required,
    acceptanceType: criterion.acceptanceType,
    state: "UNVERIFIED",
    evidenceCheckIds: [],
    reasons: [reason],
    waived: false,
  }));
  const claims: ClaimResult[] = (task?.claims ?? []).map((claim) => ({
    id: claim.id,
    span: claim.span,
    criterionIds: [...claim.criterionIds],
    state: "UNVERIFIED",
    reasons: [reason],
  }));
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    valid: false,
    overall: "INCOMPLETE_EVIDENCE",
    identity: task
      ? { taskId: task.taskId, taskRevision: task.taskRevision, candidateId: task.candidateId }
      : null,
    scope: task?.scope ?? null,
    criteria,
    claims,
    waivers: [],
    observations: buildObservations(records.records),
    reasons: [reason],
    errors: [],
  };
}

function mapRecord(record: StoredRecordView): ReportEvidenceRecord {
  return {
    checkId: record.checkId,
    taskId: record.taskId,
    taskRevision: record.taskRevision,
    candidateId: record.candidateId,
    criterionIds: [...record.criterionIds],
    kind: record.kind,
    claimedOrigin: record.claimedOrigin,
    effectiveOrigin: record.effectiveOrigin,
    provenance: record.provenance,
    trusted: record.trusted,
    trustReasons: [...record.trustReasons],
    terminal: record.terminal,
    terminalReason: record.terminalReason,
    completion: record.completion,
    result: record.result,
    discovery: record.discovery,
    exitCode: record.exitCode,
    signal: record.signal,
    argv: [...record.argv],
    cwd: record.cwd,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    runner: record.runner,
    snapshotCandidateId: record.snapshotCandidateId,
    artifact: record.artifact,
    output: record.output,
    referencedOutputs: [...record.referencedOutputs],
    environment: { ...record.environment },
    source: record.source,
    limitations: [...record.limitations],
    redactions: [...record.redactions],
    sequence: record.sequence,
    previousHash: record.previousHash,
    hash: record.hash,
  };
}

const TRUST_NOTE =
  "No execution runner exists in this task, so there are zero trusted execution captures. " +
  "Only a verifier-owned static artifact observation can ever be captured, and a public receipt is always imported.";

function buildReport(
  records: AuditRecords,
  verdict: VerdictReport,
  valid: boolean,
  errors: string[],
): AuditReport {
  const task = records.task;
  const reportTask: ReportTask | null = task
    ? {
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        candidateId: task.candidateId,
        scope: task.scope,
        statement: task.statement,
        criteria: task.criteria,
        claims: task.claims,
        snapshot: {
          candidateId: task.candidateId,
          baseRevision: task.snapshot.base.revision,
          delta: task.snapshot.scope.delta,
          partial: task.snapshot.scope.partial,
          fileCount: task.snapshot.files.length,
          policyVersion: task.snapshot.policyVersion,
          copyValid: records.integrity.copyValid,
        },
      }
    : null;

  const exclusions: ReportExclusion[] = task
    ? task.snapshot.exclusions.map((entry) => ({
        path: entry.path,
        reason: entry.reason,
        detail: entry.detail,
        size: entry.size,
      }))
    : [];

  const trustedExecutionCaptures = records.records.filter(
    (record) => record.effectiveOrigin === "RUNNER_CAPTURED" && record.kind === "EXECUTION",
  ).length;

  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    evidenceStoreSchemaVersion: EVIDENCE_STORE_SCHEMA_VERSION,
    valid,
    store: {
      storeId: records.storeId,
      schemaVersion: records.schemaVersion,
      policyVersion: records.policyVersion,
      createdInSession: records.session.createdInSession,
      reconstruction: records.session.reconstruction,
      lifecycle: records.lifecycle,
      chainValid: records.integrity.chainValid,
      chainLength: records.integrity.chainLength,
      chainHead: records.integrity.chainHead,
      copyValid: records.integrity.copyValid,
    },
    task: reportTask,
    verdict,
    records: records.records.map(mapRecord),
    observations: verdict.observations,
    exclusions,
    limitations: [
      ...new Set([
        STORE_TRUST_ASSUMPTION,
        "Snapshot evidence is a delta capture (scope.delta is true): it never observes unchanged tracked bytes or excluded paths.",
        "Snapshot captured bytes are re-hashed from the registered copy before artifact evidence is relied on; the unsigned manifest alone is insufficient.",
        "Snapshot capture assumes a trusted verifier-owned output parent and is best-effort, not sandbox-grade containment against a concurrent hostile filesystem.",
        "Secret exclusion and output redaction are pattern-based defence in depth, not a guarantee that a non-obvious secret was removed.",
        "An ARTIFACT criterion is only supported by a store-owned observation that matches its registered byte-level predicate (exact path, presence and digest); a criterion without a predicate can never be satisfied by static bytes.",
        "The pure verdict core independently refuses to let a static ARTIFACT observation support a criterion that registers no byte-level predicate, so a claimed RUNNER_CAPTURED origin cannot bypass predicate binding.",
        "Metadata head updates are best-effort and crash-recoverable, not an atomic multi-file replacement and not durable without an fsync. A fully-written temp file is published by rename, or — where a platform refuses replace-existing — by a recoverable swap. Both the live head and any swap backup are independently validated against the metadata schema before either is discarded or promoted, so a corrupt primary never erases a valid last head; an interrupted update is reconciled on the next read and any orphan record is reported as an explicit chain inconsistency.",
        "Cancellation is a store-level terminal state: after a cancelled check is recorded, no further checks may be appended, and the cancelled check never supports a requirement.",
        "Hash-chain integrity is an integrity check only; it does not authenticate that any capture ran in a trusted process. Artifact trust is reconstructed from the registered snapshot copy on every read.",
        ...records.limitations,
      ]),
    ],
    trust: { trustedExecutionCaptures, note: TRUST_NOTE },
    errors,
  };
}

/**
 * Deterministically reduce stored records to a report. Fails closed when the
 * store's trust cannot be reconstructed.
 */
export function replayAudit(records: AuditRecords): AuditReport {
  if (!records.task) {
    return buildReport(records, failClosedVerdict(records, "NO_BINDING"), false, ["NO_BINDING"]);
  }
  if (!records.integrity.chainValid) {
    return buildReport(records, failClosedVerdict(records, "HASH_CHAIN_INVALID"), false, [
      "HASH_CHAIN_INVALID",
      ...records.integrity.errors,
    ]);
  }
  if (!records.integrity.copyValid) {
    return buildReport(records, failClosedVerdict(records, "SNAPSHOT_COPY_INVALID"), false, [
      "SNAPSHOT_COPY_INVALID",
      ...records.integrity.errors,
    ]);
  }

  try {
    const input: AuditInput = {
      schemaVersion: AUDIT_SCHEMA_VERSION,
      taskId: records.task.taskId,
      taskRevision: records.task.taskRevision,
      candidateId: records.task.candidateId,
      scope: records.task.scope,
      criteria: records.task.criteria,
      claims: records.task.claims,
      evidence: records.records.map(toEvidenceRecord),
      waivers: [],
    };
    const verdict = evaluateAudit(input);
    return buildReport(records, verdict, verdict.valid, []);
  } catch {
    return buildReport(records, failClosedVerdict(records, "REPLAY_INVALID"), false, [
      "REPLAY_INVALID",
    ]);
  }
}

// ---------------------------------------------------------------------------
// Rendering (untrusted content is always escaped)
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pre(value: string): string {
  return `<pre>${escapeHtml(value)}</pre>`;
}

function cell(value: string): string {
  return escapeHtml(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Render a span's display text and, when it was redacted, an explicit note that
 * the shown text is a redaction with separately-recorded original offsets — so
 * a replacement is never passed off as the exact original span.
 */
function spanBlock(span: Span): string {
  if (span.redacted) {
    return (
      `${pre(span.text)}` +
      `\n  _redacted display: original span offsets ${span.originalStart}..${span.originalEnd}; ` +
      `the shown text is a redaction, not the exact original span._`
    );
  }
  return pre(span.text);
}

/** Acceptance label including any registered byte-level artifact predicate. */
function acceptanceLabel(criterion: Criterion | undefined): string {
  if (!criterion) return "UNKNOWN";
  if (criterion.artifactExpectation) {
    const expectation = criterion.artifactExpectation;
    const digest = expectation.digest ? ` ${expectation.digest}` : "";
    return `${criterion.acceptanceType} (predicate: ${cell(expectation.path)} ${expectation.presence}${digest})`;
  }
  return criterion.acceptanceType;
}

function trustedList(values: string[]): string {
  if (values.length === 0) return "_none_";
  return values.map((value) => `\n  ${escapeHtml(value)}`).join("");
}

/** Render the deterministic report document as Markdown. */
export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const criterionById = new Map((report.task?.criteria ?? []).map((c) => [c.id, c]));
  lines.push("# Completion Audit Report", "");
  lines.push(`${OVERALL_LINE_PREFIX}${report.verdict.overall}**`, "");
  if (!report.valid) {
    lines.push("> Integrity/trust could not be reconstructed; this report fails closed.", "");
  }

  lines.push("## Scope", "");
  lines.push(`- store id: \`${report.store.storeId}\``);
  lines.push(`- reconstruction: ${report.store.reconstruction}`);
  if (report.task) {
    lines.push(`- task: \`${report.task.taskId}\` revision \`${report.task.taskRevision}\``);
    lines.push(`- candidate: \`${report.task.candidateId}\``);
    lines.push(
      `- snapshot: base \`${report.task.snapshot.baseRevision ?? "none"}\`, delta: ${report.task.snapshot.delta}, partial: ${report.task.snapshot.partial}, files: ${report.task.snapshot.fileCount}`,
    );
    lines.push(
      `- scope paths: ${report.task.scope.paths && report.task.scope.paths.length > 0 ? report.task.scope.paths.map((p) => `\`${cell(p)}\``).join(", ") : "_none_"}`,
    );
    lines.push("");
    lines.push("### Task statement", "");
    lines.push(pre(report.task.statement));
    lines.push("");
  }

  lines.push("## Trust and integrity", "");
  lines.push(`- lifecycle: ${report.store.lifecycle}`);
  lines.push(`- hash chain: ${report.store.chainValid ? "valid" : "INVALID"} (length ${report.store.chainLength})`);
  lines.push(`- snapshot copy: ${report.store.copyValid ? "valid" : "INVALID"}`);
  lines.push(`- trusted execution captures: ${report.trust.trustedExecutionCaptures}`);
  lines.push(`- store trust assumption: ${escapeHtml(STORE_TRUST_ASSUMPTION)}`);
  lines.push(`- limitations:${trustedList(report.limitations)}`);
  lines.push("");

  lines.push("## Requirements", "");
  lines.push("| ID | Required | Acceptance | State | Evidence |");
  lines.push("|---|---|---|---|---|");
  if (report.verdict.criteria.length === 0) {
    lines.push("| _none_ | | | | |");
  } else {
    for (const criterion of report.verdict.criteria) {
      lines.push(
        `| \`${criterion.id}\` | ${criterion.required ? "yes" : "no"} | ${acceptanceLabel(criterionById.get(criterion.id))} | ${criterion.state} | ${criterion.evidenceCheckIds.map((id) => `\`${id}\``).join(", ") || "_none_"} |`,
      );
    }
  }
  lines.push("");
  lines.push("### Requirement text", "");
  if (report.task && report.task.criteria.length > 0) {
    for (const criterion of report.task.criteria) {
      lines.push(`- \`${criterion.id}\`:`, spanBlock(criterion.span));
      if (criterion.artifactExpectation) {
        const expectation = criterion.artifactExpectation;
        lines.push(
          `  - registered artifact predicate: path=${cell(expectation.path)} presence=${expectation.presence} digest=${expectation.digest ?? "none"}`,
        );
      }
    }
  } else {
    lines.push("_none_");
  }
  lines.push("");

  lines.push("## Claims", "");
  lines.push("| ID | Criteria | State |");
  lines.push("|---|---|---|");
  if (report.verdict.claims.length === 0) {
    lines.push("| _none_ | | |");
  } else {
    for (const claim of report.verdict.claims) {
      lines.push(
        `| \`${claim.id}\` | ${claim.criterionIds.map((id) => `\`${id}\``).join(", ") || "_none_"} | ${claim.state} |`,
      );
    }
  }
  lines.push("");
  lines.push("### Claim text", "");
  if (report.task && report.task.claims.length > 0) {
    for (const claim of report.task.claims) {
      lines.push(`- \`${claim.id}\`:`, spanBlock(claim.span));
    }
  } else {
    lines.push("_none_");
  }
  lines.push("");

  lines.push("## Evidence", "");
  if (report.records.length === 0) {
    lines.push("_none_");
  } else {
    for (const record of report.records) {
      lines.push(`### \`${record.checkId}\``, "");
      lines.push(`- criteria: ${record.criterionIds.map((id) => `\`${id}\``).join(", ") || "_none_"}`);
      lines.push(`- kind: ${record.kind}`);
      lines.push(`- origin: claimed \`${record.claimedOrigin}\` -> effective \`${record.effectiveOrigin}\``);
      lines.push(`- trusted: ${record.trusted ? "yes" : "no"}${record.trustReasons.length > 0 ? ` (${record.trustReasons.join(", ")})` : ""}`);
      lines.push(`- terminal: ${record.terminal ? `yes (${escapeHtml(record.terminalReason ?? "terminal")})` : "no"}`);
      lines.push(`- completion: ${record.completion}`);
      lines.push(`- result: ${record.result}`);
      if (record.exitCode !== undefined) lines.push(`- exit code: ${record.exitCode}`);
      if (record.signal !== undefined) lines.push(`- signal: ${escapeHtml(record.signal)}`);
      if (record.discovery !== undefined) {
        const d = record.discovery;
        lines.push(
          `- discovery: collected=${d.collected}, passed=${d.passed}, failed=${d.failed}, skipped=${d.skipped}, approvedSkips=${d.approvedSkips ?? 0}`,
        );
      }
      if (record.startedAt !== undefined) lines.push(`- started: \`${cell(record.startedAt)}\``);
      if (record.endedAt !== undefined) lines.push(`- ended: \`${cell(record.endedAt)}\``);
      if (record.runner !== undefined) lines.push("- runner:", pre(record.runner));
      if (record.argv.length > 0) lines.push("- argv:", pre(record.argv.join("\n")));
      if (record.cwd !== undefined) lines.push("- cwd:", pre(record.cwd));
      if (record.source !== undefined) lines.push("- source:", pre(record.source));
      if (record.artifact !== undefined) {
        lines.push(
          `- artifact: \`${cell(record.artifact.path)}\` digest=${record.artifact.digest ?? "none"} size=${record.artifact.size ?? "unknown"}`,
        );
      }
      if (record.output === null) {
        lines.push("- output: (no output captured)");
      } else {
        lines.push(
          `- output ref: \`${record.output.ref}\` digest=${record.output.digest} size=${record.output.size} truncated=${record.output.truncated}`,
        );
        lines.push("- output:", pre(record.output.preview));
      }
      if (record.referencedOutputs.length > 0) {
        lines.push(`- referenced outputs: ${record.referencedOutputs.map((r) => `\`${r}\``).join(", ")}`);
      }
      if (record.redactions.length > 0) {
        lines.push(`- redactions applied: ${record.redactions.join(", ")}`);
      }
      if (record.limitations.length > 0) {
        lines.push("- limitations:");
        for (const limitation of record.limitations) lines.push(pre(limitation));
      }
      lines.push(`- integrity: seq=${record.sequence} prev=\`${record.previousHash}\` hash=\`${record.hash}\``);
      lines.push("");
    }
  }

  lines.push("## Observations", "");
  if (report.observations.length === 0) {
    lines.push("_none_");
  } else {
    for (const observation of report.observations) {
      lines.push(
        `- \`${observation.checkId}\` (${observation.origin}): ${escapeHtml(observation.note)}`,
      );
    }
  }
  lines.push("");

  lines.push("## Exclusions", "");
  if (report.exclusions.length === 0) {
    lines.push("_none_");
  } else {
    for (const exclusion of report.exclusions) {
      lines.push(
        `- \`${cell(exclusion.path)}\` (${exclusion.reason}${exclusion.detail ? `: ${cell(exclusion.detail)}` : ""})${exclusion.size !== undefined ? ` size=${exclusion.size}` : ""}`,
      );
    }
  }
  lines.push("");

  lines.push("## Replay", "");
  lines.push(
    "Replay is a deterministic reduction of the stored records through the verdict core. Identical stored records always produce an identical report and identical rendering.",
  );
  lines.push("");

  return `${lines.join("\n")}`;
}

/** Deterministic machine-readable form with the same IDs and scope. */
export function renderJson(report: AuditReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
