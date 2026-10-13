// Behavior tests for the test-only static server (scripts/serve.mjs).
//
// The project base path must redirect the bare directory URL to the trailing
// slash form while preserving the query string, serve correct asset MIME types,
// return the built module bytes unchanged, and never provide an SPA fallback.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { buildSite } from "../scripts/build.mjs";
import { serveSite } from "../scripts/serve.mjs";

const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIR = join(SITE_ROOT, "src");
const PUBLIC_DIR = join(SITE_ROOT, "public");
const TMP_ROOT = join(SITE_ROOT, "test-results", "links");
const PROJECT_BASE = "/OpenCode-Team/";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function buildOnce() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const tmp = mkdtempSync(join(TMP_ROOT, "serve-"));
  const outputDir = join(tmp, "dist");
  await buildSite({ sourceDir: SOURCE_DIR, publicDir: PUBLIC_DIR, outputDir });
  return { tmp, outputDir };
}

async function withServer(basePath, fn) {
  const { tmp, outputDir } = await buildOnce();
  const port = await getFreePort();
  const server = await serveSite({ rootDir: outputDir, basePath, port });
  try {
    return await fn({ outputDir, origin: `http://127.0.0.1:${port}` });
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("bare_project_path_redirects_to_trailing_slash_and_keeps_query", async () => {
  await withServer(PROJECT_BASE, async ({ origin }) => {
    const response = await fetch(`${origin}/OpenCode-Team?src=nav&keep=1`, {
      redirect: "manual",
    });
    assert.ok(
      response.status === 301 || response.status === 302 || response.status === 308,
      `expected a redirect, got ${response.status}`,
    );
    const location = response.headers.get("location");
    assert.equal(location, "/OpenCode-Team/?src=nav&keep=1", "query string preserved");

    const followed = await fetch(`${origin}/OpenCode-Team?src=nav&keep=1`);
    assert.equal(followed.status, 200);
    assert.equal(followed.url, `${origin}/OpenCode-Team/?src=nav&keep=1`);
    assert.match(followed.headers.get("content-type") ?? "", /text\/html/);
  });
});

test("project_path_serves_assets_with_correct_mime_and_exact_module_bytes", async () => {
  await withServer(PROJECT_BASE, async ({ origin, outputDir }) => {
    const css = await fetch(`${origin}${PROJECT_BASE}assets/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const js = await fetch(`${origin}${PROJECT_BASE}assets/enhance.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const served = Buffer.from(await js.arrayBuffer());
    const built = readFileSync(join(outputDir, "assets", "enhance.js"));
    assert.ok(served.equals(built), "served module bytes must equal the build output");

    const svg = await fetch(`${origin}${PROJECT_BASE}assets/favicon.svg`);
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
  });
});

test("unknown_paths_are_404_with_no_spa_fallback", async () => {
  await withServer(PROJECT_BASE, async ({ origin }) => {
    const missing = await fetch(`${origin}${PROJECT_BASE}nope/deep`);
    assert.equal(missing.status, 404);
    const rootMissing = await fetch(`${origin}/`);
    assert.equal(rootMissing.status, 404, "outside the project base is not served");
  });
});

test("root_base_still_serves_index_and_does_not_redirect_bare_project_path", async () => {
  await withServer("/", async ({ origin }) => {
    const index = await fetch(`${origin}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);

    const bare = await fetch(`${origin}/OpenCode-Team`, { redirect: "manual" });
    assert.equal(bare.status, 404, "no project redirect exists at the root base");
  });
});
