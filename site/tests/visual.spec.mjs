import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { landingContent } from "../src/content.mjs";

const SHOT_ROOT = fileURLToPath(new URL("../test-results/screenshots/", import.meta.url));
const EVIDENCE_ROOT = fileURLToPath(new URL("../test-results/repair-r3/", import.meta.url));
const WIDTHS = [320, 375, 768, 1440];

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), summary, [tabindex="0"]';

function configJsonText() {
  return landingContent.snippets.find((s) => s.id === "config-json").text;
}

async function box(page, selector) {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  const b = await el.boundingBox();
  if (!b) throw new Error(`no bounding box for ${selector}`);
  return b;
}

test("desktop_hero_has_two_columns", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("./");
  const copy = await box(page, ".hero-copy");
  const handoff = await box(page, ".handoff");
  expect(handoff.x).toBeGreaterThan(copy.x + copy.width - 2);
  const vOverlap = Math.min(copy.y + copy.height, handoff.y + handoff.height) - Math.max(copy.y, handoff.y);
  expect(vOverlap).toBeGreaterThan(0);
});

test("mobile_reading_order_is_copy_first", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  await page.goto("./");
  const copy = await box(page, ".hero-copy");
  const handoff = await box(page, ".handoff");
  expect(copy.y).toBeLessThan(handoff.y);
  expect(Math.abs(copy.x - handoff.x)).toBeLessThan(2);
});

test("nav_remains_visible_without_hamburger", async ({ page }) => {
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("./");
    const links = page.locator(".site-nav a");
    const count = await links.count();
    expect(count).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < count; i += 1) {
      await expect(links.nth(i)).toBeVisible();
    }
    await expect(page.locator("button[aria-label*='enu' i]")).toHaveCount(0);
    await expect(page.locator(".hamburger, .menu-toggle")).toHaveCount(0);
  }
});

test("code_scrolls_without_page_overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("./");
  const metrics = await page.evaluate(() => {
    const de = document.documentElement;
    const code = [...document.querySelectorAll(".code")].find((c) =>
      c.textContent.includes('"plugin"'),
    );
    const cs = code ? getComputedStyle(code) : null;
    return {
      pageOverflow: de.scrollWidth - de.clientWidth,
      codeOverflowX: cs ? cs.overflowX : null,
      codeText: code ? code.textContent : null,
      codeScrolls: code ? code.scrollWidth > code.clientWidth : false,
    };
  });
  expect(metrics.pageOverflow).toBeLessThanOrEqual(1);
  expect(["auto", "scroll"]).toContain(metrics.codeOverflowX);
  expect(metrics.codeText).toBe(configJsonText());
  expect(metrics.codeText.split("\n").length).toBe(15);
});

// Every reachable control (links, buttons, summaries, code scroll containers)
// is walked in real tab order: each one must receive a visible focus ring and
// its border box must stay inside the horizontal viewport. The first Tab is
// pinned to the skip link, preserving the previous guarantee.
//
// Scope: this asserts the focused element's border box geometry, not every
// painted outline pixel. The outline stroke (3px plus a 2px offset) could brush
// a viewport edge for a box flush against it; the inset `.code` ring is covered
// separately by code_scroll_containers_are_focusable_with_inset_focus_ring.
test("all_reachable_controls_receive_visible_focus_within_viewport", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("./");
  await expect(page.locator(".copy-button").first()).toBeVisible();

  const reachable = await page.evaluate((selector) => {
    const candidates = [...document.querySelectorAll(selector)].filter((el) => {
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    candidates.forEach((el, index) => el.setAttribute("data-focus-probe", String(index)));
    return candidates.map((el) => ({
      index: el.getAttribute("data-focus-probe"),
      tag: el.tagName,
    }));
  }, FOCUSABLE_SELECTOR);

  expect(reachable.length, "the page exposes more than a handful of controls").toBeGreaterThan(8);

  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });

  for (let index = 0; index < reachable.length; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        probe: el.getAttribute("data-focus-probe"),
        tag: el.tagName,
        className: String(el.className),
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth),
        left: rect.left,
        right: rect.right,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    expect(state.probe, `tab #${index} leaves the reachable control set`).not.toBeNull();
    expect(state.probe, `tab #${index} must follow DOM order`).toBe(String(index));
    expect(state.outlineStyle, `focus ring on ${state.tag}.${state.className}`).not.toBe("none");
    expect(state.outlineWidth, `focus ring width on ${state.tag}`).toBeGreaterThanOrEqual(3);
    expect(state.left, `left edge inside viewport for ${state.tag}`).toBeGreaterThanOrEqual(-1);
    expect(state.right, `right edge inside viewport for ${state.tag}`).toBeLessThanOrEqual(
      state.viewportWidth + 1,
    );
  }
});

// Each code block is a focusable scroll container: focus must be visible, the
// container must own horizontal scrolling, and its focus box must not spill
// outside its snippet. `.code:focus-visible` uses `outline-offset: -3px`, so the
// ring is drawn inside the element and cannot be clipped by the snippet's
// `overflow: hidden`; that is why "unclipped" is claimed for code blocks only.
test("code_scroll_containers_are_focusable_with_inset_focus_ring", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("./");

  const blocks = page.locator("pre.code");
  const count = await blocks.count();
  expect(count, "at least one code scroll container exists").toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    const block = blocks.nth(index);
    await expect(block).toHaveAttribute("tabindex", "0");
    await block.evaluate((el) => el.focus());
    const state = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const snippet = el.closest(".snippet").getBoundingClientRect();
      return {
        tag: el.tagName,
        outlineStyle: cs.outlineStyle,
        outlineWidth: parseFloat(cs.outlineWidth),
        overflowX: cs.overflowX,
        insideSnippet: rect.left >= snippet.left - 1 && rect.right <= snippet.right + 1,
        insideViewport: rect.left >= -1 && rect.right <= document.documentElement.clientWidth + 1,
      };
    });
    expect(state.tag).toBe("PRE");
    expect(state.outlineStyle).not.toBe("none");
    expect(state.outlineWidth).toBeGreaterThanOrEqual(3);
    expect(["auto", "scroll"]).toContain(state.overflowX);
    expect(state.insideSnippet, "code focus box stays inside its snippet").toBe(true);
    expect(state.insideViewport, "code focus box stays inside the viewport").toBe(true);
  }
});

test("captures_screenshot_evidence", async ({ page }, testInfo) => {
  const project = testInfo.project.name;
  const dir = join(SHOT_ROOT, project);
  mkdirSync(dir, { recursive: true });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("./");
    await page.screenshot({ path: join(dir, `${width}.png`) });
    await page.screenshot({ path: join(dir, `${width}-full.png`), fullPage: true });
  }
});

// Attempt real 200% browser zoom through browser UI (keyboard zoom), recording
// the measured devicePixelRatio / innerWidth. Real browser zoom changes BOTH
// the device pixel ratio and the CSS layout viewport; nothing else here does.
// If the environment ignores keyboard zoom, this test skips with an explicit
// reason instead of making an unsupported actual-zoom claim.
test("actual_200_percent_browser_zoom_is_verified_or_explicitly_skipped", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("./");

  const read = () =>
    page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      visualScale: window.visualViewport ? window.visualViewport.scale : null,
    }));

  const before = await read();
  for (let i = 0; i < 10; i += 1) await page.keyboard.press("Control+=");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Control+NumpadAdd");
  await page.waitForTimeout(250);
  const after = await read();

  const zoomed =
    after.dpr >= before.dpr * 1.9 && after.innerWidth <= before.innerWidth / 1.9;
  const evidence = { project: testInfo.project.name, before, after, zoomed };
  mkdirSync(EVIDENCE_ROOT, { recursive: true });
  writeFileSync(
    join(EVIDENCE_ROOT, `zoom-attempt-${testInfo.project.name}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf-8",
  );
  await testInfo.attach("browser-zoom-attempt.json", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });

  if (!zoomed) {
    test.skip(
      true,
      `headless Chromium ignored keyboard browser zoom (devicePixelRatio ${before.dpr} -> ${after.dpr}, innerWidth ${before.innerWidth} -> ${after.innerWidth}); actual 200% browser zoom is not observable here, so no actual-zoom reflow claim is made`,
    );
    return;
  }

  // Only reached when real zoom is observed: prove the page reflows without
  // horizontal overflow at the true (zoomed) layout viewport.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "no horizontal page overflow at 200% browser zoom").toBeLessThanOrEqual(1);
});

// Proves the distinction the other zoom test relies on. CDP page scale is
// pinch/visual-viewport scaling, NOT browser zoom: it changes
// visualViewport.scale but leaves devicePixelRatio and the layout viewport
// untouched. A CSS viewport-width change is a documented stand-in for reflow,
// and is labelled as a proxy, never as actual zoom.
test("page_scale_is_not_browser_zoom_and_width_proxy_is_labelled", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("./");

  const read = () =>
    page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      visualScale: window.visualViewport ? window.visualViewport.scale : null,
    }));

  const before = await read();
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await page.waitForTimeout(100);
  const after = await read();

  expect(after.visualScale, "CDP page scale doubles the visual viewport scale").toBeGreaterThan(
    before.visualScale,
  );
  expect(after.dpr, "page scale must not be mistaken for browser zoom (DPR unchanged)").toBe(
    before.dpr,
  );
  expect(after.innerWidth, "page scale leaves the layout viewport unchanged").toBe(
    before.innerWidth,
  );

  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await session.detach();

  // Documented CSS viewport-width proxy: half the CSS width approximates 200%
  // reflow. This is explicitly a proxy, not actual browser zoom.
  await page.setViewportSize({ width: Math.round(before.innerWidth / 2), height: 900 });
  await page.goto("./");
  const proxyOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(proxyOverflow, "no horizontal overflow at the CSS width proxy").toBeLessThanOrEqual(1);
});
