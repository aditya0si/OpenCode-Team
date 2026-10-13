# Orchestration Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. These workflow references do not override the approved DeepSeek-only coding constraint.

**Goal:** Build an honest, accessible orchestration landing page with usable install, workflow and configuration examples, without altering the released plugin.

**Architecture:** An isolated `site/` package renders a single semantic HTML page from curated, source-backed content. A small ES module enhances copy controls; static CSS and relative asset paths keep the artifact compatible with a future GitHub Pages project path. No runtime service, plugin import or backend is required.

**Tech Stack:** Node ES modules and node:test; HTML/CSS; Playwright browser tests, @axe-core/playwright accessibility scans, and parse5 for structural HTML checks, all site-local development dependencies. Resolve concrete compatible dependency versions at implementation time and commit only the site-local lockfile once separately authorized; this document does not assert current library versions.

**Spec:** `docs/superpowers/specs/2026-10-13-orchestration-landing-design.md`

## Global Constraints

- This assignment writes only this spec and its accompanying plan. Later implementation requires review.
- No product code, installation, git mutation, service, release, deployment, analytics, or publication is authorized here.
- Existing README.md, SKILL.md, src/cli/index.ts modifications and all preexisting docs/review-pivot files are user-owned and must remain untouched.
- The root plugin package/scripts/lockfile remain unchanged; site/package.json is private and owns its lockfile.
- Preserve `opencode-teamwork`, `.`, `./server`, `./templates`, `TeamPlugin`, `id`, `server`, `setup`, all `team/*` role IDs, slash commands and template IDs.
- The supplied coding constraint is DeepSeek exclusively for later code work (`opencode-go/deepseek-v4.1-flash`); this plan does not authorize a different model or agent.
- Publication of 0.2.1 and the separate unpublished `teamwork-review-build` v0.3.0 development effort are supplied context, not a fresh registry audit.
- No root-absolute local paths, SPA fallback, known future domain, canonical URL, CNAME or Pages workflow.
- Provider authentication and fees are separate from this package.
- No implementation step is executed as part of preparing this plan. All commands below are future execution instructions.

## Review Focus

1. Installer pinning: a pinned installer still writes @latest; the visible warning and pinned manual config must agree (Task 1 and Task 5).
2. Existing configuration: plugin arrays may be replaced; no preservation promise, --reset default CTA or doctor --config example may slip in (Task 1 and Task 5).
3. Host environment: clipboard absent/denied/insecure and JavaScript disabled must retain readable, manually copyable examples and navigation (Task 3 and Task 5).
4. Hosting location: `/OpenCode-Team/` must work without SPA fallback, including fragments, module MIME and relative assets (Task 2 and Task 5).
5. Small/zoomed windows: long JSON/commands, wrapped nav and focus must not cause page-wide overflow or hidden content (Task 4 and Task 5).

## Execution preparation and preservation gate

At authorized implementation start, inspect current status and read both documents. Record HEAD, tracked diff and SHA-256 hashes of README.md, SKILL.md, src/cli/index.ts, root package.json, root lockfiles and every existing docs file. Do not stash, reset, checkout, stage or rewrite user-owned changes. If a planned `site/` path already exists, read it and stop to reconcile rather than overwrite. Re-read actual release source; if HEAD/package version or published status changed, amend the content contract through review instead of silently merging the development engine narrative into this page.

Use the committed 0.2.1 CLI, not its working-copy modifications, for release preset/flag assertions. Obtain it via read-only `git show 70c1dbaa07819f0b9612f032d27ca5ffd626fe04:src/cli/index.ts`; do not checkout that revision. No installer is ever run against the user's actual OpenCode configuration. The landing page is documentation, not a new CLI test mandate.

Future commands use `npm --prefix site ...` from `C:/Users/oliad/Desktop/opencodeteam`. Tool versions/prerequisites must be discovered before installs; permission to implement does not automatically authorize deployment, registry publication or changes outside site/. If installing browser binaries is blocked, report the browser gate as blocked instead of calling it passed.

## Exact future file map

| File | Responsibility |
|---|---|
| site/package.json | private package, scripts and site-local dev dependencies only |
| site/package-lock.json | locked site dependencies, never root dependency resolution |
| site/.gitignore | dist/, node_modules/, test-results/, playwright-report/ |
| site/README.md | local build/test commands, evidence checklist, publication out of scope |
| site/src/content.mjs | reviewed copy, snippets, status matrix, inventories and external destinations |
| site/src/page.html | semantic template skeleton, metadata, section/slot markers |
| site/src/render.mjs | validation, escaping and deterministic HTML rendering |
| site/src/styles.css | workbench tokens, layout, focus, responsive and print rules |
| site/src/enhance.mjs | browser-only copy enhancement and honest feedback |
| site/public/favicon.svg | original simple handoff bracket, no borrowed marks |
| site/scripts/build.mjs | isolated deterministic build to site/dist |
| site/scripts/check-links.mjs | structural link/fragment/asset checks on generated HTML |
| site/scripts/serve.mjs | future test-only static server at root/project base, no path traversal |
| site/playwright.config.mjs | desktop/mobile projects and controlled test webServer |
| site/tests/fixtures/release-contract.json | independent reviewed release identifiers and expected literal snippets |
| site/tests/content.test.mjs | source/contract/copy/JSON status assertions |
| site/tests/render.test.mjs | HTML escaping, semantics, anchors and no-JS document structure |
| site/tests/build.test.mjs | output inventory, deterministic bytes, no outside writes |
| site/tests/links.test.mjs | missing/local/remote link rules and base-path validation |
| site/tests/copy.spec.mjs | clipboard success/failure/repeated click behavior |
| site/tests/navigation.spec.mjs | anchors, project-path assets, no-JS FAQ/navigation |
| site/tests/accessibility.spec.mjs | axe, focus, zoom/reflow and reduced-motion behavior |
| site/tests/visual.spec.mjs | screenshot evidence, overflow and layout checks |

No preexisting file is to be modified. site/dist and site/test-results are generated and ignored. An initial read-only repository baseline is evidence, not an additional committed implementation file. No .github workflow is included.

## Script and data interfaces

Future site/package.json scripts:

```json
{
  "test": "node --test tests/*.test.mjs",
  "build": "node scripts/build.mjs",
  "check:links": "node scripts/check-links.mjs",
  "test:browser": "playwright test",
  "verify": "npm run test && npm run build && npm run check:links && npm run test:browser"
}
```

Run test/build in site cwd as npm --prefix establishes it. Package scripts use forward-slash relative paths and no rm/cp/sed shell utilities. The package must contain `private: true` and `type: module`. Select a Node version supported by the chosen testing dependencies at execution time and document the measured version, not an invented product prerequisite.

Content shape, exported as `landingContent` from site/src/content.mjs:

- `documentedRelease: '0.2.1'`, `releaseCommit: '70c1dbaa07819f0b9612f032d27ca5ffd626fe04'`.
- `roles: Array<{id: string, description: string}>`; `commands` and `patterns` have the same shape.
- `snippets: Array<{id: string, label: string, language: 'sh'|'text'|'json', text: string}>`.
- `sections: Array<{id: string, heading: string, paragraphs: string[]}>`; section-specific tables/list data remain explicit properties rather than raw arbitrary HTML.
- `releaseRows: Array<{status: 'released'|'prompt-guided'|'development', title: string, text: string}>`.
- `links: Record<string, {label: string, href: string}>`; HTTPS source/npm/license/issue links, no unknown deployed URL.
- `warnings: {installerPin: string, pluginArray: string, preview: string, provider: string}`; exact meaning and visible placement fixed by spec.

`validateContent(content): void` throws actionable Error on missing/duplicate IDs, unknown status, inventory mismatch, forbidden claims, malformed JSON or invalid scheme. `renderPage(content, template): string` produces escaped semantic HTML. Snippets render `<pre><code id="snippet-ID">` and enhanced controls reference that ID. Template uses named explicit insertion markers; renderer rejects unfilled or duplicate markers.

`buildSite({sourceDir, publicDir, outputDir}): Promise<string[]>` writes only inside the resolved site/dist allowed directory, returns sorted relative emitted paths and rejects an outside outputDir. Test fixtures use explicitly permitted site/test-results directories through a test-only temp build helper, never root dist. CLI entry catches errors and exits nonzero.

`checkLocalLinks({html, outputDir, basePath}): string[]` returns errors, empty on success; validates href/src references and fragments using parsed HTML, URL resolution and filesystem containment, distinguishing external HTTPS destinations from local assets. `serveSite({rootDir, basePath, port}): Promise<{url: string, close: () => Promise<void>}>` serves site/dist only, correct content types, 404 for missing assets/paths, rejects decoded traversal, and never provides an SPA fallback. Test harness closes it on completion.

`enhanceCopy(root: Document|HTMLElement, writeText: (text: string) => Promise<void>): void` binds exactly once, reveals copy buttons only when bound, uses targets within root and textContent, and keeps feedback per block. The production initializer supplies navigator.clipboard.writeText or a rejecting adapter. Import does not require a DOM in Node tests; browser initialization is guarded. No copying on page load.

## Task 1: Pin the release-backed content contract

**Files:** Create site/package.json, site/package-lock.json, site/.gitignore, site/src/content.mjs, site/tests/fixtures/release-contract.json, site/tests/content.test.mjs.

**Consumes:** reviewed spec, package.json and committed CLI/template source at the stated release commit.
**Produces:** landingContent and validateContent interface; independent fixture with exact inventory, commands, warnings and release status expectations.

- [ ] Write failing node:test cases named `release_identity_is_preserved`, `inventories_match_reviewed_source`, `install_examples_use_released_preset`, `installer_pin_warning_is_required`, `configuration_is_valid_complete_json`, `development_never_appears_as_released`, `unsafe_configuration_promises_are_rejected`. Assert 10 unique role IDs, 7 unique command IDs, 6 unique pattern IDs and the exact lists from the spec. Assert five committed preset IDs; opencode-free/opencode-go/opencode-zen and --preset custom do not appear as released install examples. Parse the JSON snippet and require every role, exact pinned plugin entry and literal anthropic model ID.
- [ ] Run `npm --prefix site test`; record the genuine RED failure (missing content/validator), not an install failure. Minimal package/test scaffolding belongs to this task; site-only dependency installation is conditional on implementation authorization.
- [ ] Author content and fixture. Use complete spec copy, not placeholder paragraphs, raw README ingestion or generated testimonials. Include installer-array and @latest warnings, proposed-patch caveat, doctor limitations, five FAQ answers, all exact snippet texts, and status-labelled development link. Fixtures must be reviewed against source independently of content data.
- [ ] Implement validateContent; required examples are literal contract checks and JSON is parsed rather than matched with a substring. Flag unqualified claims such as “guaranteed isolation”, “enforced budget” and “resume-safe engine” in released copy. Treat a denylist as supplemental, not proof that all nuanced claims are safe.
- [ ] Run `npm --prefix site test`; expect all content tests passing. Human reviewer verifies attribution-free independent branding and matrix truth. No prices, benchmark assertions, provider recommendation or current model availability claims.

## Task 2: Render and build a working no-JS document

**Files:** Create site/src/page.html, site/src/render.mjs, site/scripts/build.mjs, site/scripts/check-links.mjs, site/public/favicon.svg, site/tests/render.test.mjs, site/tests/build.test.mjs, site/tests/links.test.mjs. Create a minimal site/src/styles.css and site/src/enhance.mjs asset placeholder only to support a real build; interaction/style semantics are owned by Tasks 3–4 and cannot be declared complete here.

**Consumes:** Task 1 content/validator/fixture.
**Produces:** renderPage, buildSite, checkLocalLinks and site/dist artifact contracts above.

- [ ] Write RED cases `single_main_and_h1`, `required_fragments_and_skip_target_exist`, `examples_are_real_text_not_html`, `copy_controls_hidden_until_enhanced`, `source_urls_not_local_repo_paths`, `relative_assets_work_at_both_bases`, `build_is_deterministic_and_contained`, `broken_fragment_or_asset_fails`. Inject a snippet containing `<script>`/quotes and assert escaped text and no script element. Delete an asset in a test fixture and require a failing link check, not an ignored warning. Test traversal paths and duplicate IDs.
- [ ] Run `npm --prefix site test`; confirm these tests fail for the absent renderer/build/link implementations.
- [ ] Implement skeleton and renderer: exact headings, navigation, seven sections, workflow illustration with text equivalent, role/template/command references, separate preview/write/run examples, JSON, warnings and FAQ. Hide copy buttons via HTML hidden attribute; content remains present without browser scripts. Use text escaping and reject unfilled markers.
- [ ] Implement deterministic build and parsed link validation. Output only the five spec artifact paths, include .nojekyll, leave root dist untouched, include favicon and no CNAME/canonical URL. Links to source use the release commit when documenting release templates; only the development source uses the branch destination. No network calls during build.
- [ ] Run `npm --prefix site test && npm --prefix site build && npm --prefix site run check:links`; expect tests PASS, build exit 0 with real inventory, no unresolved local links. Compare two builds byte-for-byte in the test, not filesystem timestamps. Report external destinations separately as structural-only until network audited.

## Task 3: Make copy controls honest and usable

**Files:** Implement site/src/enhance.mjs; create site/tests/copy.spec.mjs, site/scripts/serve.mjs, site/playwright.config.mjs. Extend site/package.json/lockfile only for site-local Playwright dependencies if not added in Task 1.

**Consumes:** generated snippet IDs, hidden buttons, polite feedback elements and build output from Task 2.
**Produces:** enhanceCopy interface and real clipboard behavior; test server/base-path harness used by Task 5.

- [ ] Write RED browser cases `copies_exact_command_without_labels`, `copies_parseable_json_without_typographic_changes`, `success_is_announced_only_after_resolution`, `denied_or_missing_clipboard_explains_manual_copy`, `buttons_reveal_only_after_binding`, `repeated_clicks_keep_feedback_local`, `copy_preserves_keyboard_focus`. Use injected resolving/rejecting/pending clipboard adapters; assert called text equals fixture byte-for-byte. For repeated clicks resolve promises out of order and require no stale cross-block announcement. Target a missing code ID and assert initialization leaves that control hidden or safely unavailable, never throws across the page.
- [ ] Run `npm --prefix site run test:browser -- tests/copy.spec.mjs`; prove RED assertions rather than treating browser launch failure as a behavior failure.
- [ ] Implement enhancement. Await writes, catch permission/API failures, use polite feedback, do not auto-copy or call execCommand, and keep text available for selection. Use buttons with specific accessible names, not an unlabeled icon. Wire initializer after document parsing. No role/model/provider connection.
- [ ] Implement the server and Playwright config for future testing only, loopback-bound, controlled lifecycle, correct JS/CSS/SVG MIME and project base support. Reuse or detect configured test ports; do not silently use an unrelated running service. Close the server after tests. No service is started during planning.
- [ ] Run copy spec plus node tests/build/link check; expect exact text captures, honest error text and preserved focus. Include a browser without clipboard API; tests may mock the adapter to cover insecure-context behavior without launching a public server.

## Task 4: Apply the responsive handoff-workbench design

**Files:** Implement site/src/styles.css; refine site/src/page.html only for necessary semantic layout; create site/tests/visual.spec.mjs and site/tests/accessibility.spec.mjs. Add site-local @axe-core/playwright dependency.

**Consumes:** semantic document and enhanced interactions; spec tokens/layout.
**Produces:** responsive original visual system, screenshot evidence, accessibility assertions.

- [ ] Write RED tests `desktop_hero_has_two_columns`, `mobile_reading_order_is_copy_first`, `nav_remains_visible_without_hamburger`, `code_scrolls_without_page_overflow`, `focus_is_visible_and_not_clipped`, `axe_has_no_serious_or_critical_violations`, `reduced_motion_does_not_hide_content`. Test widths 320, 375, 768 and 1440; assert scrollWidth <= clientWidth for page and check genuinely long code panel text remains unchanged. Assert focus outline by computed style plus screenshot, not only :focus selector existence.
- [ ] Run the two browser specs and capture actual RED failures for unstyled or inaccessible states.
- [ ] Implement named spec tokens, system fonts, hero 55/45 split above 900px, stacked below; two-column sections collapse below 760px; visible wrapping nav, max-width/gutters/spacing, text measure, labeled internally scrollable code and 44px control sizing. Keep warning copy adjacent to commands. Use a static review feedback connector with textual equivalent, not a pretend live graph. No autoplay motion; do not hide content pending animation.
- [ ] Run the specs with axe scans of initial and FAQ-open states; measure actual text/button/focus contrast and fix inappropriate pairings. Test at 200% zoom manually in the browser and at 320px reflow; browser viewport emulation is not itself proof of actual zoom. Inspect screenshots for typography, diagram, spacing, warnings and long IDs at each width.
- [ ] Record screenshot paths and manual findings in site/README.md during Task 5. A screenshot existing is not visual approval; reviewer must inspect it. Do not accept auto-updated snapshots as proof of correctness.

## Task 5: Close content, link, build and browser gates

**Files:** Create site/tests/navigation.spec.mjs and site/README.md; complete all test files and fixture checks without changing product source. No Pages workflow, npm publication or root manifest update.

**Consumes:** complete content, rendered artifact, styles and browser enhancement from prior tasks.
**Produces:** working local static artifact and documented actual evidence with explicit remaining limits.

- [ ] Write RED integration cases `all_navigation_destinations_exist`, `workflow_and_config_are_usable_with_js_disabled`, `faq_works_without_js`, `root_and_project_path_have_no_missing_assets`, `direct_hash_load_reaches_visible_section`, `install_warnings_are_visible_next_to_write_command`, `release_vs_development_is_visible_without_interaction`. Start tests with JS disabled and assert all snippet text, status matrix and warning paragraphs remain; buttons stay hidden. Check HTTP requests for asset status and MIME, console/page errors and navigation to every fragment. Verify development source is not paired with an install button.
- [ ] Run `npm --prefix site run test:browser -- tests/navigation.spec.mjs`; record actual RED for any newly uncovered requirement. If everything is already implemented, temporarily mutate only the test fixture (missing target/warning), prove detection, restore fixture and document this negative-test cycle. Never manufacture a product defect or rewrite user data to obtain RED.
- [ ] Complete any small gaps in site-only files, then run `npm --prefix site run verify`. Expected all node tests PASS, deterministic build exit 0, structural link errors empty, all browser projects PASS, no severe axe violations, no page console errors or failed local requests. No required test may be silently skipped.
- [ ] Manually review keyboard-only traversal (skip link, nav, code scroll, copy, FAQ), clipboard failure recovery, screen-reader heading/landmark/feedback order, reduced motion, 200% zoom and mobile reading order. Store evidence paths/test results and measured environment in site/README.md. Flag any unavailable screen-reader/network/browser gate as blocked and leave completion pending rather than inventing results.
- [ ] If separately authorized, perform read-only HTTPS checks for npm package, repository, release-commit source links, issue tracker, LICENSE and development branch. Record redirect/failure details; offline structural PASS does not imply external reachability. Fix a broken development link by omitting the clickable destination while retaining explicit development status if the branch cannot be confirmed, with review.
- [ ] Compare preservation hashes/status against initial baseline. Only site/ implementation files and the two approved planning documents may be newly present; preexisting hashes and tracked diff must remain identical. Check root npm files whitelist still excludes site/ and no root dist/ manifest/exports/version/scripts changed. Do not run npm pack from the root because prepare may build and modify dist.
- [ ] Ask the human to review the actual site artifact and evidence. Keep git staging/commits as a separate explicit authorization; if later approved, stage only named site files and never `git add .`. Do not deploy, enable Pages, create CNAME, publish npm or claim the URL is live.

## Acceptance checklist and handoff

- [ ] Source-backed release contract: 0.2.1 registration and prompt-owned workflows, unpublished v0.3.0 clearly separate.
- [ ] Complete install/config/workflow examples, truthful warnings for @latest, array replacement, --print/--reset and doctor scope.
- [ ] Preserved package, export, agent, command and pattern identifiers; no replica branding or runtime guarantees.
- [ ] Every CTA is a real fragment/URL/button; exact copying, denied clipboard and no-JS fallback exercised.
- [ ] Original responsive workbench design, visible keyboard focus, contrast, no page overflow and manual zoom/reading-order review.
- [ ] Deterministic isolated build, structural link gate, browser checks at root and project path, no remote runtime dependencies.
- [ ] User-owned files byte-preserved; no install, service, git mutation or publication occurred during planning.

**Execution handoff:** Review both proposed documents first. Later code implementation remains DeepSeek-only using `opencode-go/deepseek-v4.1-flash`; the parent agent can coordinate read-only reviews and verification without substituting another coding model. Neither document authorizes running this plan yet. GitHub Pages deployment and any CLI/configuration bug fix are separate requests.
