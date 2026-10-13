// Read-only release evidence.
//
// The landing page claims are anchored to a declared release commit. This module
// reads that commit's tree with `git` plumbing only; it never reads the working
// tree, so an uncommitted or mutated working copy cannot redefine what the
// released artifact contains.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** True when `commit` names a commit object that exists in this repository. */
export function commitExists(commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{7,40}$/i.test(commit)) return false;
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Direct entry names of `repoRelDir` as recorded in `commit`. */
export function releaseFileNames(commit, repoRelDir) {
  const out = git(["ls-tree", "--name-only", `${commit}:${repoRelDir}`]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The exact bytes of `repoRelPath` as recorded in `commit`. */
export function releaseFile(commit, repoRelPath) {
  return git(["show", `${commit}:${repoRelPath}`]);
}

/** Parsed JSON of `repoRelPath` as recorded in `commit`. */
export function releaseJson(commit, repoRelPath) {
  return JSON.parse(releaseFile(commit, repoRelPath));
}

/**
 * Preset names declared in the PRESETS array of a CLI source string. Pure, so
 * callers can compare a mutated working copy against the committed release.
 */
export function parsePresetNames(source) {
  const start = source.indexOf("const PRESETS");
  const end = source.indexOf("const ROLES");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("parsePresetNames: PRESETS/ROLES block not found");
  }
  const block = source.slice(start, end);
  return [...block.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
}

/** Preset names declared in the committed CLI at `commit`. */
export function releasePresetNames(commit, repoRelPath = "src/cli/index.ts") {
  return parsePresetNames(releaseFile(commit, repoRelPath));
}
