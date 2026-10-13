# opencode-teamwork landing site

An isolated, dependency-light static landing page for the `opencode-teamwork`
plugin. This package is `private`, owns its own lockfile, and never publishes or
touches the root plugin package, its `dist/` or its manifests.

The page documents release **0.2.1**, reviewed against the source at commit
`70c1dbaa07819f0b9612f032d27ca5ffd626fe04`. The published registry artifact's
`gitHead` differs from that local commit, so this page claims only that reviewed
**behavior** matches the source — never that the published build is a
byte-identical artifact. Workflows are described as prompt-owned; the
unpublished `teamwork-review-build` v0.3.0 effort is labelled development-only
and is never paired with an install control.

## Layout

| Path | Responsibility |
|---|---|
| `src/content.mjs` | reviewed, source-backed copy, snippets, inventories, warnings |
| `src/page.html` | semantic template with named insertion markers |
| `src/render.mjs` | escaping, semantic HTML rendering, marker validation |
| `src/styles.css` | handoff-workbench visual system, responsive + print rules |
| `src/enhance.mjs` | browser-only copy enhancement with honest feedback |
| `public/favicon.svg` | original handoff-bracket mark |
| `scripts/build.mjs` | deterministic, contained build to `dist/` |
| `scripts/check-links.mjs` | structural link/fragment/asset validation |
| `scripts/serve.mjs` | loopback test server, both base paths, no SPA fallback |
| `scripts/global-setup.mjs` | builds once before browser tests |
| `playwright.config.mjs` | desktop/mobile projects at `/` and `/OpenCode-Team/` |

Build output (`dist/`): `index.html`, `assets/styles.css`, `assets/enhance.js`,
`assets/favicon.svg`, `.nojekyll`.

## Commands

```sh
npm --prefix site install        # site-local dependencies only
npm --prefix site test           # node:test unit/content/render/build/link checks
npm --prefix site run build      # deterministic build to site/dist
npm --prefix site run check:links
npm --prefix site run test:browser
npm --prefix site run verify     # test && build && check:links && test:browser
```

Preview locally (loopback only):

```sh
npm --prefix site run build
npm --prefix site run serve      # http://127.0.0.1:4174/
# project path variant:
SERVE_BASE=/OpenCode-Team/ SERVE_PORT=4175 npm --prefix site run serve
```

## Measured environment

- Windows (win32), Node `v26.7.0`, npm `11.19.0`.
- `@playwright/test` 1.64.0 (Chromium build 1248), `@axe-core/playwright` 4.13.0,
  `parse5` 8.0.1. Versions were resolved from npm metadata at implementation time.
- Browser binaries were installed with `playwright install chromium` (recorded in
  `test-results/logs/browser-install.log`).

## Test results

Run the suites rather than trusting a frozen number; counts move as tests are
added. The exact gate is:

```sh
npm --prefix site test           # node --test: content/render/build/serve/links/source-behavior
npm --prefix site run build
npm --prefix site run check:links
npm --prefix site run test:browser
npm --prefix site run verify     # test && build && check:links && test:browser
```

Last observed on Windows, Node `v26.7.0`: **41 node tests pass** (0 skipped) and
**150 browser tests pass** with **6 skipped**, exit 0. The durable log is
`site/test-results/repair-r3/verify-r3.log`.

The 6 skips are conditional and explicitly reasoned, never silent passes:

- `project_base_without_trailing_slash_redirects_preserving_query` (2 skips, at
  `desktop-root` and `mobile-root`): skip reason "root base has no project
  directory redirect". The project bases still run and pass it.
- `actual_200_percent_browser_zoom_is_verified_or_explicitly_skipped` (4 skips,
  one per project): real keyboard browser zoom is unavailable in this headless
  environment, so no actual-zoom reflow is claimed. The measured attempt is
  recorded under `site/test-results/repair-r3/zoom-attempt-<project>.json`.

Browser projects: `desktop-root`, `desktop-project`, `mobile-root`,
`mobile-project` — every spec runs at both `/` and `/OpenCode-Team/`.

### Honest TDD sequence

- **Task 1** has a genuine RED: the content tests were run before
  `src/content.mjs` existed and failed with `ERR_MODULE_NOT_FOUND`
  (`test-results/logs/task1-red.log`), then passed GREEN.
- **Tasks 2–5** tests were authored alongside their implementations rather than
  strictly RED-first. That order was not preserved. To compensate, each area
  includes negative tests that prove detection: renderer rejects duplicate and
  missing markers and duplicate content ids; the link checker reports broken
  fragments, missing assets, root-absolute paths, traversal and duplicate ids;
  `unsafe_configuration_promises_are_rejected` fails on unsafe claims; and the
  copy spec exercises denied, throwing, pending and out-of-order clipboard
  adapters.

### Controller review repairs (second pass)

Three repairs were made after an independent review:

1. **Wording.** The hero workflow list no longer asserts an enforced human gate.
   The Review step now reads "Verifier checks evidence; human approval is
   recommended", matching the workflow prose.
2. **Scoped copy targets.** `resolveTarget` no longer falls back to
   `ownerDocument.getElementById`. A control binds only when exactly one
   `<code>` element with its `data-copy-target` id exists *inside the passed
   root*; missing, duplicate and non-code targets keep the control hidden.
   Browser regression tests (`outside_root_target_leaves_control_hidden`,
   `duplicate_target_ids_leave_control_hidden`, `non_code_target_leaves_control_hidden`)
   first failed genuinely against the old implementation
   (`test-results/logs/repair-copy-red.log`) and pass after the fix
   (`test-results/logs/repair-copy-green.log`).
3. **Feedback bracket.** The desktop handoff diagram now draws a restrained
   cobalt bracket that traces the review lane back to the work lane. The bracket
   is decorative (`aria-hidden`), and a visible "Revise after findings" feedback
   line is exposed to assistive technology.

### Documentation repair (third pass)

A second bounded repair aligned the page with reviewed 0.2.1 behavior. RED was
captured first (`.hermes/landing-repair-r2/red-node.log`,
`.hermes/landing-repair-r2/red-browser.log`) before these edits:

1. **Config honesty.** The configuration section, JSON caption, adjacent warning
   and the model FAQ now state that the 0.2.1 config hook replaces every team
   role with its prompt body, so per-role `model`/`temperature` in the JSON do
   **not** govern runtime; model selection follows host defaults. No fix is
   promised.
2. **Uninstall data-loss warning.** An explicit warning listing the dropped
   top-level keys (`provider`, `theme`, `permission`) with backup/restore
   guidance now immediately precedes the uninstall command.
3. **Source-backed behavior tests.** `tests/source-behavior.test.mjs` executes the
   config hook and the uninstall routine extracted from read-only
   `git show <commit>:<path>` at the release commit, in an isolated VM with
   stubs. It pins prompt-only role rewriting and the dropped-keys behavior
   without touching a real config.
4. **Project-path redirect.** `scripts/serve.mjs` now redirects the exact bare
   `/OpenCode-Team` path to `/OpenCode-Team/` (query preserved), and still never
   serves an SPA fallback.
5. **Hero semantics.** The responsibility lanes are now the semantic `<ol>/<li>`
   list; the duplicate visible text list was removed and the decorative bracket
   stays `aria-hidden`.

### Test-overclaim repair (fourth pass)

A bounded pass removed overclaims from the browser specs while preserving every
truthful release disclaimer. Only files under `site/` changed.

1. **Native clipboard, real claim.** Added
   `native_clipboard_round_trip_preserves_multiline_json_modulo_crlf`, which uses
   the page's production clipboard path and the OS clipboard. The old
   "without typographic changes" assertion against an injected stub writer was
   renamed to `injected_writer_receives_parseable_multiline_json_unchanged` and
   scoped in a comment to the adapter contract only. A negative test,
   `clipboard_normalization_detects_non_crlf_corruption`, proves the CRLF-to-LF
   normalization is minimal.
2. **Computed accessibility.** The `textContent` name check was replaced by
   `copy_controls_expose_button_role_and_computed_accessible_name`, asserting
   button role and the computed accessible name (via the browser accessibility
   mapping) against the authored `copyLabel`.
3. **Full focus coverage.** The first-12-elements focus test became a walk of
   every reachable control in real tab order plus a dedicated code-scroll-
   container test, checking visible focus rings, bounded geometry inside the
   snippet and viewport, and `auto`/`scroll` overflow.
4. **Honest zoom.** Added a real-zoom attempt (skipped with a reasoned message
   when unavailable) and a distinction test separating browser zoom from CDP
   page scale and the CSS viewport-width proxy.

## Screenshot evidence

Captured by `tests/visual.spec.mjs` under
`test-results/screenshots/<project>/<width>.png` and `<width>-full.png` for
widths **320, 375, 768, 1440** at both base paths. A screenshot existing is not
visual approval; the screenshots were captured, not human-reviewed here.

## Native clipboard evidence

`tests/copy.spec.mjs` includes a native round-trip test that writes through the
page's own production `navigator.clipboard` adapter, then reads the OS clipboard
back with `navigator.clipboard.readText()`. On this Windows host the clipboard
returns the multiline JSON example with **CRLF** (`\r\n`) line endings. The test
therefore applies exactly one normalization — CRLF to LF — and asserts that
every other character is byte-retained (`withoutCr === source`) and that both
the raw and normalized text parse as JSON. A companion negative test proves the
normalization does not mask any corruption other than a CRLF line ending. This
is evidence about the native clipboard; it is not a claim about any other
platform or a screen reader.

## Browser zoom evidence

The suite attempts **real** 200% browser zoom via keyboard browser UI
(`Control+=` / `Control+NumpadAdd`) and measures `devicePixelRatio` and
`innerWidth` before and after. In this headless Chromium the zoom keys have no
effect (`devicePixelRatio` stays `1`), so the test skips with an explicit reason
and makes **no actual-zoom claim**; the measurement is written to
`site/test-results/repair-r3/zoom-attempt-<project>.json`.

A separate always-passing test records the distinction that matters:

- **Browser zoom** (unavailable here) would change `devicePixelRatio` *and* the
  CSS layout viewport.
- **CDP `Emulation.setPageScaleFactor(2)`** changes only
  `visualViewport.scale`; `devicePixelRatio` and `innerWidth` are unchanged. It
  is pinch/page-scale, **not** browser zoom.
- A **CSS viewport-width change** (half the CSS width) is used only as a
  labelled reflow *proxy* and is never reported as actual zoom.

At the proxy and at 320/375px widths the page shows no horizontal overflow,
every reachable control receives a visible focus ring with its focus box inside
the viewport, and each code scroll container owns horizontal scrolling with an
inset focus ring that cannot be clipped by its snippet. Actual 200% browser
zoom, like screen-reader traversal, remains an open gate.

## Explicit blockers (not passed)

- **Actual browser zoom (200%)** and **screen-reader traversal** could not be
  observed in this environment. Reflow was verified at 320/375/768px widths, at
  the labelled CSS viewport-width proxy and with `prefers-reduced-motion`, but
  viewport emulation and page-scale are not proof of real zoom, and no screen
  reader was available. These gates remain open; no actual-zoom or
  screen-reader claim is made anywhere.
- **Remote URL reachability** was not audited. External destinations (npm,
  GitHub repository/issues/license, development branch) are checked
  structurally only and are not claimed reachable.
- No GitHub Pages workflow, CNAME, canonical URL or npm publication exists or is
  claimed.

## Boundaries

- The root `package.json`, lockfiles, `README.md`, `SKILL.md`, `src/cli/index.ts`,
  all `docs/` and `dist/` are untouched and byte-preserved.
- Before editing, the 21 files listed in `.hermes/landing/baseline.json` were
  hashed into `site/test-results/repair-r3/baseline-src-manifest.json` (baseline,
  before and after values). After `verify`, all 21 hashes were unchanged. No git
  commit, push, publish, deploy or global install was run.
- The site build writes only inside `site/dist`; tests write only inside
  `site/test-results`. No network calls occur during the build.
