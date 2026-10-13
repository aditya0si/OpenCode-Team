import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../scripts/build.mjs";
import { checkLocalLinks } from "../scripts/check-links.mjs";

const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIR = join(SITE_ROOT, "src");
const PUBLIC_DIR = join(SITE_ROOT, "public");
const TMP_ROOT = join(SITE_ROOT, "test-results", "links");

async function buildOnce() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const tmp = mkdtempSync(join(TMP_ROOT, "build-"));
  const outputDir = join(tmp, "dist");
  await buildSite({ sourceDir: SOURCE_DIR, publicDir: PUBLIC_DIR, outputDir });
  return { tmp, outputDir };
}

test("generated_document_has_no_local_link_errors", async () => {
  const { tmp, outputDir } = await buildOnce();
  try {
    const html = readFileSync(join(outputDir, "index.html"), "utf-8");
    for (const basePath of ["/", "/OpenCode-Team/"]) {
      assert.deepEqual(
        checkLocalLinks({ html, outputDir, basePath }),
        [],
        `links should resolve at base ${basePath}`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("broken_fragment_or_asset_fails", async () => {
  const { tmp, outputDir } = await buildOnce();
  try {
    const html = readFileSync(join(outputDir, "index.html"), "utf-8");

    const brokenFragment = html.replace('href="#install"', 'href="#does-not-exist"');
    assert.ok(checkLocalLinks({ html: brokenFragment, outputDir }).some((e) => e.includes("does-not-exist")));

    unlinkSync(join(outputDir, "assets", "styles.css"));
    assert.ok(checkLocalLinks({ html, outputDir }).some((e) => e.includes("styles.css")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("root_absolute_and_traversal_are_rejected", async () => {
  const { tmp, outputDir } = await buildOnce();
  try {
    const absolute = '<!doctype html><html><body><a href="/assets/styles.css">x</a></body></html>';
    assert.ok(checkLocalLinks({ html: absolute, outputDir }).some((e) => e.includes("root-absolute")));

    const traversal = '<!doctype html><html><body><a href="../secret.txt">x</a></body></html>';
    assert.ok(checkLocalLinks({ html: traversal, outputDir }).some((e) => e.includes("escapes")));

    const scheme = '<!doctype html><html><body><a href="javascript:alert(1)">x</a></body></html>';
    assert.ok(checkLocalLinks({ html: scheme, outputDir }).some((e) => e.includes("unsupported scheme")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("duplicate_ids_are_reported", () => {
  const html = '<!doctype html><html><body><div id="x"></div><div id="x"></div></body></html>';
  const errors = checkLocalLinks({ html, outputDir: SITE_ROOT });
  assert.ok(errors.some((e) => e.includes("duplicate id")));
});
