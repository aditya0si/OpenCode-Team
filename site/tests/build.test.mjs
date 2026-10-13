import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  copyFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildSite, BUILD_INVENTORY } from "../scripts/build.mjs";

const SITE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_DIR = join(SITE_ROOT, "src");
const PUBLIC_DIR = join(SITE_ROOT, "public");
const TMP_ROOT = join(SITE_ROOT, "test-results", "build");

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function readTree(dir) {
  const map = {};
  for (const rel of listFiles(dir)) {
    map[rel] = readFileSync(join(dir, rel));
  }
  return map;
}

test("build_is_deterministic_and_contained", async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  const a = mkdtempSync(join(TMP_ROOT, "a-"));
  const b = mkdtempSync(join(TMP_ROOT, "b-"));
  try {
    const emittedA = await buildSite({
      sourceDir: SOURCE_DIR,
      publicDir: PUBLIC_DIR,
      outputDir: join(a, "dist"),
    });
    const emittedB = await buildSite({
      sourceDir: SOURCE_DIR,
      publicDir: PUBLIC_DIR,
      outputDir: join(b, "dist"),
    });

    assert.deepEqual(emittedA, BUILD_INVENTORY);
    assert.deepEqual(emittedB, BUILD_INVENTORY);
    assert.deepEqual(listFiles(join(a, "dist")), BUILD_INVENTORY);

    const treeA = readTree(join(a, "dist"));
    const treeB = readTree(join(b, "dist"));
    for (const rel of BUILD_INVENTORY) {
      assert.ok(
        treeA[rel].equals(treeB[rel]),
        `build output must be byte-identical for ${rel}`,
      );
    }
    assert.equal(treeA[".nojekyll"].length, 0);

    const html = treeA["index.html"].toString("utf-8");
    assert.ok(!/canonical/i.test(html), "no canonical URL");
    assert.ok(!/CNAME/i.test(html), "no CNAME reference");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("build_rejects_output_outside_site_root", async () => {
  await assert.rejects(
    () =>
      buildSite({
        sourceDir: SOURCE_DIR,
        publicDir: PUBLIC_DIR,
        outputDir: join(SITE_ROOT, "..", "escaped-dist"),
      }),
    /outside/,
  );
});

test("build_does_not_touch_root_dist", async () => {
  const rootDist = join(SITE_ROOT, "..", "dist");
  const before = existsSync(rootDist) ? statSync(rootDist).mtimeMs : null;
  const tmp = mkdtempSync(join(TMP_ROOT, "c-"));
  try {
    await buildSite({
      sourceDir: SOURCE_DIR,
      publicDir: PUBLIC_DIR,
      outputDir: join(tmp, "dist"),
    });
    const after = existsSync(rootDist) ? statSync(rootDist).mtimeMs : null;
    assert.equal(after, before, "root dist must remain untouched");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Regression suite for the output-root trust boundary.
//
// The old guard derived its trust anchor from the caller's `sourceDir`, so a
// caller could pass `outputDir: sourceDir` and have the build `rm` the authored
// source tree before writing. These tests never point a build at the real
// `site/src` or `site/public`: every invalid output is aimed at an isolated
// fixture inside `test-results/build`, and the real authored directories are
// hashed before/after to prove no repair deletes them.

function makeFixtureSite() {
  mkdirSync(TMP_ROOT, { recursive: true });
  const root = mkdtempSync(join(TMP_ROOT, "guard-"));
  const sourceDir = join(root, "src");
  const publicDir = join(root, "public");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  for (const name of ["page.html", "styles.css", "enhance.mjs"]) {
    copyFileSync(join(SOURCE_DIR, name), join(sourceDir, name));
  }
  copyFileSync(join(PUBLIC_DIR, "favicon.svg"), join(publicDir, "favicon.svg"));
  return { root, sourceDir, publicDir };
}

test("build_rejects_output_equal_to_source_dir", async () => {
  const site = makeFixtureSite();
  try {
    const before = readTree(site.sourceDir);
    await assert.rejects(
      () =>
        buildSite({
          sourceDir: site.sourceDir,
          publicDir: site.publicDir,
          outputDir: site.sourceDir,
        }),
      /outside|allowed|overlap|source/i,
    );
    assert.deepEqual(
      readTree(site.sourceDir),
      before,
      "authored source fixture must be preserved byte-for-byte",
    );
  } finally {
    rmSync(site.root, { recursive: true, force: true });
  }
});

test("build_rejects_output_equal_to_public_dir", async () => {
  const site = makeFixtureSite();
  try {
    const before = readTree(site.publicDir);
    await assert.rejects(
      () =>
        buildSite({
          sourceDir: site.sourceDir,
          publicDir: site.publicDir,
          outputDir: site.publicDir,
        }),
      /outside|allowed|overlap|public/i,
    );
    assert.deepEqual(
      readTree(site.publicDir),
      before,
      "authored public fixture must be preserved byte-for-byte",
    );
  } finally {
    rmSync(site.root, { recursive: true, force: true });
  }
});

test("build_rejects_output_beneath_caller_derived_root", async () => {
  const site = makeFixtureSite();
  const arbitrary = join(site.root, "arbitrary", "dist");
  try {
    await assert.rejects(
      () =>
        buildSite({
          sourceDir: site.sourceDir,
          publicDir: site.publicDir,
          outputDir: arbitrary,
        }),
      /outside|allowed/i,
    );
    assert.ok(!existsSync(arbitrary), "rejected output must not be created");
  } finally {
    rmSync(site.root, { recursive: true, force: true });
  }
});

test("build_rejects_symlink_output_escape", async (t) => {
  const site = makeFixtureSite();
  const target = mkdtempSync(join(tmpdir(), "build-escape-"));
  writeFileSync(join(target, "keep.txt"), "authored\n");
  const link = join(site.root, "link");
  try {
    try {
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      t.skip(`directory symlinks unavailable on this platform: ${err.code}`);
      return;
    }
    await assert.rejects(
      () =>
        buildSite({
          sourceDir: site.sourceDir,
          publicDir: site.publicDir,
          outputDir: join(link, "dist"),
        }),
      /outside|allowed|overlap/i,
    );
    assert.ok(
      existsSync(join(target, "keep.txt")),
      "symlink target must not be written or removed",
    );
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(site.root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("rejected_builds_never_modify_authored_site_directories", async () => {
  const beforeSource = readTree(SOURCE_DIR);
  const beforePublic = readTree(PUBLIC_DIR);
  const site = makeFixtureSite();
  try {
    for (const outputDir of [
      site.sourceDir,
      site.publicDir,
      join(site.root, "arbitrary", "dist"),
    ]) {
      await assert.rejects(() =>
        buildSite({ sourceDir: site.sourceDir, publicDir: site.publicDir, outputDir }),
      );
    }
  } finally {
    rmSync(site.root, { recursive: true, force: true });
  }
  assert.deepEqual(readTree(SOURCE_DIR), beforeSource, "site/src must be preserved");
  assert.deepEqual(readTree(PUBLIC_DIR), beforePublic, "site/public must be preserved");
});
