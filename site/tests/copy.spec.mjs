import { test, expect } from "@playwright/test";
import { landingContent } from "../src/content.mjs";

const MANUAL_COPY_MESSAGE =
  "Copy unavailable. Select the command text and copy it manually.";

// The installer-written JSON example is the only multiline JSON snippet. Its
// authored text uses LF newlines only; any CR observed from the native Windows
// clipboard is the platform's CRLF encoding, not a change the module made.
function configJsonSource() {
  const snippet = landingContent.snippets.find((s) => s.id === "config-json");
  if (!snippet) throw new Error("config-json snippet is missing from authored content");
  return snippet.text;
}

// The ONLY normalization this suite applies to clipboard text. It converts
// Windows CRLF to LF and touches nothing else, so any other change (replaced,
// dropped or reordered character beyond CR) still fails the comparison.
const normalizeCrlfToLf = (text) => text.replace(/\r\n/g, "\n");

function snippetHtml(targetId, text) {
  return `<figure class="snippet">
    <figcaption class="snippet-head">
      <button type="button" class="copy-button" data-copy-target="${targetId}" hidden>Copy test</button>
      <span class="copy-feedback" role="status" aria-live="polite"></span>
    </figcaption>
    <pre class="code"><code id="${targetId}">${text}</code></pre>
  </figure>`;
}

async function mount(page, html) {
  await page.goto("./");
  return page.evaluate((markup) => {
    const host = document.createElement("div");
    host.id = "copy-test-host";
    host.innerHTML = markup;
    document.body.appendChild(host);
    return true;
  }, html);
}

test("copies_exact_command_without_labels", async ({ page }) => {
  const text = "npx opencode-teamwork@0.2.1 install --preset anthropic";
  await mount(page, snippetHtml("copy-target-1", text));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    const button = host.querySelector(".copy-button");
    const code = host.querySelector("code");
    let captured = null;
    mod.enhanceCopy(host, (value) => {
      captured = value;
      return Promise.resolve();
    });
    button.click();
    await new Promise((r) => setTimeout(r, 20));
    return {
      captured,
      expected: code.textContent,
      hidden: button.hidden,
      feedback: host.querySelector(".copy-feedback").textContent,
    };
  });
  expect(result.captured).toBe(result.expected);
  expect(result.captured).toBe(text);
  expect(result.hidden).toBe(false);
  expect(result.feedback).toBe("Copied");
});

// Scope note: this exercises the adapter contract only. The injected writer
// receives exactly the target element's textContent with newlines and other
// characters untouched. It is NOT evidence about the native OS clipboard;
// native_clipboard_round_trip_preserves_multiline_json_modulo_crlf covers that.
test("injected_writer_receives_parseable_multiline_json_unchanged", async ({ page }) => {
  const json = '{\n  "plugin": ["opencode-teamwork@0.2.1"]\n}';
  await mount(page, snippetHtml("copy-target-json", json));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    let captured = null;
    mod.enhanceCopy(host, (value) => {
      captured = value;
      return Promise.resolve();
    });
    host.querySelector(".copy-button").click();
    await new Promise((r) => setTimeout(r, 20));
    return { captured, source: host.querySelector("code").textContent };
  });
  expect(result.captured).toBe(json);
  expect(result.source).toBe(json);
  expect(() => JSON.parse(result.captured)).not.toThrow();
});

test("success_is_announced_only_after_resolution", async ({ page }) => {
  await mount(page, snippetHtml("copy-target-2", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    let resolveWrite;
    mod.enhanceCopy(host, () => new Promise((resolve) => (resolveWrite = resolve)));
    host.querySelector(".copy-button").click();
    await new Promise((r) => setTimeout(r, 20));
    const before = host.querySelector(".copy-feedback").textContent;
    resolveWrite();
    await new Promise((r) => setTimeout(r, 20));
    const after = host.querySelector(".copy-feedback").textContent;
    return { before, after };
  });
  expect(result.before).not.toBe("Copied");
  expect(result.after).toBe("Copied");
});

test("denied_clipboard_explains_manual_copy", async ({ page }) => {
  await mount(page, snippetHtml("copy-target-3", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    let calls = 0;
    mod.enhanceCopy(host, () => {
      calls += 1;
      return Promise.reject(new Error("denied"));
    });
    host.querySelector(".copy-button").click();
    await new Promise((r) => setTimeout(r, 20));
    return { calls, feedback: host.querySelector(".copy-feedback").textContent };
  });
  expect(result.calls).toBe(1);
  expect(result.feedback).toBe(MANUAL_COPY_MESSAGE);
});

// Each adapter case uses its own freshly mounted host. The previous version
// cloned an already-bound host, so the clone inherited data-copy-bound and the
// feedback text and the throwing adapter was never invoked: a false positive.
test("absent_clipboard_adapter_explains_manual_copy", async ({ page }) => {
  await mount(page, snippetHtml("copy-absent", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    const adapter = mod.clipboardAdapter({});
    let calls = 0;
    mod.enhanceCopy(host, (text) => {
      calls += 1;
      return adapter(text);
    });
    host.querySelector(".copy-button").click();
    await new Promise((r) => setTimeout(r, 20));
    return { calls, feedback: host.querySelector(".copy-feedback").textContent };
  });
  expect(result.calls).toBe(1);
  expect(result.feedback).toBe(MANUAL_COPY_MESSAGE);
});

test("synchronous_throwing_adapter_explains_manual_copy", async ({ page }) => {
  await mount(page, snippetHtml("copy-throwing", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    let calls = 0;
    mod.enhanceCopy(host, () => {
      calls += 1;
      throw new Error("no clipboard");
    });
    host.querySelector(".copy-button").click();
    await new Promise((r) => setTimeout(r, 20));
    return { calls, feedback: host.querySelector(".copy-feedback").textContent };
  });
  expect(result.calls).toBe(1);
  expect(result.feedback).toBe(MANUAL_COPY_MESSAGE);
});

test("buttons_reveal_only_after_binding", async ({ page }) => {
  await mount(page, snippetHtml("copy-target-5", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    const button = host.querySelector(".copy-button");
    const before = button.hidden;
    mod.enhanceCopy(host, () => Promise.resolve());
    return { before, after: button.hidden };
  });
  expect(result.before).toBe(true);
  expect(result.after).toBe(false);
});

test("missing_target_leaves_control_hidden_without_throwing", async ({ page }) => {
  const html =
    `<figure class="snippet"><figcaption class="snippet-head">` +
    `<button type="button" class="copy-button" data-copy-target="ghost" hidden>Bad</button>` +
    `<span class="copy-feedback" role="status" aria-live="polite"></span></figcaption></figure>` +
    snippetHtml("copy-target-6", "opencode");
  await mount(page, html);
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    let bound = -1;
    let threw = false;
    try {
      bound = mod.enhanceCopy(host, () => Promise.resolve());
    } catch {
      threw = true;
    }
    const buttons = [...host.querySelectorAll(".copy-button")];
    return {
      threw,
      bound,
      badHidden: buttons[0].hidden,
      goodHidden: buttons[1].hidden,
    };
  });
  expect(result.threw).toBe(false);
  expect(result.bound).toBe(1);
  expect(result.badHidden).toBe(true);
  expect(result.goodHidden).toBe(false);
});

test("repeated_clicks_keep_feedback_local", async ({ page }) => {
  const html = snippetHtml("copy-a", "command-a") + snippetHtml("copy-b", "command-b");
  await mount(page, html);
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    const pending = [];
    mod.enhanceCopy(host, (value) => new Promise((resolve, reject) => pending.push({ value, resolve, reject })));
    const buttons = [...host.querySelectorAll(".copy-button")];
    const feedbacks = [...host.querySelectorAll(".copy-feedback")];
    buttons[0].click();
    buttons[1].click();
    // Resolve the second block first, then the first: no cross-block bleed.
    pending.find((p) => p.value === "command-b").resolve();
    await new Promise((r) => setTimeout(r, 10));
    const bAfter = feedbacks[1].textContent;
    pending.find((p) => p.value === "command-a").resolve();
    await new Promise((r) => setTimeout(r, 10));
    return { a: feedbacks[0].textContent, b: bAfter, bFinal: feedbacks[1].textContent };
  });
  expect(result.a).toBe("Copied");
  expect(result.b).toBe("Copied");
  expect(result.bFinal).toBe("Copied");
});

test("stale_resolution_cannot_overwrite_newer_feedback", async ({ page }) => {
  await mount(page, snippetHtml("copy-stale", "value"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    const pending = [];
    mod.enhanceCopy(host, () => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const button = host.querySelector(".copy-button");
    const feedback = host.querySelector(".copy-feedback");
    button.click(); // first attempt (will resolve later)
    button.click(); // second attempt supersedes it
    pending[1].resolve();
    await new Promise((r) => setTimeout(r, 10));
    const afterNewest = feedback.textContent;
    pending[0].reject(new Error("stale failure"));
    await new Promise((r) => setTimeout(r, 10));
    return { afterNewest, final: feedback.textContent };
  });
  expect(result.afterNewest).toBe("Copied");
  expect(result.final).toBe("Copied");
});

test("copy_preserves_keyboard_focus", async ({ page }) => {
  await mount(page, snippetHtml("copy-focus", "opencode"));
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.getElementById("copy-test-host");
    mod.enhanceCopy(host, () => Promise.resolve());
    const button = host.querySelector(".copy-button");
    button.focus();
    button.click();
    await new Promise((r) => setTimeout(r, 20));
    return {
      focused: document.activeElement === button,
      feedback: host.querySelector(".copy-feedback").textContent,
    };
  });
  expect(result.focused).toBe(true);
  expect(result.feedback).toBe("Copied");
});

test("page_auto_initializes_buttons_without_copying", async ({ page }) => {
  await page.goto("./");
  await expect(page.locator(".copy-button[hidden]")).toHaveCount(0);
  const feedbacks = await page.locator(".copy-feedback").allTextContents();
  expect(feedbacks.every((text) => text.trim() === "")).toBe(true);
});

test("outside_root_target_leaves_control_hidden", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const outside = document.createElement("div");
    outside.innerHTML = '<code id="outside-code">secret</code>';
    document.body.appendChild(outside);

    const host = document.createElement("div");
    host.innerHTML =
      '<figure class="snippet"><figcaption class="snippet-head">' +
      '<button type="button" class="copy-button" data-copy-target="outside-code" hidden>Copy</button>' +
      '<span class="copy-feedback" role="status" aria-live="polite"></span></figcaption></figure>';
    document.body.appendChild(host);

    let calls = 0;
    const bound = mod.enhanceCopy(host, () => {
      calls += 1;
      return Promise.resolve();
    });
    const button = host.querySelector(".copy-button");
    button.click();
    await new Promise((r) => setTimeout(r, 10));
    const out = {
      bound,
      hidden: button.hidden,
      calls,
      feedback: host.querySelector(".copy-feedback").textContent,
    };
    outside.remove();
    host.remove();
    return out;
  });
  expect(result.bound).toBe(0);
  expect(result.hidden).toBe(true);
  expect(result.calls).toBe(0);
  expect(result.feedback).toBe("");
});

test("duplicate_target_ids_leave_control_hidden", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.createElement("div");
    host.innerHTML =
      '<figure class="snippet"><figcaption class="snippet-head">' +
      '<button type="button" class="copy-button" data-copy-target="dup-code" hidden>Copy</button>' +
      '<span class="copy-feedback" role="status" aria-live="polite"></span></figcaption></figure>' +
      '<code id="dup-code">one</code><code id="dup-code">two</code>';
    document.body.appendChild(host);
    const bound = mod.enhanceCopy(host, () => Promise.resolve());
    const button = host.querySelector(".copy-button");
    button.click();
    await new Promise((r) => setTimeout(r, 10));
    const out = { bound, hidden: button.hidden };
    host.remove();
    return out;
  });
  expect(result.bound).toBe(0);
  expect(result.hidden).toBe(true);
});

test("non_code_target_leaves_control_hidden", async ({ page }) => {
  await page.goto("./");
  const result = await page.evaluate(async () => {
    const mod = await import("./assets/enhance.js");
    const host = document.createElement("div");
    host.innerHTML =
      '<figure class="snippet"><figcaption class="snippet-head">' +
      '<button type="button" class="copy-button" data-copy-target="not-code" hidden>Copy</button>' +
      '<span class="copy-feedback" role="status" aria-live="polite"></span></figcaption></figure>' +
      '<div id="not-code">plain text, not a code element</div>';
    document.body.appendChild(host);
    const bound = mod.enhanceCopy(host, () => Promise.resolve());
    const button = host.querySelector(".copy-button");
    button.click();
    await new Promise((r) => setTimeout(r, 10));
    const out = { bound, hidden: button.hidden };
    host.remove();
    return out;
  });
  expect(result.bound).toBe(0);
  expect(result.hidden).toBe(true);
});

// Real native clipboard coverage: writes through the page's own
// navigator.clipboard path (the production adapter), reads the OS clipboard
// back, and checks a multiline JSON document survives except for the Windows
// CRLF line-ending encoding. The only permitted transformation is CRLF -> LF;
// every other character must be retained byte-for-byte and the result must
// still parse as JSON.
test("native_clipboard_round_trip_preserves_multiline_json_modulo_crlf", async ({
  page,
  context,
}) => {
  const source = configJsonSource();
  expect(source, "authored example uses LF only").not.toContain("\r");
  expect(source.split("\n").length, "example is genuinely multiline").toBeGreaterThan(1);

  await page.goto("./");
  const origin = new URL(page.url()).origin;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

  const button = page.locator('.copy-button[data-copy-target="snippet-config-json"]');
  await expect(button).toBeVisible();
  await page.bringToFront();
  await button.click();
  await expect(page.locator('.snippet[data-snippet="config-json"] .copy-feedback')).toHaveText(
    "Copied",
  );

  const raw = await page.evaluate(() => navigator.clipboard.readText());

  // The clipboard content itself must be valid JSON, and every CR must belong
  // to a CRLF pair (no lone CR and no CR introduced anywhere else).
  expect(() => JSON.parse(raw), "raw clipboard text parses as JSON").not.toThrow();
  expect(raw, "every CR is part of a CRLF pair").not.toMatch(/\r(?!\n)/);

  // Removing only the CR characters must reproduce the authored example
  // exactly: no other character may be added, dropped or reordered.
  const withoutCr = [...raw].filter((char) => char !== "\r").join("");
  expect(withoutCr, "only CR characters are removed").toBe(source);

  const normalized = normalizeCrlfToLf(raw);
  expect(normalized).toBe(source);
  expect(() => JSON.parse(normalized)).not.toThrow();
});

// Negative control for the normalization above: it must not mask corruption
// other than a CRLF line ending.
test("clipboard_normalization_detects_non_crlf_corruption", async () => {
  const source = configJsonSource();
  expect(source).not.toContain("\r");

  const crlfVersion = source.replace(/\n/g, "\r\n");
  expect(normalizeCrlfToLf(crlfVersion), "CRLF to LF alone normalizes cleanly").toBe(source);

  expect(normalizeCrlfToLf(source.replace("plugin", "plug in"))).not.toBe(source);
  expect(normalizeCrlfToLf(source.replace(/ /g, "\u00a0"))).not.toBe(source);
  expect(normalizeCrlfToLf(source.replace(/\n/g, ""))).not.toBe(source);
  expect(normalizeCrlfToLf(source + "\n")).not.toBe(source);
});
