# Antigravity Teamwork-Preview Reference Architecture & OpenCode Blueprint

## 1. Executive Summary

`teamwork-preview` is Google Antigravity's multi-agent orchestration system designed for **long-horizon, autonomous engineering campaigns** (e.g., repository migrations, full-stack application builds, complex mathematical proofs, multi-day refactors) that exceed the capacity, token window, and reliability of a single LLM agent.

This document provides the **exact architectural specification**, **agent topologies**, **prompt elicitation engine**, **heterogeneous multi-model customization framework**, and **reproduction blueprint** to build a matching `teamwork` service for **OpenCode**.

---

## 2. Core Design Principles

The teamwork engine operates on five fundamental axioms:

| # | Axiom | Description |
|---|---|---|
| **1** | **Specify What, Not How** | Prompts specify requirements ($R_1, R_2, \dots$) and acceptance criteria, avoiding prescriptive implementation details (file structure, libraries, algorithms) unless strictly required. |
| **2** | **Objective Verification (Forcing Function)** | Implementers are strictly forbidden from self-certifying their work. Every milestone requires independent programmatic or adversarial validation to force real debug loops. |
| **3** | **Context Hygiene via Artifacts** | Agents communicate via structured artifacts (diffs, test matrices, schemas) and isolated git worktrees rather than dumping raw conversation history. |
| **4** | **Decoupled Orchestration Patterns** | Orchestration logic is decoupled from task logic. The system dynamically routes prompts to specialized team topologies. |
| **5** | **Heterogeneous Model Allocation** | Subagents are decoupled from a single global LLM. High-reasoning models orchestrate and audit, high-throughput models build, and specialized local/cost-efficient models power massive swarms. |

---

## 3. High-Level System Architecture

```
                                  USER PROMPT / /team CLI
                                          │
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │     PHASE 1: PROMPT ELICITATION ENGINE   │
                     │  (Interactive 9-Step Crafting Wizard)   │
                     └────────────────────┬─────────────────────┘
                                          │ Approved Task Spec & Model Matrix
                                          ▼
                     ┌──────────────────────────────────────────┐
                     │          DYNAMIC ROUTING ENGINE          │
                     │    (Inspects Spec & Selects Topology)    │
                     └─┬──────────────┬──────────────┬────────┬─┘
                       │              │              │        │
        ┌──────────────┘              │              │        └──────────────┐
        ▼                             ▼              ▼                       ▼
┌───────────────┐             ┌───────────────┐ ┌───────────────┐    ┌───────────────┐
│   FULL TEAM   │             │  SMALL TEAM   │ │PROOF PIPELINE │    │DOC REVIEW TEAM│
│ (Multi-Module)│             │ (Single Fix)  │ │ (Math/Formal) │    │(Audit/Paper)  │
└───────┬───────┘             └───────┬───────┘ └───────┬───────┘    └───────┬───────┘
        │                             │                 │                    │
        └─────────────────────────────┴────────┬────────┴────────────────────┘
                                               ▼
                              ┌───────────────────────────────────┐
                              │     ORCHESTRATION & DISPATCH      │
                              │  (DAG Engine, Worktrees, Sandboxes)│
                              └────────────────┬──────────────────┘
                                               │
                                 ┌─────────────┴─────────────┐
                                 │ MULTI-MODEL ADAPTER LAYER │
                                 │ (Gemini, Claude, GPT, R1) │
                                 └─────────────┬─────────────┘
                                               │
               ┌───────────────────────────────┼───────────────────────────────┐
               ▼                               ▼                               ▼
     ┌───────────────────┐           ┌───────────────────┐           ┌───────────────────┐
     │ Worker: Backend   │           │ Worker: Frontend  │           │ Worker: Tests     │
     │ Model: Flash/Qwen │           │ Model: Sonnet/GPT │           │ Model: Flash/Lite │
     │ (Worktree A)      │           │ (Worktree B)      │           │ (Worktree N)      │
     └─────────┬─────────┘           └─────────┬─────────┘           └─────────┬─────────┘
               │                               │                               │
               └───────────────────────┬───────┴───────────────────────────────┘
                                       │ Code Diffs & State Manifests
                                       ▼
                              ┌───────────────────────────────────┐
                              │    ADVERSARIAL VERIFIER ENGINE    │
                              │ Model: DeepSeek-R1 / o3 / GPT-4o  │
                              │  (Test Harness, Judge with Rubric)│
                              └────────────────┬──────────────────┘
                                               │
                                      ┌────────┴────────┐
                             [Pass]   │                 │ [Fail]
                         ┌────────────┘                 └────────────┐
                         ▼                                           ▼
                 Merge to Mainline                             Iterate & Debug
```

---

## 4. Phase 1: Interactive Prompt Elicitation Protocol

Before dispatching multi-agent teams, Antigravity executes an interactive 9-step alignment phase to generate an unambiguous, falsifiable task document (`prompt_draft.md`).

### The 9-Step Elicitation Flow

1. **Step 1: Elicit Project Idea**
   - Captures target outcome in 1–2 declarative sentences.
2. **Step 2: Identify Ambiguity & Scale**
   - Probes scope, technology boundaries, and infrastructure requirements.
   - Determines if the user desires opt-in scaling:
     - *Small Focused Team:* 1 builder + repeated adversarial review (fastest for self-contained fixes).
     - *Large-Scale Swarm:* Massive parallel search (100+ agents for math/theorems).
3. **Step 3: Determine Integrity Mode**
   - Evaluates policy constraints:
     - `development` (Default): Standard local development; external package installation permitted.
     - `demo`: Enforces original clean implementations without external code scraping.
     - `benchmark`: Strict blind execution; test harness source code hidden from implementers.
4. **Step 4: Draft Requirements ($R_1 \dots R_N$)**
   - Formulates 2–5 functional blocks focusing strictly on *behavior*, not internal implementation details.
5. **Step 5: Design Verification (The Forcing Function)**
   - Defines automated test scripts, mock harnesses, bot drivers, or independent LLM judges with explicit scoring rubrics.
6. **Step 6: Set Acceptance Criteria**
   - Converts requirements into concrete markdown checklists (`- [ ]`).
7. **Step 7: Configure Infrastructure & Model Allocation Matrix**
   - Declares boundaries for cloud storage, network calls, sandbox permissions.
   - Allows the user to bind custom LLM providers and models per subagent role or select a predefined budget tier (see Section 6).
8. **Step 8: Set Working Directory**
   - Assigns project root (`~/teamwork_projects/{project_name}`).
9. **Step 9: Assemble & Validate**
   - Validates draft against anti-patterns (no self-certification, no prescriptive constraints). Waits for explicit user confirmation before execution.

---

## 5. Phase 2: Dynamic Team Shapes & Routing

The routing engine inspects the finalized prompt and dynamically provisions one of five multi-agent team shapes:

```
┌─────────────────────────┬───────────────────────────────────┬──────────────────────────────────────────┐
│ Team Topology           │ Trigger Condition                 │ Agent Roles & Allocation                 │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
│ 1. Full Team            │ Multi-module builds, migrations,  │ • 1 Sentinel (Coordinator / Architect)   │
│                         │ deep research, large features     │ • 2-6 Workers (Specialized by module)    │
│                         │                                   │ • 1-2 Adversarial Verifiers              │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
│ 2. Small Focused Team   │ Single self-contained fix/tweak   │ • 1 Primary Implementer                  │
│                         │ (Explicit opt-in)                 │ • 1 Adversarial Reviewer (Looping)       │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
│ 3. Proof Pipeline       │ Formal verification, Lean/Coq,    │ • 1 Proof Strategist                     │
│                         │ mathematical deductions           │ • 3-5 Proof Searchers                    │
│                         │                                   │ • 1 Formal Engine Checker (Compiler)     │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
│ 4. Massive Proof Swarm  │ Hard unsolved/open math problems  │ • 1 Meta-Coordinator                     │
│                         │ (Explicit opt-in)                 │ • 100+ Concurrent Search Agents          │
│                         │                                   │ • Distributed Checker Cluster            │
├─────────────────────────┼───────────────────────────────────┼──────────────────────────────────────────┤
│ 5. Document Review Team │ Academic paper, architectural RFC,│ • 1 Review Chair                         │
│                         │ or audit review                   │ • 3 Independent Domain Critics           │
│                         │                                   │ • 1 Synthesis Aggregator                 │
└─────────────────────────┴───────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 6. Heterogeneous Model Customization System

To optimize for **cost, reasoning depth, and throughput**, users can assign specific models to specific subagents at their own expense (using their own API keys or local endpoints).

### 1. Role-to-Model Specialization Matrix

| Subagent Role | Required Capability | Recommended Model Archetypes | Example Models |
|---|---|---|---|
| **Sentinel / Architect** | High context window, structured planning, multi-agent dispatch | Frontier reasoning models | `claude-3-7-sonnet`, `gemini-2.5-pro`, `o3-mini`, `gpt-4o` |
| **Worker: Core Logic / Algorithms** | Complex refactoring, nuanced bug fixing | Deep reasoning / coding models | `claude-3-7-sonnet`, `deepseek-r1`, `gpt-4o` |
| **Worker: Scaffolding / Repetitive Code** | High tokens/sec, low cost, fast tool calls | Fast code-specialized models | `gemini-2.5-flash`, `qwen-2.5-coder-32b`, `claude-3-5-haiku` |
| **Adversarial Verifier / Judge** | Critical evaluation, zero hallucination, strict logic | Reasoning / Verification models | `deepseek-r1`, `o1`, `gpt-4o`, `claude-3-7-sonnet` |
| **Massive Swarm Worker (100+ Agents)** | Extreme cost efficiency, local deployment | Quantized local / cheap models | `deepseek-r1-distill-llama-70b`, `ollama/qwen2.5-coder`, `gemini-flash-lite` |

---

### 2. User Configuration Interfaces

Users configure model assignments via three complementary mechanisms:

#### A. Global / Project Config (`.opencode/config/teamwork-models.json`)

```json
{
  "defaultTier": "balanced",
  "tiers": {
    "budget": {
      "sentinel": "gemini-2.5-flash",
      "worker": "gemini-2.5-flash",
      "verifier": "deepseek-r1"
    },
    "balanced": {
      "sentinel": "claude-3-7-sonnet",
      "worker": "gemini-2.5-flash",
      "verifier": "deepseek-r1"
    },
    "maximum_reasoning": {
      "sentinel": "claude-3-7-sonnet",
      "worker": "claude-3-7-sonnet",
      "verifier": "o1"
    }
  },
  "subagentOverrides": {
    "sentinel": {
      "provider": "anthropic",
      "model": "claude-3-7-sonnet",
      "temperature": 0.2,
      "maxOutputTokens": 8192
    },
    "workers": {
      "backend_worker": {
        "provider": "google",
        "model": "gemini-2.5-flash",
        "temperature": 0.1
      },
      "frontend_worker": {
        "provider": "openai",
        "model": "gpt-4o",
        "temperature": 0.3
      }
    },
    "verifier": {
      "provider": "openrouter",
      "model": "deepseek/deepseek-r1",
      "temperature": 0.6
    }
  },
  "budgetGuardrails": {
    "maxSessionCostUsd": 15.00,
    "maxCostPerAgentUsd": 3.00,
    "alertThresholdPct": 80
  }
}
```

#### B. CLI Flags

```bash
# Launch teamwork with a preset tier
opencode team --tier=balanced

# Launch teamwork with granular model overrides
opencode team \
  --model-sentinel=anthropic/claude-3-7-sonnet \
  --model-worker=google/gemini-2.5-flash \
  --model-verifier=openrouter/deepseek-r1 \
  --max-cost=20.00
```

#### C. Interactive Prompt Crafter Modal (Step 7)

During prompt elicitation, the crafter presents the user with an interactive model selection prompt:

```
[Teamwork Model Allocation]
Selected Team: Full Team (1 Sentinel, 3 Workers, 1 Verifier)

Preset Tiers:
(1) [Recommended] Balanced ($1.50 - $4.00 est.)
    Sentinel: Claude 3.7 Sonnet | Workers: Gemini 2.5 Flash | Verifier: DeepSeek-R1
(2) Budget ($0.20 - $0.80 est.)
    Sentinel: Gemini 2.5 Flash | Workers: Flash-Lite / Qwen | Verifier: DeepSeek-R1
(3) Maximum Reasoning ($5.00 - $15.00 est.)
    Sentinel: Claude 3.7 Sonnet | Workers: Claude 3.7 Sonnet | Verifier: o1
(4) Custom (Configure per-subagent JSON)
```

---

### 3. Multi-Model Provider Adapter Architecture

In OpenCode, implement a unified **Model Provider Adapter** (`src/models/provider_adapter.ts`) that normalizes message formats, tool calling, and structured outputs across providers:

```
                     ┌──────────────────────────────────────────────┐
                     │          OPENCODE SUBAGENT RUNTIME           │
                     └──────────────────────┬───────────────────────┘
                                            │ Unified Tool Call
                                            ▼
                     ┌──────────────────────────────────────────────┐
                     │         MODEL PROVIDER ADAPTER LAYER         │
                     │ (Normalizes Prompts, Tool Specs, Schemas)    │
                     └──────┬────────────┬─────────────┬────────────┘
                            │            │             │
              ┌─────────────┘            │             └─────────────┐
              ▼                          ▼                           ▼
    ┌───────────────────┐      ┌───────────────────┐       ┌───────────────────┐
    │ Anthropic SDK     │      │ Google GenAI SDK  │       │ OpenAI / LiteLLM  │
    │ (Claude 3.7 / 3.5)│      │ (Gemini 2.5 Pro)  │       │ (GPT-4o, DeepSeek)│
    └───────────────────┘      └───────────────────┘       └───────────────────┘
```

#### Key Adapter Responsibilities:
1. **Dynamic Tool Schema Translation:** Automatically translates OpenCode tool definitions into Anthropic XML/Tool format, OpenAI JSON schema, or Gemini Function Declarations.
2. **Streaming & Token Cost Attribution:** Tracks exact prompt/completion token usage per subagent and accumulates costs in real-time.
3. **Fallback & Rate-Limit Backoff:** If a specific provider hits 429 rate limits, the adapter automatically fails over to a secondary configured fallback model for that role.

---

## 7. Execution Runtime & Subsystems

### 1. Workspace Isolation via Git Worktrees
To prevent concurrent agent processes from corrupting the working tree or clashing over file locks:
- The Sentinel initializes a clean git branch: `teamwork/base-[task-id]`.
- For each worker agent $i$, the manager creates an isolated git worktree:
  ```bash
  git worktree add -b teamwork/agent-[name] .teamwork/worktrees/agent-[name] teamwork/base-[task-id]
  ```
- Workers execute file edits and tests inside their private worktree directory.
- Upon milestone completion, worker branches are merged or diff-applied via the Sentinel.

### 2. The Artifact Communication Bus
Raw conversational history is **never** shared across all agents. Doing so exhausts LLM context limits and causes instruction drift. Agents communicate strictly through **Typed Artifacts**:

- `spec.json`: Target requirements, API signatures, acceptance criteria.
- `plan.dag.json`: Task dependency graph with assigned model bindings and status (`PENDING`, `IN_PROGRESS`, `VERIFYING`, `DONE`).
- `patch.diff`: Git diff patches produced by implementers.
- `verification_report.json`: Structured test outputs, stack traces, benchmark metrics.

### 3. Adversarial Verification Engine (The Forcing Function)
Implementers naturally suffer from confirmation bias. The verification engine enforces strict segregation of duties:
1. **Blind Test Harness Execution:** Verifiers run pre-configured test suites against the worker's branch.
2. **Adversarial Fuzzing / Property Testing:** Verifiers attempt to craft inputs that break the implementer's assumptions.
3. **Agent-as-Judge Scoring:** For subjective or qualitative tasks, verifiers grade output against a rigorous binary checklist.
4. **Automated Rejection & Retry:** If verification fails, a structured failure report with exact reproduction steps is dispatched back to the implementer without human intervention.

---

## 8. OpenCode Replication Blueprint

To build this exact capability into **OpenCode**, implement the following architecture:

### 1. Directory Layout

```
.opencode/
├── command/
│   └── team.md                      # Slash command definition (/team, /teamwork)
├── agents/
│   ├── teamwork-prompt-crafter.json  # Phase 1: Interactive elicitation agent
│   ├── teamwork-router.json          # Pattern classifier
│   ├── teamwork-sentinel.json        # Main DAG coordinator
│   ├── teamwork-worker.json          # Specialized implementation agent
│   └── teamwork-verifier.json        # Adversarial testing agent
├── skills/
│   ├── git-worktree-manager/         # Git worktree isolation tools
│   ├── task-dag-engine/              # Dependency graph executor
│   ├── verification-harness/         # Test runner & validator
│   └── model-cost-tracker/           # Token meter & budget guardrails
└── config/
    ├── teamwork.json                 # Quotas, timeouts, sandbox policy
    └── teamwork-models.json          # Model allocation matrix & credentials
```

### 2. Step-by-Step Implementation Roadmap

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       OPENCODE REPLICATION ROADMAP                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 1: The Prompt Crafter & Slash Command                             │
│ • Create .opencode/command/team.md                                          │
│ • Implement the 9-step interactive dialog in teamwork-prompt-crafter        │
│ • Generate prompt_draft.md artifact with acceptance criteria & model tier   │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 2: Multi-Model Provider Adapter Layer                             │
│ • Implement unified LLM interface for Anthropic, OpenAI, Gemini, Ollama     │
│ • Add token cost tracking & real-time USD budget guardrail enforcement      │
│ • Build per-subagent model binding resolution engine                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 3: Workspace & Worktree Manager                                   │
│ • Implement tools to spawn and prune git worktrees per agent session        │
│ • Setup local state persistence (.opencode/teamwork/sessions/<id>/state.json)│
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 4: Routing & Sentinel DAG Engine                                  │
│ • Build LLM router to classify prompt into Team Topologies                  │
│ • Implement task DAG resolver with dependency tracking and parallel dispatch│
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 5: Worker & Verifier Execution Loop                               │
│ • Equip worker agents with tool leasing in sandboxed directories             │
│ • Build verifier agent with automated test execution and rubric grading     │
│ • Wire rejection feedback loop (Worker -> Verifier -> Fix -> Verifier)      │
├─────────────────────────────────────────────────────────────────────────────┤
│ Milestone 6: TUI & Live Progress Dashboard                                  │
│ • Render multi-agent status and active models in OpenCode CLI terminal      │
│ • Display real-time token burn, cost accumulation, and verification state   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 9. OpenCode Core Data Structures

### `task_dag.json` Schema (With Model Customization & Budgeting)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TeamworkTaskDAG",
  "type": "object",
  "properties": {
    "sessionId": { "type": "string" },
    "topology": { "type": "string", "enum": ["full", "small", "proof", "massive_proof", "doc_review"] },
    "workingDirectory": { "type": "string" },
    "modelAllocation": {
      "type": "object",
      "properties": {
        "sentinel": { "type": "string" },
        "defaultWorker": { "type": "string" },
        "verifier": { "type": "string" }
      }
    },
    "budget": {
      "type": "object",
      "properties": {
        "maxCostUsd": { "type": "number" },
        "currentCostUsd": { "type": "number" }
      }
    },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "title": { "type": "string" },
          "assignedWorker": { "type": "string" },
          "assignedModel": { "type": "string" },
          "worktreePath": { "type": "string" },
          "dependencies": { "type": "array", "items": { "type": "string" } },
          "status": { "type": "string", "enum": ["PENDING", "RUNNING", "VERIFYING", "COMPLETED", "FAILED"] },
          "acceptanceCriteria": { "type": "array", "items": { "type": "string" } },
          "artifacts": { "type": "array", "items": { "type": "string" } },
          "metrics": {
            "type": "object",
            "properties": {
              "tokensUsed": { "type": "integer" },
              "costUsd": { "type": "number" }
            }
          }
        },
        "required": ["taskId", "title", "assignedWorker", "assignedModel", "status", "dependencies"]
      }
    }
  },
  "required": ["sessionId", "topology", "workingDirectory", "modelAllocation", "tasks"]
}
```

### `verification_report.json` Schema

```json
{
  "taskId": "task-002",
  "timestamp": "2026-08-28T05:00:00Z",
  "status": "FAILED",
  "verifierAgent": "teamwork-verifier-1",
  "verifierModel": "deepseek/deepseek-r1",
  "checks": [
    {
      "name": "Automated Unit Tests",
      "type": "programmatic",
      "passed": true,
      "output": "42 passed, 0 failed"
    },
    {
      "name": "Edge Case Fuzzing",
      "type": "adversarial",
      "passed": false,
      "error": "Unhandled null pointer on empty input stream in src/parser.ts:48"
    }
  ],
  "feedbackForWorker": "Fix null input handling in parser.ts before resubmitting."
}
```

---

## 10. Verification & Failure Handling Protocol

To ensure reliability across extended execution cycles:

1. **Deadlock & Timeout Guards:** Every subagent is allocated a step and time quota. If an agent loops >10 turns without file modifications or tests, the Sentinel pauses it and requests diagnostics.
2. **Quota & Spend Guardrails:** If cumulative token spend approaches `maxSessionCostUsd`, the Sentinel halts non-essential workers and prompts the user before continuing.
3. **Session Checkpointing & Resume:** Session state is written to `.opencode/teamwork/sessions/<id>/state.json` on every state transition, allowing resumption even if token limits or network interruptions occur.
4. **Automated Clean-Up:** Upon successful merge, all auxiliary git worktrees are pruned (`git worktree prune`) to keep the workspace clean.
