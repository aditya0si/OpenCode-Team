// Structural link, fragment and asset checker for generated HTML.
//
// checkLocalLinks parses the rendered document, distinguishes external HTTPS
// destinations from local assets, verifies that every local reference resolves
// inside outputDir, and verifies that every fragment targets an element id in
// the same document. It performs no network access.

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute, join, sep } from "node:path";
import { parse } from "parse5";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTERNAL_SCHEME = /^(https?:|mailto:|tel:|data:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function walk(node, visit) {
  visit(node);
  const children = node.childNodes ?? [];
  for (const child of children) walk(child, visit);
}

function attrValue(node, name) {
  const attr = (node.attrs ?? []).find((a) => a.name === name);
  return attr ? attr.value : undefined;
}

function normaliseBasePath(basePath) {
  let bp = basePath || "/";
  if (!bp.startsWith("/")) bp = `/${bp}`;
  if (!bp.endsWith("/")) bp = `${bp}/`;
  return bp;
}

export function checkLocalLinks({ html, outputDir, basePath = "/" }) {
  const errors = [];
  if (typeof html !== "string") {
    throw new Error("checkLocalLinks: html must be a string");
  }
  const resolvedOutput = resolve(outputDir);
  const base = normaliseBasePath(basePath);

  const document = parse(html);
  const ids = new Set();
  const duplicateIds = new Set();
  const references = [];

  walk(document, (node) => {
    if (!node.tagName) return;
    const id = attrValue(node, "id");
    if (id !== undefined) {
      if (ids.has(id)) duplicateIds.add(id);
      ids.add(id);
    }
    for (const attr of ["href", "src"]) {
      const value = attrValue(node, attr);
      if (value !== undefined) references.push({ value, attr, tag: node.tagName });
    }
  });

  for (const id of duplicateIds) {
    errors.push(`duplicate id "${id}"`);
  }

  for (const ref of references) {
    const value = ref.value.trim();
    if (value === "") continue;

    if (EXTERNAL_SCHEME.test(value)) continue;

    if (value.startsWith("#")) {
      const fragment = decodeURIComponent(value.slice(1));
      if (!ids.has(fragment)) {
        errors.push(`missing fragment target "${value}"`);
      }
      continue;
    }

    if (ANY_SCHEME.test(value)) {
      errors.push(`unsupported scheme in ${ref.attr}="${value}"`);
      continue;
    }

    const [rawPath, rawHash] = value.split("#");
    const pathPart = rawPath.split("?")[0];
    if (pathPart === "") {
      if (rawHash !== undefined) {
        const fragment = decodeURIComponent(rawHash);
        if (!ids.has(fragment)) errors.push(`missing fragment target "${value}"`);
      }
      continue;
    }

    if (pathPart.startsWith("/")) {
      errors.push(`root-absolute local path is not allowed: "${value}"`);
      continue;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      errors.push(`malformed URL encoding in "${value}"`);
      continue;
    }

    const candidate = resolve(resolvedOutput, decoded);
    const rel = relative(resolvedOutput, candidate);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      errors.push(`local reference escapes the output directory: "${value}"`);
      continue;
    }

    const existsAsFile = existsSync(candidate) && statSync(candidate).isFile();
    const existsAsDirIndex =
      existsSync(join(candidate, "index.html")) && statSync(join(candidate, "index.html")).isFile();
    if (!existsAsFile && !existsAsDirIndex) {
      errors.push(`missing local asset: "${value}" (looked for ${candidate.split(sep).join("/")})`);
      continue;
    }

    if (rawHash) {
      const fragment = decodeURIComponent(rawHash);
      if (!ids.has(fragment)) {
        errors.push(`missing fragment target "${value}"`);
      }
    }
  }

  return errors;
}

function defaultOutputDir() {
  return fileURLToPath(new URL("../dist", import.meta.url));
}

function main() {
  const outputDir = defaultOutputDir();
  const indexPath = join(outputDir, "index.html");
  if (!existsSync(indexPath)) {
    console.error(`check:links failed: ${indexPath} does not exist. Run the build first.`);
    process.exit(1);
  }
  const html = readFileSync(indexPath, "utf-8");
  let failed = false;
  for (const basePath of ["/", "/OpenCode-Team/"]) {
    const errors = checkLocalLinks({ html, outputDir, basePath });
    if (errors.length) {
      failed = true;
      console.error(`check:links found ${errors.length} error(s) at base "${basePath}":`);
      for (const error of errors) console.error(`  - ${error}`);
    } else {
      console.log(`check:links OK at base "${basePath}" (external destinations not audited).`);
    }
  }
  if (failed) process.exit(1);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`check:links failed: ${err.message}`);
    process.exit(1);
  }
}
