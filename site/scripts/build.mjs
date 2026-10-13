// Isolated deterministic build for the landing page.
//
// buildSite writes only inside outputDir, which must resolve under the site
// root (the parent of sourceDir). It fails on invalid content, missing
// template markers, unreadable assets or an output path outside the allowed
// directory, and it returns the sorted relative paths it emitted.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import {
  resolve,
  relative,
  isAbsolute,
  join,
  dirname,
  basename,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { landingContent, validateContent } from "../src/content.mjs";
import { renderPage } from "../src/render.mjs";

export const BUILD_INVENTORY = [
  ".nojekyll",
  "assets/enhance.js",
  "assets/favicon.svg",
  "assets/styles.css",
  "index.html",
];

// Fixed repository trust anchor. The site root comes from this module's own
// location, never from caller-supplied paths, so a caller cannot move the
// boundary by choosing a different sourceDir.
export const SITE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REAL_SITE_ROOT = realpathSync(SITE_ROOT);

// The only output roots a build may write to. `dist` is the production output;
// the two test roots are the explicitly named paths the current suites use and
// each test output must be a directly nested `dist` directory. Nothing else
// under the repository is writable, and no caller input can extend this list.
const DIST_ROOT = join(REAL_SITE_ROOT, "dist");
const TEST_OUTPUT_ROOTS = [
  join(REAL_SITE_ROOT, "test-results", "build"),
  join(REAL_SITE_ROOT, "test-results", "links"),
];

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isInsideOrEqual(parent, child) {
  return child === parent || isInside(parent, child);
}

function assertInside(parent, child, label) {
  if (!isInside(parent, child)) {
    throw new Error(`buildSite: ${label} resolves outside ${parent}: ${child}`);
  }
}

// Resolve symlinks on the nearest existing ancestor, then keep the not-yet
// created remainder literal. A symlinked ancestor therefore cannot smuggle an
// output path outside the allowlist before it is written.
function realPathForWrite(target) {
  let current = resolve(target);
  const tail = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  const real = realpathSync(current);
  return tail.length ? join(real, ...tail) : real;
}

function isAllowedOutputRoot(realOutput) {
  if (realOutput === DIST_ROOT || isInside(DIST_ROOT, realOutput)) return true;
  for (const root of TEST_OUTPUT_ROOTS) {
    if (basename(realOutput) !== "dist") continue;
    if (dirname(dirname(realOutput)) === root) return true;
  }
  return false;
}

function assertSafeOutput({ outputDir, sourceDir, publicDir }) {
  const output = realPathForWrite(outputDir);
  const source = realPathForWrite(sourceDir);
  const publicReal = realPathForWrite(publicDir);

  if (!isAllowedOutputRoot(output)) {
    throw new Error(
      `buildSite: outputDir resolves outside the allowed output roots: ${outputDir}`,
    );
  }
  if (output === REAL_SITE_ROOT) {
    throw new Error("buildSite: outputDir must not be the site root");
  }
  if (
    isInsideOrEqual(output, source) ||
    isInsideOrEqual(output, publicReal) ||
    isInsideOrEqual(source, output) ||
    isInsideOrEqual(publicReal, output)
  ) {
    throw new Error(
      `buildSite: outputDir must not overlap the authored source or public directory: ${outputDir}`,
    );
  }
}

export async function buildSite({ sourceDir, publicDir, outputDir }) {
  if (!sourceDir || !publicDir || !outputDir) {
    throw new Error("buildSite: sourceDir, publicDir and outputDir are required");
  }

  const resolvedSource = resolve(sourceDir);
  const resolvedPublic = resolve(publicDir);
  const resolvedOutput = resolve(outputDir);

  assertSafeOutput({
    outputDir: resolvedOutput,
    sourceDir: resolvedSource,
    publicDir: resolvedPublic,
  });

  validateContent(landingContent);

  const templatePath = join(resolvedSource, "page.html");
  let template;
  try {
    template = readFileSync(templatePath, "utf-8");
  } catch (err) {
    throw new Error(`buildSite: cannot read template ${templatePath}: ${err.message}`);
  }
  const html = renderPage(landingContent, template);

  const assets = {
    "assets/styles.css": join(resolvedSource, "styles.css"),
    "assets/enhance.js": join(resolvedSource, "enhance.mjs"),
    "assets/favicon.svg": join(resolvedPublic, "favicon.svg"),
  };

  rmSync(resolvedOutput, { recursive: true, force: true });
  mkdirSync(join(resolvedOutput, "assets"), { recursive: true });

  const emitted = [];
  const targets = {
    "index.html": { text: html },
    ...Object.fromEntries(
      Object.entries(assets).map(([out, src]) => [out, { copyFrom: src }]),
    ),
    ".nojekyll": { text: "" },
  };

  for (const [outRel, spec] of Object.entries(targets)) {
    const outAbs = join(resolvedOutput, outRel);
    assertInside(resolvedOutput, outAbs, outRel);
    mkdirSync(dirname(outAbs), { recursive: true });
    if (spec.copyFrom) {
      let bytes;
      try {
        bytes = readFileSync(spec.copyFrom);
      } catch (err) {
        throw new Error(`buildSite: cannot read asset ${spec.copyFrom}: ${err.message}`);
      }
      writeFileSync(outAbs, bytes);
    } else {
      writeFileSync(outAbs, spec.text, "utf-8");
    }
    emitted.push(outRel);
  }

  return emitted.sort();
}

export function defaultPaths() {
  const sourceDir = fileURLToPath(new URL("../src", import.meta.url));
  const publicDir = fileURLToPath(new URL("../public", import.meta.url));
  const outputDir = fileURLToPath(new URL("../dist", import.meta.url));
  return { sourceDir, publicDir, outputDir };
}

async function main() {
  const emitted = await buildSite(defaultPaths());
  console.log(`Built ${emitted.length} files:`);
  for (const file of emitted) console.log(`  ${file}`);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`build failed: ${err.message}`);
    process.exit(1);
  });
}
