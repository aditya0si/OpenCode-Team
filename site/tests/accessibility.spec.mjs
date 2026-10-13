import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { landingContent } from "../src/content.mjs";

async function seriousViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

test("axe_has_no_serious_or_critical_violations", async ({ page }) => {
  await page.goto("./");
  const initial = await seriousViolations(page);
  expect(initial, JSON.stringify(initial, null, 2)).toEqual([]);

  await page.locator(".faq-item summary").first().click();
  await expect(page.locator(".faq-item").first()).toHaveAttribute("open", "");
  const open = await seriousViolations(page);
  expect(open, JSON.stringify(open, null, 2)).toEqual([]);
});

test("landmarks_and_heading_order_are_meaningful", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator("header.site-header")).toHaveCount(1);
  await expect(page.locator("main#main")).toHaveCount(1);
  await expect(page.locator("footer.site-footer")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);

  const headings = await page.locator("h1, h2, h3").evaluateAll((nodes) =>
    nodes.map((n) => Number(n.tagName.slice(1))),
  );
  expect(headings[0]).toBe(1);
  for (let i = 1; i < headings.length; i += 1) {
    expect(headings[i] - headings[i - 1]).toBeLessThanOrEqual(1);
  }
});

// Assert the *computed* accessible name and role through the browser's own
// accessibility mapping, not raw textContent. Each control must expose a
// button role and the accessible name authored in content.mjs.
test("copy_controls_expose_button_role_and_computed_accessible_name", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator(".copy-button").first()).toBeVisible();

  const controls = landingContent.snippets.map((snippet) => ({
    target: `snippet-${snippet.id}`,
    name: snippet.copyLabel ?? `Copy ${snippet.label}`,
  }));
  expect(controls.length).toBeGreaterThan(0);

  for (const control of controls) {
    const button = page.locator(`.copy-button[data-copy-target="${control.target}"]`);
    await expect(button, `${control.target} has a button role`).toHaveRole("button");
    await expect(button, `${control.target} has its authored accessible name`).toHaveAccessibleName(
      control.name,
    );
  }
});

test("reduced_motion_does_not_hide_content", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  await expect(page.locator("h1")).toBeVisible();
  for (const id of ["workflow", "install", "configure", "release-status", "faq"]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
  const feedbacks = await page.locator(".copy-feedback").count();
  expect(feedbacks).toBeGreaterThan(0);
});
