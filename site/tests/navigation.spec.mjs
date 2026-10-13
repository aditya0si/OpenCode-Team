import { test, expect } from "@playwright/test";

test("all_navigation_destinations_exist", async ({ page }) => {
  await page.goto("./");
  const hrefs = await page.locator(".site-nav a, .footer-links a").evaluateAll((links) =>
    links.map((a) => a.getAttribute("href")),
  );
  expect(hrefs.length).toBeGreaterThanOrEqual(8);
  for (const href of hrefs) {
    if (href.startsWith("#")) {
      const id = href.slice(1);
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    } else if (href.startsWith("./")) {
      const response = await page.request.get(new URL(href, page.url()).href);
      expect(response.status(), href).toBeLessThan(400);
    } else {
      expect(href.startsWith("https://"), `external link uses https: ${href}`).toBe(true);
    }
  }
});

test("direct_hash_load_reaches_visible_section", async ({ page }) => {
  for (const id of ["install", "configure", "release-status", "faq"]) {
    await page.goto(`./#${id}`);
    await expect(page.locator(`#${id}`)).toBeVisible();
    const inView = await page.locator(`#${id}`).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    expect(inView, `#${id} should be scrolled into view`).toBe(true);
  }
});

test("install_warnings_are_visible_next_to_write_command", async ({ page }) => {
  await page.goto("./#install");
  const write = page.locator('[data-snippet="install-write"]');
  const pin = page.locator("#install .warning", { hasText: "does not pin" });
  const array = page.locator("#install .warning", { hasText: "plugin array" });
  await expect(write).toBeVisible();
  await expect(pin).toBeVisible();
  await expect(array).toBeVisible();

  const order = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("#install .warning, #install .snippet")];
    return nodes.map((n) => ({
      isWrite: n.getAttribute("data-snippet") === "install-write",
      text: n.textContent,
    }));
  });
  const writeIndex = order.findIndex((n) => n.isWrite);
  const arrayIndex = order.findIndex((n) => n.text.includes("plugin array"));
  const pinIndex = order.findIndex((n) => n.text.includes("does not pin"));
  expect(arrayIndex).toBeGreaterThanOrEqual(0);
  expect(pinIndex).toBeGreaterThan(writeIndex);
  expect(arrayIndex).toBeLessThan(writeIndex);
});

test("release_vs_development_is_visible_without_interaction", async ({ page }) => {
  await page.goto("./");
  const matrix = page.locator(".status-matrix");
  await expect(matrix).toBeVisible();
  for (const label of ["Released", "Not guaranteed", "Development"]) {
    await expect(matrix.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(matrix.getByText("unpublished", { exact: false })).toBeVisible();

  const development = page.getByText("Unpublished development branch", { exact: false });
  await expect(development).toBeVisible();
  await expect(development).toHaveAttribute("href", /teamwork-review-build/);

  // The development row must never be paired with an install/copy control.
  const devRowControls = await page.evaluate(() => {
    const row = document.querySelector(".status-development");
    if (!row) return { buttons: 0, installLinks: 0 };
    return {
      buttons: row.querySelectorAll("button").length,
      installLinks: [...row.querySelectorAll("a")].filter((a) =>
        /install/i.test(a.textContent),
      ).length,
    };
  });
  expect(devRowControls.buttons).toBe(0);
  expect(devRowControls.installLinks).toBe(0);

  const installSnippets = await page
    .locator("#install .code")
    .allTextContents();
  expect(installSnippets.join("\n")).not.toContain("0.3.0");
});

test("root_and_project_path_have_no_missing_assets", async ({ page }, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  const origin = new URL(baseURL).origin;
  const responses = [];
  const failures = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on("response", (r) => responses.push(r));
  page.on("requestfailed", (r) => failures.push(r.url()));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto("./");
  await expect(page.locator("h1")).toBeVisible();

  const sameOrigin = responses.filter((r) => {
    try {
      return new URL(r.url()).origin === origin;
    } catch {
      return false;
    }
  });
  for (const r of sameOrigin) {
    expect(r.status(), r.url()).toBeLessThan(400);
  }
  expect(failures, failures.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);

  // Request each built asset explicitly so MIME checking is deterministic;
  // headless Chromium may skip fetching the favicon.
  const assetTypes = [
    ["assets/styles.css", "text/css"],
    ["assets/enhance.js", "javascript"],
    ["assets/favicon.svg", "image/svg+xml"],
  ];
  for (const [asset, expected] of assetTypes) {
    const response = await page.request.get(new URL(`./${asset}`, page.url()).href);
    expect(response.status(), asset).toBe(200);
    expect(response.headers()["content-type"], asset).toContain(expected);
  }
});

test("project_base_without_trailing_slash_redirects_preserving_query", async ({
  page,
}, testInfo) => {
  const baseURL = testInfo.project.use.baseURL;
  if (!new URL(baseURL).pathname.endsWith("OpenCode-Team/")) {
    test.skip(true, "root base has no project directory redirect");
    return;
  }
  const noSlash = baseURL.replace(/\/$/, "");
  await page.goto(`${noSlash}?src=nav&keep=1`);
  expect(page.url()).toBe(`${baseURL}?src=nav&keep=1`);
  await expect(page.locator("h1")).toBeVisible();

  const loaded = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) => (sheet.href ?? "").includes("styles.css")),
  );
  expect(loaded, "stylesheet must load after the redirect").toBe(true);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("workflow_and_config_are_usable_with_js_disabled", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator("#workflow")).toBeVisible();
    await expect(page.locator("#configure")).toBeVisible();
    await expect(page.locator("#snippet-install-write")).toHaveText(
      "npx opencode-teamwork@0.2.1 install --preset anthropic",
    );
    const config = await page.locator("#snippet-config-json").textContent();
    expect(config).toContain('"opencode-teamwork@0.2.1"');
    expect(config).toContain('"team/scout"');
    expect(() => JSON.parse(config)).not.toThrow();

    await expect(page.locator(".copy-button:not([hidden])")).toHaveCount(0);
    await expect(page.locator(".copy-button[hidden]").first()).toHaveCount(1);
  });

  test("faq_works_without_js", async ({ page }) => {
    await page.goto("./#faq");
    const first = page.locator(".faq-item").first();
    await expect(first).toBeVisible();
    await expect(first).not.toHaveAttribute("open", "");
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");
    await expect(first.locator("p")).toBeVisible();
  });

  test("nav_and_release_status_remain_without_js", async ({ page }) => {
    await page.goto("./");
    await expect(page.locator(".site-nav a")).toHaveCount(4);
    await expect(page.locator(".status-matrix")).toBeVisible();
    for (const label of ["Released", "Not guaranteed", "Development"]) {
      await expect(page.locator(".status-matrix").getByText(label, { exact: true })).toBeVisible();
    }
  });
});
