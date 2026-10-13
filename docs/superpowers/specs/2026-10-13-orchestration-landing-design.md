# Orchestration landing page design

Date: 2026-10-13. Status: proposed design, awaiting review; not an implementation or deployment approval.

## 1. Purpose and boundaries

Build a practical front door for developers evaluating `opencode-teamwork`: understand the role-based orchestration approach, preview installation, start a workflow in OpenCode, and change model configuration without confusing prompt instructions with enforced runtime behavior. Position it as an independent community project, not a replica or official product of Google, Antigravity, OpenCode, or a model provider. Keep the npm identity unchanged.

This assignment writes only this spec and its accompanying plan. Later implementation requires review. No product code, installation, git mutation, service, release, deployment, analytics, or publication is authorized here. Existing README.md, SKILL.md, src/cli/index.ts modifications and all preexisting docs/review-pivot files are user-owned and must remain untouched. The future site also must not require edits to those files or the root package manifest.

### Success criteria

A new visitor can find a copyable preview command, an install command, an OpenCode slash-command example, a valid JSON configuration example, and the release limitations. These remain readable with JavaScript disabled. Keyboard users can use navigation and enhanced copy controls. A future build can be served at `/` and `/OpenCode-Team/` without broken assets or fragments. No click triggers installation, provider calls, or repository writes.

## 2. Evidence and truth boundaries

Inspected repository: `C:/Users/oliad/Desktop/opencodeteam`, HEAD `70c1dbaa07819f0b9612f032d27ca5ffd626fe04`, package version `0.2.1`. Publication of 0.2.1 and the separate unpublished `teamwork-review-build` v0.3.0 development effort are supplied context, not a fresh registry audit. Do not describe 0.2.1 as the forever-latest release; label the page “Release documented: 0.2.1”. Revalidate before any future publication.

| Source | Finding | Content decision |
|---|---|---|
| package.json | Name opencode-teamwork, MIT, exports `.`, `./server`, `./templates`, bin ./dist/cli/index.js | Preserve every identifier and export; site stays out of root dist and npm files whitelist |
| src/index.ts:19–56 | Config hook registers agents and commands; no runtime orchestration loop | Say “The plugin registers roles and commands. Agent prompts own the orchestration loop.” |
| src/templates.ts:104–115, 141–149, 194–209 | 10 role templates, 7 command templates, 6 pattern templates | Show accurate inventories; do not repeat stale 6/5/4 comments or SKILL_BODY |
| src/cli/templates/commands/teamwork.md | Sentinel prompt asks for DAG, worktrees, workers, verification and artifacts | Describe these as workflow instructions, not enforced scheduler or security boundaries |
| src/cli/templates/commands/team-orchestrate.md | Separate legacy propose/falsify/synthesize/verify prompt | Explain the simpler alternative without implying guaranteed execution |
| HEAD:src/cli/index.ts | Five preset IDs: anthropic, team, google, openai, free; --print/--dry-run, --preset, --config, --yes, --reset; default anthropic | Released examples use explicit anthropic preset; no model pricing promise |
| Working src/cli/index.ts and README/SKILL | Uncommitted opencode-free, opencode-go, opencode-zen presets and model guidance | Do not market those changes as released 0.2.1 behavior |
| README.md | Stale counts and strong engine/isolation/budget/resume claims | Use README for user vocabulary, actual plugin wiring for executable claims |

Known configuration hazards: `deepMerge` replaces arrays, including `plugin`, before `ensurePluginListed`; do not promise preservation of existing plugin entries. `--print` prints the proposed patch, not a validated final merge of the existing file. `--reset` replaces existing configuration. `doctor` uses the default/environment config path and checks presence of plugin/roles; it does not test provider authentication, model availability, workflow correctness, or take a --config override. The interactive `custom` picker is inconsistent in source: do not advertise `--preset custom` or a working custom wizard. Prefer manual per-role JSON editing. These are disclosure requirements, not permission to fix the CLI.

### Release matrix, always visible

- **Released 0.2.1:** role and command registration, packaged prompt templates, installer configuration. Workflows are prompt-owned.
- **Prompt instructions, not guarantees:** planning, worktree use, verification loops, artifact writing and budget guidance. Outcomes depend on the host, tools, permissions, models and agent execution. Inspect changes and run your own tests.
- **Development only:** v0.3.0 engine work on `teamwork-review-build` is unpublished. Do not attach it to the install CTA, claim its features ship, or claim its tests/reliability without inspecting that branch. A source-branch link is informational, not an installation recommendation.

Do not claim automatic isolation, guaranteed independent/sandboxed review, deterministic dispatch, atomic merge, durable recovery, enforced dollar caps, provider compatibility certification, zero-cost usage, benchmark scores or real-time execution status. No fabricated terminal output, live graph, testimonials, stars/download counters or performance metrics.

## 3. Architecture decision

Recommend a dependency-light, isolated static subtree at `site/`: semantic HTML generated from an explicit content module, CSS, a small browser ES module, a Node build/check toolchain, and Playwright only for development tests. No React, router, backend, CDN fonts, runtime remote fetches or bundler are needed. Static content is emitted at build time; JavaScript only enhances copy behavior. The root plugin package/scripts/lockfile remain unchanged; site/package.json is private and owns its lockfile.

Alternatives considered: (a) Astro gives useful component tooling but adds a framework/install surface for one page; (b) hand-maintained HTML needs no renderer but encourages divergence between examples, rendered text and source-backed content checks. The small static renderer is the recommended compromise. Never import the plugin entry or CLI into the site build: those modules have runtime side effects and unrelated host dependencies.

Build output: `site/dist/index.html`, `site/dist/assets/styles.css`, `site/dist/assets/enhance.js`, `site/dist/assets/favicon.svg`, `site/dist/.nojekyll`. Use relative `./assets/...` links and native `#fragment` navigation. No root-absolute local paths, SPA fallback, known future domain, canonical URL, CNAME or Pages workflow. A future authorized Pages job can upload site/dist unchanged; readiness is not publication. All repository links point to GitHub rather than local source files omitted from the site artifact.

## 4. Information architecture and exact content

One page, one h1, ordered sections. Header wordmark is plain `opencode-teamwork`; navigation labels “Workflow”, “Install”, “Configure”, “Release status”; source link “GitHub”. Skip link targets `#main`. Fragment IDs: `workflow`, `patterns`, `install`, `configure`, `commands`, `release-status`, `faq`. Hero actions target `#install` (“Install the plugin”) and `#workflow` (“Explore the workflow”). Footer links npm package, repository, issue tracker and MIT source license. No inert CTA.

### Hero

Headline: **“Give complex work a team, not another giant prompt.”**

Body: “Coordinate specialist roles inside OpenCode. Start with a clear task, ask for competing approaches, challenge the result, and inspect the evidence before you accept it.”

Adjacent visible note: “Release documented: 0.2.1. The plugin registers roles and commands; agent prompts own the orchestration loop.”

A static handoff illustration is captioned “Illustrative workflow, not a live run.” It shows task brief → coordinate → work → review, with a feedback route labelled “Revise after findings”. The parallel lanes have named responsibilities rather than spinning indicators or fake progress. Provide the same meaning as an ordered textual list; hide redundant decorative connectors from assistive technology.

### Workflow and role reference

Explain: define acceptance criteria; select a workflow template; have specialist roles produce and challenge work; inspect artifacts/diffs and independently run project checks. Model selection is configuration, not proof of independent reasoning. Human approval is recommended, not asserted as an enforced runtime gate.

Exact role inventory: `team/crafter`, `team/sentinel`, `team/worker`, `team/proof-worker`, `team/verifier`, `team/orchestrator`, `team/proposer`, `team/falsifier`, `team/synthesizer`, `team/scout`. Display concise descriptions (brief creation, coordination, implementation, proofs, checks, legacy loop, proposals, critique, synthesis, context). No invisible “more roles” content.

### Workflow templates

Use a readable list/table, not six interchangeable feature cards:

| Exact ID | Guidance |
|---|---|
| small-focused | One bounded fix with review; a single agent may be enough |
| iterative-coding | Repeated candidate/critique refinement |
| distributed-coding | Tasks that can be split across modules |
| document-review | Critique a local RFC or document |
| long-proof | Proof exploration; formal checking needs your tools |
| massive-proof-swarm | Large proof exploration; opt-in and potentially expensive, not a promise of a worker count |

Example shell block (copy only the slash command, no `$` or shell prompt):

```text
/teamwork --topology distributed-coding "Split the parser and formatter changes into scoped tasks. Add regression tests and report unresolved review findings."
```

Also show:

```text
/teamwork-craft "Help define acceptance criteria for a parser refactor."
/team-orchestrate "Propose and challenge fixes for the off-by-one in parser.ts."
```

Label these “Run inside OpenCode”, not terminal commands. For `.opencode/teamwork/<session-id>/prompt_draft.md`, `plan.dag.json`, `final.md` and `.teamwork-runs/<run-id>/final.md`, say “Paths the prompts ask agents to produce”; no assertion they always exist or schemas are enforced automatically.

### Install: preview before changing configuration

Prerequisites: OpenCode already installed; Node/npm for npx or Bun for bunx; a configured provider/model usable in the host. Never invent version floors. Provider authentication and fees are separate from this package.

Each block has its own precise copy label. Use ASCII quotes and no embedded comments in copied commands.

```sh
npx opencode-teamwork@0.2.1 install --preset anthropic --print
npx opencode-teamwork@0.2.1 install --preset anthropic
bunx opencode-teamwork@0.2.1 install --preset anthropic
opencode
```

Present npx installation as primary and bunx as an alternative, not consecutive mandatory installs. Warn before the write command: “Back up your OpenCode configuration first. The installer can replace the plugin array; preserve other plugin entries manually. --print shows the proposed patch, not the final merged file.”

Crucial version note: “Pinning the installer to 0.2.1 does not pin the installed plugin: this CLI writes opencode-teamwork@latest. For the documented release, change that entry to opencode-teamwork@0.2.1 before starting OpenCode.” Do not conceal this behind FAQ.

Secondary examples: `npx opencode-teamwork@0.2.1 install --preset anthropic --print --config ./opencode.json` (explicit relative target, do not suggest doctor uses it); `npx opencode-teamwork@0.2.1 doctor` with limited-check description; `npx opencode-teamwork@0.2.1 uninstall` with backup warning and note it edits configuration rather than universally uninstalling cached/global packages. Explain --yes bypasses confirmation and --reset overwrites existing config; neither is a primary CTA.

### Configuration

Location copy: “Default: ~/.config/opencode/opencode.json. OPENCODE_CONFIG_DIR selects the directory; install --config selects an explicit file. Back up before editing.” Render a full valid JSON example, not ellipses or comments:

```json
{
  "plugin": ["opencode-teamwork@0.2.1"],
  "agent": {
    "team/crafter": { "model": "anthropic/claude-sonnet-4-5" },
    "team/sentinel": { "model": "anthropic/claude-sonnet-4-5" },
    "team/worker": { "model": "anthropic/claude-sonnet-4-5" },
    "team/proof-worker": { "model": "anthropic/claude-sonnet-4-5" },
    "team/verifier": { "model": "anthropic/claude-sonnet-4-5" },
    "team/orchestrator": { "model": "anthropic/claude-sonnet-4-5" },
    "team/proposer": { "model": "anthropic/claude-sonnet-4-5" },
    "team/falsifier": { "model": "anthropic/claude-sonnet-4-5" },
    "team/synthesizer": { "model": "anthropic/claude-sonnet-4-5" },
    "team/scout": { "model": "anthropic/claude-sonnet-4-5" }
  }
}
```

Caption: “Example based on the release’s anthropic preset, not a model recommendation or availability guarantee. Keep any other plugin entries you already use. To change a role, replace its model value with an ID available in your OpenCode setup.” No secret/API-key inputs, dynamic recommendations, pricing table or claim that current uncommitted presets ship.

### Commands, release status, FAQ

List all seven exact slash commands: `/teamwork`, `/teamwork-craft`, `/team-orchestrate`, `/team-propose`, `/team-falsify`, `/team-synthesize`, `/team-review`. Brief role/action descriptions and links to source command templates support inspection; do not call command arguments a validated CLI parser.

Release status repeats the three-way matrix from section 2. Development branch source link is visibly labelled “Unpublished development branch”; no v0.3.0 install command.

FAQ answers: “When is one agent enough?” (small bounded tasks, overhead); “Does review guarantee correctness?” (no; inspect findings, run tests); “Can I select different models?” (manual per-role config, host availability); “Where are results?” (prompt-requested paths, inspect actual run); “Is this an official product?” (independent community project, no affiliation implied). Native details/summary keeps answers accessible without JavaScript.

## 5. Distinct visual language: a handoff workbench

The subject is accountable handoffs, not a sci-fi command center. Make the workflow lanes the memorable element, with a restrained cobalt bracket tracing review back to work. Everything else is legible documentation. No competitor logos, replica wording, borrowed visual marks, ornamental dashboards, gradient orbs, terminal theater or empty metric tiles.

Palette tokens: canvas `#F3F6FA`, surface `#FFFFFF`, ink `#15283B`, secondary ink `#41556B`, action cobalt `#2454C6`, connector/border `#C5D1DE`. Color is never the only indication of release status or selected state. Actual contrast must pass measured gates; do not assume all token pairs are suitable for small text.

Type: system sans body (`Segoe UI`, system-ui, sans-serif); system monospace (`Cascadia Code`, Consolas, monospace) only for literal commands and JSON. No download dependencies. H1 uses a compact left-aligned two-line rhythm, fluid 2.2–3.8rem; body 1rem/1.6, 65–72 character prose measure. Sentence-case labels, no all-caps decorative eyebrows. Literal package name can wrap at hyphens without altering copied content.

Layout: max-width 1160px with 24px desktop gutters, 16px mobile gutters. Hero 55/45 split above 900px; stack copy first below 900px. Section layouts use a narrower explanatory column and wider examples column; collapse below 760px. Spacing scale 4/8/12/16/24/32/48/72px. Small controls radius 6px, example panels 10px, workflow lanes open and connected rather than identical rounded cards. Borders communicate grouping; no pervasive shadows.

```text
Desktop: [wordmark] [Workflow Install Configure Release status] [GitHub]
         [headline, explanation, actions] [illustrative handoff lanes]
         [visible release limitation across width]
         [workflow prose] [role reference + template list]
         [install guidance] [preview / write / launch examples]
         [configure guidance] [JSON + warnings]
         [commands] [release matrix] [FAQ] [source/license footer]
Mobile:  wordmark, wrapping visible nav; headline; actions; limitation;
         workflow lanes stacked; each section in reading order;
         examples scroll internally, never stretch the page.
```

No hamburger needed: visible nav wraps on small screens. No sticky header that obscures anchors. Hover changes are quiet; no autoplay motion or section reveal dependencies. Respect reduced-motion for any optional scroll styling; native instant hash navigation is the default.

## 6. Interaction and accessibility contract

Use header/nav/main/section/footer landmarks, meaningful h2/h3 order, named code blocks, native links and buttons. Tap targets at least 44px in either dimension where layout permits. A 3px cobalt focus outline with offset is never clipped. Meet WCAG 2.2 AA contrast/reflow/focus expectations; automated checks supplement manual reading-order and keyboard review.

Copy buttons are hidden in raw HTML and become visible after enhancement initializes. Each has an accessible name such as “Copy install preview command”, a `data-copy-target` pointing to exactly one code element, and a nearby polite live region. Copy reads code.textContent, excluding labels and buttons; preserve quotes, JSON whitespace and literal identifiers. Await clipboard success before announcing “Copied”. On denial, unavailable clipboard API or insecure context, say “Copy unavailable. Select the command text and copy it manually.” Do not lie about success, inject text, auto-copy, steal focus or depend on deprecated execCommand. Reset local feedback on the next action; rapid/repeated independent clicks cannot announce stale success for a different block. No clipboard permission prompt on page load.

Without JavaScript, anchors, all examples, status notes and native FAQ remain usable; no dead copy controls. Code panels use overflow:auto, keyboard focusability and an accessible label when scrollable; 320px layout and 200% zoom have no page-wide overflow. Literal lines are not rewritten to fit. All external links work in the same tab by default. SVG illustration is decorative when equivalent text is present. No reliance on font loading, connection to npm, hover, animation or color alone.

## 7. Content and build contracts

Keep authored copy, inventories, examples and source URLs in `site/src/content.mjs`, consumed by renderer and checks. Explicitly distinguish `status: released | prompt-guided | development`. Do not blindly ingest README or uncommitted CLI text. An immutable expected release inventory lives in `site/tests/fixtures/release-contract.json` and is cross-checked against reviewed source at HEAD; tests must not merely compare renderer to the same incorrect data.

Static site scripts must resolve filesystem paths relative to their own URL, run on Windows and POSIX, and write only under site/dist or site test output folders. Build fails on invalid content, missing template markers, duplicate IDs, invalid JSON examples or missing assets. Escape text/attributes during HTML rendering; authored snippets are text, not executable HTML. No root clean/build command and no import of src/cli/index.ts. Deterministic rebuilds with identical inputs produce identical output bytes; .nojekyll is intentional.

Verification layers: source-backed content tests; rendered HTML/link checks; build isolation checks; browser behavior tests at both base paths; automated axe accessibility scan; manual visual/keyboard/no-JS/zoom review. Network checks are an optional separately authorized read-only audit: offline structural checks cannot prove a remote branch or URL currently exists. Any external link that cannot be verified must be reported, never relabelled as passing. Do not treat fake local test output as provider/plugin runtime validation.

## 8. Review and approval gate

Before implementation, review the release truth matrix, installer plugin-array and @latest warnings, exact examples, workbench aesthetic, subtree boundaries and test gates. Approve or amend both documents first. The supplied coding constraint is DeepSeek exclusively for later code work (`opencode-go/deepseek-v4.1-flash`); this plan does not authorize a different model or agent. GitHub Pages publication, metadata changes and CLI bug fixes need separate scopes.
