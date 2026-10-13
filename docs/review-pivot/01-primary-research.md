# Primary research: independent completion verification for opencode-teamwork

Research cutoff/access date: **October 11, 2026**. Deliverable: research and requirements, not implementation. All external technical claims below cite original papers or official vendor documentation. The source registry is embedded in this file so no separate registry or project files need modification.

## 1. Decision summary

**Proposed concept:** a task-completion evidence auditor, not a committee of LLM reviewers. Input is the user's task, a bounded repository snapshot/diff, the coding agent's completion response, and runner-owned execution evidence. Output is a requirement-by-requirement evidence report with `supported`, `contradicted`, `unverified`, and `blocked` states. This is a design proposal, not an experimentally validated product.

Why investigate this direction:

- CoVe supports separating question planning from independent answering, but its experiments concern factual generation, not executable software acceptance.[1]
- Intrinsic self-correction can fail without external feedback; a second opinion should not be confused with an external oracle.[2]
- Preference-judge agreement and bias studies do not establish software correctness.[3]
- SWE-bench Verified illustrates executable acceptance and regression tests, while also exposing ambiguity and test-oracle limitations.[4]
- Existing products already offer agent-integrated review and independent verification. Merely adding a reviewer agent or a sandbox is not a credible differentiation claim.[8][9][10]

**Working product hypothesis, to validate:** inexpensive, local-first verification of specific completion claims, with provenance and explicit abstention, may complement rather than replace PR review products. No demand, accuracy, novelty, or cost advantage has been demonstrated by this research.

## 2. Evidence conventions and boundaries

- **Empirical:** measurements reported by paper authors within their stated setting; not reproduced here.
- **Documented capability:** vendor describes functionality; not an independent effectiveness measurement.
- **Derived requirement / improvement:** our engineering inference from evidence. It is not a finding of the cited paper.
- **Unknown:** unavailable or not established by inspected material.

Numerical results are historical observations, not October 2026 model rankings. Living docs were accessed at the cutoff; their original publication dates are not inferred from search-engine crawl metadata. Paper versions explicitly identified below are the versions inspected, not claims to have reviewed every revision. No benchmark, competing product, sandbox, or OpenCode hook was executed in this research task. Repository implementation compatibility remains unverified.

## 3. Source-by-source findings, limitations, and derived requirements

### [1] Chain-of-Verification (CoVe): use decomposition, not the name as a guarantee

**Primary evidence — empirical.** Dhuliawala et al. propose draft → verification questions → independent answers → revised response. The inspected September 25, 2023 v2 uses Llama 65B and factual tasks: Wikidata lists, Wikipedia-category lists, closed-book MultiSpanQA, and biographies. Factored answering excludes the original draft and other answers from each answering context. Table 2 reports MultiSpanQA F1 of 0.39 for few-shot baseline versus 0.48 factored CoVe. Table 3 reports biography FactScore 55.9 versus 71.4 factor+revise, with average facts falling from 16.6 to 12.3. The method itself does not use external tools.[1] Sample sizes are small: 56 Wikidata and 55 Wiki-Category list questions, 418 MultiSpanQA questions, and a biography set whose size is not stated in the inspected sections. No confidence intervals were visible in the inspected tables. Re-checked on 2026-10-12 against the v2 HTML: Table 2 (F1 0.39 to 0.48), Table 3 (FactScore 55.9 to 71.4, average facts 16.6 to 12.3) match the figures above.[1]

**Scope/limitation.** Improved factual precision is not proof of complete requirement coverage. These are not repository patch, execution-security, or coding-completion experiments. Independence here means prompt-context separation, not independently trained models or independently sourced facts.[1]

**Derived requirement R1.** Separate acceptance-question planning from evidence answering. Do not show each answerer the agent's persuasive completion narrative. Preserve every original requirement even when there is no answer.

**Actionable improvement.** Two tracks: task-derived questions to detect omissions; response-derived questions to audit explicit claims. Prefer “Which execution record demonstrates that an invalid token returns 401?” over “Did the agent implement authentication correctly?” Reconcile only after evidence retrieval.

### [2] Self-correction limitations: evidence must change, not merely wording

**Primary evidence — empirical.** Huang et al., first submitted October 3, 2023, distinguish intrinsic self-correction from externally informed correction. The inspected v1 studies mathematical, commonsense, and multi-hop QA reasoning, including GPT-3.5-Turbo-0613 and GPT-4. They find intrinsic correction struggles and can degrade answers. Oracle-informed stopping is a materially different experimental condition. Some GPT-4 experiments use sampled evaluation sets for cost reasons.[2]

**Scope/limitation.** This is not a theorem that every model, prompting method, or externally grounded correction fails. It does not directly measure the proposed plugin or modern October 2026 coding agents.[2]

**Derived requirement R2.** A repair retry needs new observable evidence: changed artifact, fresh run, or a clarified requirement. A model's repeated assertion is not additional evidence.

**Actionable improvement.** Default to one evidence plan and one reconciliation pass. After a failed check, give the implementation agent a minimal counterexample; rerun only invalidated checks. Stop when budget is reached and report remaining uncertainty rather than retrying until a model says yes.

### [3] LLM-as-a-judge: preference agreement is not a correctness oracle

**Primary evidence — empirical.** Zheng et al., first submitted June 9, 2023, evaluate LLM judges using MT-bench and Chatbot Arena. The paper reports over 80% agreement with human preferences for strong judges such as GPT-4, and discusses position, verbosity, self-enhancement biases and limited reasoning ability.[3]

**Scope/limitation.** Human-preference alignment for open-ended assistant responses is not proof that an acceptance test passed or that a patch satisfies all requirements. The reported percentage must not be presented as coding-verifier accuracy.[3]

**Derived requirement R3.** Never aggregate model votes into an execution-pass verdict. Separate semantic interpretation from deterministic test and artifact outcomes.

**Actionable improvement.** Hide author/model identity, normalize claim presentation, and evaluate order-swapped and verbose-versus-terse versions of identical evidence. Require evidence references for semantic findings. Permit `unverified` rather than manufacturing confidence from a second judge.

### [4] SWE-bench Verified: executable oracles, but scrutinize the oracle itself

**Primary evidence — empirical/methodology.** OpenAI's August 13, 2024 article, updated February 24, 2025, describes a 500-instance human-screened SWE-bench subset. Issue-resolution patches are evaluated with `FAIL_TO_PASS` tests and `PASS_TO_PASS` regression tests, using a Docker-based harness. Annotation screens for underspecified issues and tests that reject reasonable valid solutions.[4]

**Scope/limitation.** The underlying issues come from Python repositories; this is not a universal benchmark for UI, deployment, security, documentation, or arbitrary product completion. Passing designated tests establishes the benchmark criterion, not exhaustive real-world correctness. Ambiguous tasks and narrow tests affect outcomes.[4]

**Derived requirement R4.** Verify task clarity and test relevance before trusting a pass/fail result. Distinguish changed-behavior checks from unaffected-behavior regression checks.

**Actionable improvement.** For bug fixes, execute the same independently approved reproducer on baseline and candidate. Record a candidate pass plus baseline failure where applicable. For new features, include an absence-of-feature baseline check when meaningful; do not force unrelated failures. Never call an infrastructure failure a code defect without attribution.

### [5] InjecAgent: repository and tool-output text is an attack surface

**Primary evidence — empirical.** Zhan et al., first submitted March 5, 2024, introduce 1,054 indirect-prompt-injection cases across 17 user tools and 62 attacker tools, covering user harm and private-data exfiltration. They evaluate 30 agents; ReAct-prompted GPT-4 is vulnerable in 24% of the tested cases. A hacking-prompt setting nearly doubles that success rate. Re-checked on 2026-10-12: the arXiv abstract matches these figures, and the comments field lists the paper as ACL 2024 Findings (peer-reviewed venue).[5]

**Scope/limitation.** These tool-agent benchmark results do not estimate this plugin's attack rate, demonstrate a complete defense, or cover every malicious repository behavior. The inspected abstract provides the reported scope and headline results; no defense effectiveness is assumed.[5]

**Derived requirement R5.** Treat repository content, diffs, comments, logs, and agent responses as untrusted data, not authority to change verification policy or invoke new capabilities.

**Actionable improvement.** Test payloads that tell the verifier to skip tests, replace the task, print secrets, or label failed runs successful. Policy must live outside the candidate tree. Model-proposed commands require runner-side authorization. Prompt warnings are supplementary, never the privilege boundary.

### [6] Docker Engine security: isolation is a configuration and host question

**Primary evidence — official documentation.** Docker describes kernel namespaces, cgroups, daemon attack surface, capability controls, mounts, and kernel hardening as separate security concerns. It warns that only trusted users should control the daemon and that default capabilities/mounts can provide incomplete isolation, especially with kernel vulnerabilities. Rootless operation is an opt-in mitigation discussed by the documentation.[6]

**Scope/limitation.** A container label does not certify containment. These are Linux-container security mechanisms, not proof of equivalence on Windows hosts or all Docker Desktop deployments.[6]

**Derived requirement R6.** Do not execute candidate repository commands directly on the developer's host merely because verification is read-only at the LLM layer.

**Actionable improvement.** Disposable candidate copies; no host home or Docker-socket mount; no privileged mode; minimal capabilities; sanitized environment; no credentials; bounded CPU, memory, process count and duration; deny network unless explicitly approved. For hostile public repositories, investigate a stronger VM/microVM boundary before claiming safe execution. These controls need platform-specific testing.

### [7] Docker seccomp: keep syscall filtering, report actual protection

**Primary evidence — official documentation.** Docker documents seccomp as Linux syscall filtering. Its default profile uses an allowlist-style policy and is described as moderately protective with broad compatibility. Docker advises against changing the default profile; availability depends on build and kernel configuration.[7]

**Scope/limitation.** Seccomp is one layer, not a complete sandbox or protection against unsafe mounted data, exposed credentials, or authorized network exfiltration.[7]

**Derived requirement R7.** The execution record must state security configuration and fail closed when required protections are unavailable.

**Actionable improvement.** Never silently retry with `seccomp=unconfined` or privileged containers. Surface compatibility failures as `blocked`; request a reviewed profile adjustment or alternate runner. Record effective runner type, image digest, network policy, mount list, capability policy, and resource limits alongside test evidence.

### [8] CodeRabbit CLI: structured review is already an agent workflow

**Primary evidence — official living documentation.** CodeRabbit documents local committed/uncommitted Git-change review and an agent mode using NDJSON. It offers agent integration, scoped reviews, stored findings, and explicit limits on review/fix loops. The documentation distinguishes skipped reviews when no changes are in scope from completed reviews.[8]

**Scope/limitation.** Capability documentation does not establish independent precision/recall or prove all task requirements are met. A zero-finding review and a skipped review are not executable acceptance evidence.[8]

**Derived requirement R8.** Provide stable structured outcomes with explicit scope, completion reason, errors, and skipped work. Do not equate no findings with done.

**Actionable improvement.** Allow external reviewer findings as evidence inputs, but only with snapshot identity and provenance. Keep the core value in task-to-evidence coverage and independently captured execution, not another review-fix chat loop. Benchmark incremental review cost rather than quoting live vendor prices.

### [9] CodeRabbit Security: independent verification and evidence are not vacant territory

**Primary evidence — vendor announcement, August 13, 2026.** CodeRabbit describes Map → Hunt → Verify → Fix. Its verifier reopens cited code, checks reachability, safeguards, exploitation conditions and impact, rejects unsupported candidates, and acknowledges inconclusive evidence. The product describes sandboxed repository investigation and scoped remediation branches.[9]

**Scope/limitation.** This is first-party capability/positioning evidence, not an independent assessment of security accuracy or sandbox guarantees. Security-finding verification is not identical to arbitrary task-completion verification.[9]

**Derived requirement R9.** Do not pitch independent review, evidence-grounded findings, or abstention as unprecedented features. Differentiate a narrow completion-contract workflow and demonstrate it.

**Actionable improvement.** Reopen evidence locations rather than trusting quoted snippets. Explicitly check whether an apparent defect is reachable or protected elsewhere. Consider adapting the same discipline to completion claims: API exists, is wired into the real entry point, and behaves as required in an actual run.

### [10] Cursor Bugbot: review context and custom rules can help, but do not prove execution

**Primary evidence — official living documentation.** Bugbot analyzes PR diffs, leaves explanations/fix suggestions, runs on updates or manual triggers, and uses existing PR comments as context. Its documentation includes project-specific rules and an example rule requiring test-file changes for backend modifications.[10]

**Scope/limitation.** A rule detecting test-file presence is not proof those tests are meaningful or executed. Reviewed documentation does not establish a universal completion-verification contract. User-controlled context also needs a trust policy in our design.[10]

**Derived requirement R10.** Separate contextual guidance from trusted acceptance criteria and execution attestations. File presence alone cannot support a “tests pass” claim.

**Actionable improvement.** Import rules only after explicit trust classification. Prefer behavior-based tests to heuristics such as “there is a test file.” Review feedback can enrich hypotheses, but must not silently rewrite the user's original task.

### [11] Bugbot release notes: neutral, cancelled and oversized are distinct outcomes

**Primary evidence — official release notes.** The September 28, 2026 entry documents neutral checks for cancelled/timed-out runs and for oversized reviews, separate-branch Autofix behavior, and repository configuration that cannot turn Autofix on. The September 21 entry separately describes cancellation semantics for required checks on Origin.[11]

**Scope/limitation.** These are platform-specific changes, not a cross-product standard or evidence that our host permits enforcement of a completion gate.[11]

**Derived requirement R11.** Represent cancellation, timeout, size limits, stale runs, and policy denial separately from verified success or task failure. Repository configuration must not escalate trusted policy.

**Actionable improvement.** Always finalize a verification job with a terminal status. Show reviewed scope and excluded files. If the candidate snapshot changes mid-run, mark evidence stale rather than certifying the current tree. Keep any future repair workflow opt-in and separate from the reviewed branch.

### [12] OpenCode plugin surface: observation hooks are not acceptance semantics

**Primary evidence — official living documentation.** OpenCode describes plugin initialization with project, directory, worktree, SDK client, and Bun shell access. Documented events include `session.idle`, message updates, session diffs, and before/after tool execution. The page illustrates notification on idle and a before-tool hook rejecting an `.env` read.[12]

**Scope/limitation.** The docs do not prove `session.idle` means the requested task is complete, that all events are durable/exactly-once, or that a plugin can securely block every completion path. An illustrated path check is not a comprehensive secrets-access defense.[12]

**Derived requirement R12.** Pin and exercise the real host/plugin version before specifying enforcement. Treat idle as a candidate trigger, not an attestation of completion.

**Actionable improvement.** Start with an explicit user-triggered audit concept and optional debounced idle audit. Identify parent and verifier sessions to avoid recursive verification. Use snapshot keys for deduplication and invalidation. Do not claim mandatory completion gating until cancellation, streaming, nested sessions, SDK failures, and alternate tools have been tested.

### [13] OpenCode policies: a possible hard-deny channel with fail-open semantics

**Primary evidence — official living documentation (retrieved 2026-10-12 during independent review).** Policies are configured under `experimental.policies` and are separate from permissions. `permission` statements hard-deny checks such as `shell:git push *` or `edit:*.env`, and `provider.use` controls provider availability. Policies can only tighten. Statements that fail validation are dropped with a warning in the server log, and the rest of the list still applies. When no statement matches, the action is allowed. The page states that policies do not sandbox plugin code.[13]

**Scope/limitation.** The feature is marked experimental. Its documented defaults and validation behavior are not tested here. The page describes configuration semantics only, not an enforcement test.[13]

**Derived requirement R13.** Enforcement claims must not assume that a malformed or unvalidated policy blocks. An absent or dropped statement is fail-open. A reviewer read-only guarantee needs either a verified fail-closed check at startup or an explicit "blocked" outcome when the statement is not active.

**Actionable improvement.** Add a compatibility probe: inject one invalid statement and one valid deny into a throwaway config, then confirm the host reports the rejection and the deny takes effect. Pair policy denies with plugin-level checks rather than replacing them until the probe passes.

## 4. Proposed completion contract and evidence architecture

Everything in this section is a **proposal**, motivated by R1–R12, not empirical evidence about a working plugin.

### 4.1 Claim ledger

For each user requirement, preserve:

| Field | Meaning |
|---|---|
| requirement ID + exact source span | Stable link to the actual task, not a rewritten summary |
| normalized acceptance question | Observable behavior or artifact condition |
| agent claim + source span | What the agent said, including limitations it disclosed |
| snapshot identity | Base revision, candidate manifest/diff identity, task revision |
| evidence references | Runner-owned records or exact artifact locations |
| result + reason | Supported, contradicted, unverified, blocked |
| coverage boundary | Paths, cases, environments and conditions actually examined |
| provenance | Existing test, independently authored check, candidate-authored test, imported log |

Task requirements absent from the final response still receive rows. Unsupported additional claims also receive rows. Avoid treating requirement coverage percentages as correctness probabilities.

### 4.2 Trust layers

1. **Trusted task/policy:** user-confirmed task and verifier configuration stored outside the candidate tree.
2. **Candidate material:** all changed code, package scripts, lockfiles, instructions, tests, and completion prose are untrusted.
3. **Observation:** immutable copied snapshot and exact diff, including untracked/deleted files relevant to the task.
4. **Authorized runner:** only pre-approved command templates or approved plans; model text cannot widen privileges.
5. **Evidence store:** runner-controlled result metadata separated from candidate-writable output files.
6. **Reconciliation:** interprets evidence but cannot alter captured exit status or promote omitted checks to pass.

A runner-owned record establishes that a particular process ran in a particular environment. It does not by itself establish that a malicious candidate test runner reported truthful behavior. Protect verifier-authored probes and inspect whether the designated test process actually collected relevant tests.

### 4.3 Evidence strength and verdict rules

Suggested ordering, subject to validation:

- Independently captured targeted behavior probe against the exact candidate, plus relevant regressions.
- Independently rerun existing tests whose relationship to the requirement is established.
- Deterministic artifact/config/type checks, limited to the condition they actually check.
- Candidate-authored tests executed independently, explicitly marked as correlated evidence.
- Imported logs bound to a snapshot and trusted executor, if that provenance can be established.
- Static reviewer interpretation or the agent's narrative: useful hypotheses, not execution proof.

`Supported` means the specified bounded acceptance condition has evidence, not “the program has no bugs.” A required contradicted check prevents overall completion. Required blocked or unverified rows prevent an unqualified complete verdict. Documentation-only tasks may legitimately use artifact checks without execution; UI, deployment and security claims require corresponding evidence types. Ambiguous requirements should request clarification rather than silently invent an oracle.

### 4.4 Snapshot and dirty-workspace handling

Never clean, reset, stash, commit, or edit the user's existing dirty files as a side effect of auditing. Snapshot the agreed candidate, record pre-existing edits, and state when ownership cannot be attributed. Verification runs in a disposable copy. Bind all results to that copy, then compare the live candidate identity before displaying a current verdict. Symlink and path traversal handling must be explicit; exclude host paths, secrets, and oversized/generated material by policy while reporting exclusions.

### 4.5 Cost-conscious verification waterfall

1. Resolve scope and task ambiguity before spending model tokens.
2. Parse known command evidence, compare snapshots, and run cheap deterministic artifact checks.
3. Use one bounded model call for acceptance-question planning only when deterministic task extraction is insufficient.
4. Select a minimal relevant probe set; deduplicate checks shared by multiple requirements.
5. Execute targeted checks before broad suites; cap wall time, subprocesses, output and dependency setup.
6. Use one bounded reconciliation call for unresolved semantic questions; no routine model jury.
7. Cache by task, snapshot, command, environment, policy and verifier version. Invalidate when relevant code/config/dependency context changes; do not cache by path alone.
8. Report incurred model usage and runner time separately. Cost ceilings create `blocked`/`unverified`, never automatic success.

This waterfall is an optimization hypothesis. Measure missed defects and false blocks before assuming selective execution is adequate.

## 5. Evaluation proposal before product implementation

Build a human-labeled completion-audit fixture set, not just a patch-solving leaderboard. Suggested cases:

- Real fix with relevant reproducer passing only on candidate and preserved regressions.
- Agent says tests passed but no executor record exists.
- Green command exits after collecting zero tests.
- Agent adds a mocked test that bypasses the real integration path.
- Requirement omitted while every mentioned claim is true.
- Task ambiguous; multiple valid implementations with different tests.
- Baseline already broken; candidate neither fixes nor worsens unrelated failure.
- Correct patch plus stale successful logs from another revision.
- Candidate test script prints success without exercising implementation.
- Candidate disables, deletes, or narrows tests or changes CI filtering.
- Required dependency/network is unavailable, producing blocked rather than false failure.
- Documentation-only task appropriately checked without runtime execution.
- Prompt injection in code comment, README, agent response, and failed-tool log.
- Symlink escape, secret-read attempt, network exfiltration attempt, process/resource exhaustion.
- Concurrent edits invalidate evidence; duplicate idle events and verifier sessions do not recurse.

Compare four explicit baselines: final-response-only judge; diff-only reviewer; deterministic execution-only gate; proposed task/diff/claim/evidence auditor. Human labels should distinguish implementation quality from whether completion is sufficiently evidenced.

Measure false-complete rate first, then false-block rate, defect/omission detection, evidence citation correctness, reproducibility, abstention frequency, latency, model usage and runner time. Score blocked/abstained results separately; never improve apparent accuracy by silently dropping hard cases. Include verbose/terse and order-swapped variants to expose judge sensitivity. Label independent probes before showing evaluators model identity or agent rhetoric. Publish fixture scope and disagreements; no numerical target is established by the reviewed papers for this product.

## 6. Open questions and unsupported claims

- No retrieved source proves this specific completion-verification architecture improves correctness or saves money.
- No primary empirical evidence here establishes demand or willingness to pay.
- No claim that the proposed feature is unique: CodeRabbit documents overlapping independent verification and agent integrations.[8][9]
- No current competitor pricing comparison; documentation capabilities were researched, products were not run.
- No exhaustive competitor census. This is a focused comparison of CodeRabbit and Cursor, not a claim that other evidence-review products do not exist.
- No proof that a plugin-only implementation can prevent all misleading completion messages. Hook behavior and enforcement need a host-version-specific spike.[12]
- No primary source on coding-agent test special-casing or reward hacking was retrieved. The concept relies on detecting such behavior (R4, R10), so this is a required evidence gap, not a settled point.
- No source on the read-only semantics of host tooling. Git commands can refresh index or lock files, and package managers and test runners write caches and generated files. "Read-only" therefore must be defined operationally in the spike (see 05-concept.md section 9).
- Two OpenCode documentation generations (V1 and V2) coexist. The V2 policies page states that V1 files still load. Hook and policy schemas must be taken from the pinned version, not from either page alone.[12][13]
- No assertion that Docker alone safely contains deliberately hostile code.[6][7]
- Missing execution is insufficient evidence, not evidence that the implementation is necessarily incorrect.

## 7. Source registry

Provenance conflict: this section originally stated that all URLs were retrieved using web.run. 02-developer-signals.md reports that web.run was not invocable in its session and that search-adapter and syndication fallbacks were used. The per-source retrieval tool is therefore not consistently recorded; treat the "web.run" wording as unverified for entries [1]–[12] until tool logs are recorded. Recorded access date for entries [1]–[12]: October 11, 2026. Entries [1], [5], [12] and [13] were re-fetched on October 12, 2026 during the independent review; the others were not. Stable numeric IDs are this file's embedded citation ledger; no other source-registry file was written. Dates marked unknown refer to publication/update dates not established by inspected pages.

| ID | Primary source / publisher | Publication / version inspected | URL | Retrieval scope and evidentiary class |
|---|---|---|---|---|
| [1] | Dhuliawala et al., Chain-of-Verification Reduces Hallucination in Large Language Models; authors via arXiv | First submission September 20, 2023; inspected v2 September 25, 2023 | https://arxiv.org/html/2309.11495v2 | Full paper HTML; method and Tables 2–3; empirical factual-generation study |
| [2] | Huang et al., Large Language Models Cannot Self-Correct Reasoning Yet; authors via arXiv | First submission October 3, 2023; inspected v1 HTML plus abstract/history | https://arxiv.org/html/2310.01798v1 ; https://arxiv.org/abs/2310.01798 | Full paper HTML and abstract; intrinsic/oracle distinction and reasoning evaluations |
| [3] | Zheng et al., Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena; authors via arXiv | First submission June 9, 2023; abstract page v4 dated December 24, 2023 | https://arxiv.org/abs/2306.05685 | Abstract/history inspected; headline preference agreement and biases, not full experimental reanalysis |
| [4] | Introducing SWE-bench Verified; OpenAI with SWE-bench collaboration | August 13, 2024; page updated February 24, 2025 | https://openai.com/index/introducing-swe-bench-verified/ | Official methods/results article; human annotation, test criteria, harness scope |
| [5] | Zhan et al., InjecAgent; authors via arXiv | First submission March 5, 2024; abstract page v3 August 4, 2024 | https://arxiv.org/abs/2403.02691 | Abstract/history inspected; empirical benchmark scope and reported attack rate |
| [6] | Docker Engine security; Docker | Living documentation; publication/update date unknown | https://docs.docker.com/engine/security/ | Official technical security guidance; no benchmark or containment certification |
| [7] | Seccomp security profiles for Docker; Docker | Living documentation; publication/update date unknown | https://docs.docker.com/engine/security/seccomp/ | Official syscall-filtering configuration guidance |
| [8] | CodeRabbit CLI; CodeRabbit | Living documentation; publication/update date unknown | https://docs.coderabbit.ai/cli | Official documented agent output, scope, review loops and skipped behavior; no measured efficacy |
| [9] | Introducing CodeRabbit Security; author "Rohit Khanna / CodeRabbit" not re-verified | August 13, 2026 | https://www.coderabbit.ai/blog/introducing-coderabbit-security | First-party announcement; Map/Hunt/Verify/Fix and evidentiary verification claims |
| [10] | Bugbot; Cursor | Living documentation; publication/update date unknown | https://cursor.com/docs/bugbot | Current official product docs; PR review, comments and example test-presence rule |
| [11] | Bugbot release notes; Cursor | Inspected entries September 21 and September 28, 2026 | https://cursor.com/docs/release-notes/bugbot | Dated official operational semantics; neutral/cancelled/oversize outcomes |
| [12] | Plugins; OpenCode | Living documentation; footer "Last updated: Oct 11, 2026"; re-fetched 2026-10-12 | https://docs.opencode.ai/docs/plugins/ | Official plugin context, event list and examples; SDK behavior not executed |
| [13] | Policies; OpenCode (V2 docs path) | Living documentation; re-fetched 2026-10-12; experimental feature per page | https://opencode.ai/v2/docs/policies/ | Official policy statement semantics, fail-open validation, no-match allow; not executed |

### Retrieval issues and handling

The attempted self-correction v3 HTML URL returned an internal retrieval error. The readable v1 HTML and current abstract/history page were used instead; this report explicitly identifies that version and makes no claim of full v3 inspection. Current cursor.com documentation and September 2026 release notes were opened directly. The release notes label entries by the Monday starting each week; dates above refer to those week labels, not independently established deployment timestamps. Search-engine publication/crawl labels were not treated as primary publication dates.

### Recommended decision before building

Approve or reject the **bounded task-completion evidence auditor** concept, its explicit abstention semantics, the non-mutating workspace requirement, and its initial execution threat model. Next, separately authorize a compatibility/evaluation spike against the actual public v0.3 project and installed OpenCode version. This report does not implement that spike, inspect or modify product code, or certify that the current project already supports the proposed architecture.
