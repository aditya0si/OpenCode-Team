/**
 * Task 2 — immutable, bounded snapshots and freshness. RED first.
 *
 * Every case below is written against the still-absent `src/audit/snapshot.ts`,
 * so the first run fails to import. GREEN only after bounded snapshot capture,
 * safe path handling, dirty-git coverage and freshness checks exist.
 *
 * Design invariants under test:
 *   - snapshots observe real Git state (staged/unstaged/untracked/deleted) with
 *     exact bytes and never mutate the source tree or index;
 *   - candidateId is a deterministic cryptographic identity of the observed
 *     scoped content plus base/task/scope, not a bare commit SHA;
 *   - secret-bearing, dependency/generated and verifier-storage paths are denied
 *     by policy and recorded as explicit exclusions; candidate scope cannot
 *     weaken that policy;
 *   - absolute/traversal/control-character paths, symlink/junction escapes and
 *     output-root overlap are rejected;
 *   - files that change during capture are rejected, never published as stable;
 *   - freshness only speaks for the declared scope and rejects malformed or
 *     tampered imported manifests.
 */

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotError,
  SnapshotValidationError,
  captureSnapshot,
  checkFreshness,
  nodeSnapshotIo,
} from "../../src/audit/snapshot.js";

// Real git fixtures spawn many child processes on Windows; give each bounded
// test comfortably more than the 5s default without masking a hang.
setDefaultTimeout(30_000);

const WORKSPACE = process.cwd();
const FIXTURES = join(WORKSPACE, "audit-build", "snapshot-fixtures");
const OUTPUTS = join(WORKSPACE, "audit-build", "snapshot-output");
let seq = 0;

function runGit(dir: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr}`);
  }
  return result.stdout;
}

function freshDir(base: string, name: string): string {
  mkdirSync(base, { recursive: true });
  const dir = join(base, `${name}-${process.pid}-${seq++}`);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

function makeRepo(name: string): string {
  const dir = freshDir(FIXTURES, name);
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-q", "-b", "main"]);
  runGit(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(dir, "base.txt"), "base content\n");
  writeFileSync(join(dir, "keep.txt"), "keep content\n");
  writeFileSync(join(dir, "del.txt"), "delete me\n");
  const identity = ["-c", "user.email=audit@test.local", "-c", "user.name=audit-test"];
  runGit(dir, [...identity, "add", "-A"]);
  runGit(dir, [...identity, "commit", "-qm", "init"]);
  return dir;
}

function outDir(name = "out"): string {
  return freshDir(OUTPUTS, name);
}

function baseOptions(repo: string, over: Record<string, unknown> = {}) {
  return {
    taskId: "task-2",
    taskRevision: "rev-1",
    sourceRoot: repo,
    outputRoot: outDir(),
    ...over,
  };
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotError);
    expect((error as SnapshotError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}`);
}

afterAll(() => {
  for (const base of [FIXTURES, OUTPUTS]) {
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("snapshot option validation", () => {
  test("exports the expected schema version", () => {
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(2);
  });

  test("rejects output nested inside the source root", async () => {
    const repo = makeRepo("nested");
    await expectCode(
      captureSnapshot(baseOptions(repo, { outputRoot: join(repo, "snapshots") })),
      "OUTPUT_OVERLAP",
    );
  });

  test("rejects output equal to the source root", async () => {
    const repo = makeRepo("same");
    await expectCode(
      captureSnapshot(baseOptions(repo, { outputRoot: repo })),
      "OUTPUT_OVERLAP",
    );
  });

  test("rejects an existing output location", async () => {
    const repo = makeRepo("existing");
    const out = outDir("existing-out");
    mkdirSync(out, { recursive: true });
    await expectCode(
      captureSnapshot(baseOptions(repo, { outputRoot: out })),
      "OUTPUT_EXISTS",
    );
  });

  test("rejects a missing source root", async () => {
    const missing = join(FIXTURES, "does-not-exist", String(process.pid));
    rmSync(missing, { recursive: true, force: true });
    await expectCode(
      captureSnapshot(baseOptions(missing)),
      "SOURCE_NOT_FOUND",
    );
  });

  test("rejects a source root that is not a repository", async () => {
    const plain = freshDir(FIXTURES, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "note.txt"), "not a repo\n");
    await expectCode(captureSnapshot(baseOptions(plain)), "NOT_A_REPOSITORY");
  });

  test("rejects absolute scope paths", async () => {
    const repo = makeRepo("abs");
    await expectCode(
      captureSnapshot(baseOptions(repo, { scope: { paths: ["/etc/passwd"] } })),
      "ABSOLUTE_PATH",
    );
    await expectCode(
      captureSnapshot(baseOptions(repo, { scope: { paths: ["C:\\Windows\\System32"] } })),
      "ABSOLUTE_PATH",
    );
  });

  test("rejects path traversal in scope paths", async () => {
    const repo = makeRepo("traversal");
    await expectCode(
      captureSnapshot(baseOptions(repo, { scope: { paths: ["../outside.txt"] } })),
      "PATH_TRAVERSAL",
    );
  });

  test("rejects control characters in scope paths", async () => {
    const repo = makeRepo("control");
    await expectCode(
      captureSnapshot(baseOptions(repo, { scope: { paths: ["src/\u0000bad"] } })),
      "CONTROL_CHARACTER",
    );
  });

  test("rejects duplicate scope paths (case-insensitively on Windows)", async () => {
    const repo = makeRepo("dup");
    await expectCode(
      captureSnapshot(baseOptions(repo, { scope: { paths: ["src/a.ts", "src/a.ts"] } })),
      "INVALID_OPTIONS",
    );
  });

  test("rejects structurally malformed options", async () => {
    await expect(
      captureSnapshot({
        taskId: "task-2",
        taskRevision: "rev-1",
        sourceRoot: 42,
        outputRoot: outDir(),
      } as never),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
  });
});

describe("capture of real git states", () => {
  test("captures staged, unstaged, untracked and deleted files", async () => {
    const repo = makeRepo("dirty");
    writeFileSync(join(repo, "base.txt"), "base content\nstaged line\n");
    runGit(repo, ["add", "base.txt"]);
    writeFileSync(join(repo, "keep.txt"), "keep content\nunstaged line\n");
    writeFileSync(join(repo, "new.txt"), "untracked file\n");
    rmSync(join(repo, "del.txt"));

    const manifest = await captureSnapshot(baseOptions(repo));
    const byPath = new Map(manifest.files.map((file) => [file.path, file]));

    expect(byPath.get("base.txt")?.status).toBe("modified");
    expect(byPath.get("base.txt")?.staged).toBe(true);
    expect(byPath.get("base.txt")?.unstaged).toBe(false);
    expect(byPath.get("keep.txt")?.status).toBe("modified");
    expect(byPath.get("keep.txt")?.unstaged).toBe(true);
    expect(byPath.get("new.txt")?.status).toBe("untracked");
    expect(byPath.get("del.txt")?.status).toBe("deleted");
    expect(byPath.get("del.txt")?.hash).toBeNull();
    expect(byPath.get("del.txt")?.size).toBeNull();

    expect(byPath.get("base.txt")?.hash).toBe(sha256(readFileSync(join(repo, "base.txt"))));
    expect(byPath.get("new.txt")?.size).toBe(Buffer.byteLength("untracked file\n"));

    expect(existsSync(join(manifest.outputRoot, "files", "del.txt"))).toBe(false);
    const copy = readFileSync(join(manifest.outputRoot, "files", "new.txt"));
    expect(sha256(copy)).toBe(byPath.get("new.txt")?.hash);
  });

  test("independently validates every copied file hash from the manifest", async () => {
    const repo = makeRepo("copies");
    writeFileSync(join(repo, "keep.txt"), "keep content\ncopy check\n");
    writeFileSync(join(repo, "extra.txt"), "extra bytes\n");

    const manifest = await captureSnapshot(baseOptions(repo));
    const present = manifest.files.filter((file) => file.hash !== null);
    expect(present.length).toBeGreaterThan(0);
    for (const file of present) {
      const copied = readFileSync(join(manifest.copyRoot, ...file.path.split("/")));
      expect(sha256(copied)).toBe(file.hash);
      expect(copied.byteLength).toBe(file.size as number);
    }
  });

  test("repeated identical captures are deterministic", async () => {
    const repo = makeRepo("deterministic");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    writeFileSync(join(repo, "new.txt"), "new\n");

    const first = await captureSnapshot(baseOptions(repo, { outputRoot: outDir("det-a") }));
    const second = await captureSnapshot(baseOptions(repo, { outputRoot: outDir("det-b") }));

    expect(first.candidateId).toBe(second.candidateId);
    expect(first.files).toEqual(second.files);
    expect(first.exclusions).toEqual(second.exclusions);
    expect(first.base.revision).toBe(second.base.revision);
  });

  test("does not mutate source bytes, HEAD or the git index", async () => {
    const repo = makeRepo("no-mutation");
    writeFileSync(join(repo, "keep.txt"), "keep content\nstill dirty\n");
    writeFileSync(join(repo, "new.txt"), "untracked\n");

    const indexBefore = sha256(readFileSync(join(repo, ".git", "index")));
    const headBefore = runGit(repo, ["rev-parse", "HEAD"]);
    const statusBefore = runGit(repo, ["status", "--porcelain=v1", "-z"]);
    const keepBefore = sha256(readFileSync(join(repo, "keep.txt")));

    await captureSnapshot(baseOptions(repo));

    expect(sha256(readFileSync(join(repo, ".git", "index")))).toBe(indexBefore);
    expect(runGit(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(runGit(repo, ["status", "--porcelain=v1", "-z"])).toBe(statusBefore);
    expect(sha256(readFileSync(join(repo, "keep.txt")))).toBe(keepBefore);
  });

  test("excludes oversized files visibly instead of truncating", async () => {
    const repo = makeRepo("oversize");
    writeFileSync(join(repo, "big.txt"), "x".repeat(100));

    const manifest = await captureSnapshot(baseOptions(repo, { limits: { maxFileBytes: 16 } }));

    expect(manifest.files.find((file) => file.path === "big.txt")).toBeUndefined();
    expect(manifest.exclusions).toContainEqual(
      expect.objectContaining({ path: "big.txt", reason: "OVERSIZED" }),
    );
    expect(existsSync(join(manifest.copyRoot, "big.txt"))).toBe(false);
  });

  test("excludes .env secrets by default and records the reason", async () => {
    const repo = makeRepo("secret");
    writeFileSync(join(repo, ".env"), "API_KEY=supersecret\n");

    const manifest = await captureSnapshot(baseOptions(repo));

    expect(manifest.files.find((file) => file.path === ".env")).toBeUndefined();
    expect(manifest.exclusions).toContainEqual(
      expect.objectContaining({ path: ".env", reason: "SECRET" }),
    );
    expect(existsSync(join(manifest.copyRoot, ".env"))).toBe(false);
  });

  test("candidate scope cannot weaken the secret policy", async () => {
    const repo = makeRepo("secret-scope");
    writeFileSync(join(repo, ".env"), "TOKEN=abc\n");

    const manifest = await captureSnapshot(
      baseOptions(repo, { scope: { paths: [".env"] } }),
    );

    expect(manifest.files.find((file) => file.path === ".env")).toBeUndefined();
    expect(manifest.exclusions).toContainEqual(
      expect.objectContaining({ path: ".env", reason: "SECRET" }),
    );
  });

  test("excludes verifier storage and dependency directories", async () => {
    const repo = makeRepo("storage");
    mkdirSync(join(repo, "audit-build"), { recursive: true });
    writeFileSync(join(repo, "audit-build", "note.txt"), "evidence\n");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep.js"), "module\n");

    const manifest = await captureSnapshot(baseOptions(repo));

    expect(manifest.files.find((file) => file.path.startsWith("audit-build/"))).toBeUndefined();
    expect(manifest.files.find((file) => file.path.startsWith("node_modules/"))).toBeUndefined();
    expect(manifest.exclusions).toContainEqual(
      expect.objectContaining({ path: "audit-build/note.txt", reason: "VERIFIER_STORAGE" }),
    );
    expect(manifest.exclusions).toContainEqual(
      expect.objectContaining({ path: "node_modules/dep.js", reason: "POLICY_DIRECTORY" }),
    );
  });

  test("partial scope captures only declared paths and marks itself partial", async () => {
    const repo = makeRepo("partial");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "app\n");
    writeFileSync(join(repo, "docs", "readme.md"), "docs\n");

    const manifest = await captureSnapshot(baseOptions(repo, { scope: { paths: ["src"] } }));

    expect(manifest.scope.partial).toBe(true);
    expect(manifest.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(manifest.files.find((file) => file.path === "docs/readme.md")).toBeUndefined();
  });

  test("accepts backslash scope paths and matches them to git's forward slashes", async () => {
    const repo = makeRepo("backslash");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "app\n");

    const manifest = await captureSnapshot(
      baseOptions(repo, { scope: { paths: ["src\\app.ts"] } }),
    );

    expect(manifest.files.map((file) => file.path)).toEqual(["src/app.ts"]);
  });

  test("matches scope paths case-insensitively on Windows", async () => {
    if (process.platform !== "win32") {
      expect(true).toBe(true);
      return;
    }
    const repo = makeRepo("case");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "app\n");

    const manifest = await captureSnapshot(
      baseOptions(repo, { scope: { paths: ["SRC/APP.TS"] } }),
    );

    expect(manifest.files.map((file) => file.path)).toEqual(["src/app.ts"]);
  });

  test("rejects a junction/symlink that escapes the source root", async () => {
    const repo = makeRepo("escape");
    const host = freshDir(OUTPUTS, "host");
    mkdirSync(host, { recursive: true });
    writeFileSync(join(host, "secret.txt"), "host secret\n");
    try {
      symlinkSync(host, join(repo, "escape"), "junction");
    } catch {
      // symlink creation is not permitted in this environment; capability gate
      return;
    }
    await expectCode(captureSnapshot(baseOptions(repo)), "SYMLINK_ESCAPE");
  });

  test("rejects a file that changes during read", async () => {
    const repo = makeRepo("race");
    writeFileSync(join(repo, "keep.txt"), "keep content\nmodified before capture\n");

    const racingIo = {
      ...nodeSnapshotIo,
      readFile(path: string): Buffer {
        const buffer = nodeSnapshotIo.readFile(path);
        if (path.endsWith("keep.txt")) {
          writeFileSync(path, Buffer.from("changed during capture and longer\n"));
        }
        return buffer;
      },
    };

    await expectCode(captureSnapshot(baseOptions(repo), racingIo), "RACE_DETECTED");
  });
});

describe("freshness against real git state", () => {
  test("reports an unchanged snapshot as fresh", async () => {
    const repo = makeRepo("freshness-fresh");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const manifest = await captureSnapshot(baseOptions(repo));

    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(true);
    expect(result.currentCandidateId).toBe(manifest.candidateId);
    expect(result.changed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.base.matches).toBe(true);
  });

  test("reports changed bytes as stale", async () => {
    const repo = makeRepo("freshness-changed");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const manifest = await captureSnapshot(baseOptions(repo));

    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged again\n");
    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(false);
    expect(result.changed).toContain("keep.txt");
    expect(result.currentCandidateId).not.toBe(manifest.candidateId);
  });

  test("reports a new relevant file as stale", async () => {
    const repo = makeRepo("freshness-added");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const manifest = await captureSnapshot(baseOptions(repo));

    writeFileSync(join(repo, "added.txt"), "brand new\n");
    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(false);
    expect(result.added).toContain("added.txt");
  });

  test("reports a deleted relevant file as stale", async () => {
    const repo = makeRepo("freshness-deleted");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const manifest = await captureSnapshot(baseOptions(repo));

    rmSync(join(repo, "keep.txt"));
    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(false);
    expect(result.deleted).toContain("keep.txt");
  });

  test("reports a base revision change as stale", async () => {
    const repo = makeRepo("freshness-base");
    const manifest = await captureSnapshot(baseOptions(repo));

    runGit(repo, ["commit", "--allow-empty", "-qm", "bump"]);
    const result = await checkFreshness(manifest);

    expect(result.base.matches).toBe(false);
    expect(result.fresh).toBe(false);
  });

  test("partial scope does not claim whole-tree freshness", async () => {
    const repo = makeRepo("freshness-partial");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "src", "app.ts"), "app\n");
    writeFileSync(join(repo, "docs", "readme.md"), "docs\n");
    const manifest = await captureSnapshot(baseOptions(repo, { scope: { paths: ["src"] } }));

    writeFileSync(join(repo, "docs", "readme.md"), "docs changed out of scope\n");
    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(true);
    expect(result.scopeComplete).toBe(false);
    expect(result.reasons).toContain("PARTIAL_SCOPE");
  });

  test("reports an unreadable source root instead of fabricating freshness", async () => {
    const repo = makeRepo("freshness-gone");
    const manifest = await captureSnapshot(baseOptions(repo));

    rmSync(repo, { recursive: true, force: true });
    const result = await checkFreshness(manifest);

    expect(result.fresh).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("rejects a structurally corrupted manifest before touching the filesystem", async () => {
    const repo = makeRepo("manifest-corrupt");
    const manifest = await captureSnapshot(baseOptions(repo));

    await expect(
      checkFreshness({ ...manifest, files: "not-an-array" } as never),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(
      checkFreshness({ taskId: "only" } as never),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
  });

  test("rejects a tampered manifest whose hashes no longer match its identity", async () => {
    const repo = makeRepo("manifest-tamper");
    writeFileSync(join(repo, "keep.txt"), "keep content\ntamper target\n");
    const manifest = await captureSnapshot(baseOptions(repo));

    const tampered = {
      ...manifest,
      files: manifest.files.map((file) =>
        file.path === "keep.txt" ? { ...file, hash: "0".repeat(64) } : file,
      ),
    };
    await expectCode(checkFreshness(tampered as never), "MANIFEST_TAMPERED");
  });
});

// ---------------------------------------------------------------------------
// Round-1 repair regressions (independent review blockers 1-6)
// ---------------------------------------------------------------------------

describe("round-1 repair: output isolation and reservation", () => {
  test("rejects an output whose existing parent alias resolves inside the source root", async () => {
    const repo = makeRepo("alias-parent");
    mkdirSync(join(repo, "sub"), { recursive: true });
    const host = freshDir(OUTPUTS, "alias-parent-host");
    mkdirSync(host, { recursive: true });
    const alias = join(host, "into-source");
    try {
      symlinkSync(join(repo, "sub"), alias, "junction");
    } catch {
      return;
    }
    await expectCode(
      captureSnapshot(baseOptions(repo, { outputRoot: join(alias, "out") })),
      "OUTPUT_OVERLAP",
    );
  });

  test("refuses a preexisting symlink/junction at the output location", async () => {
    const repo = makeRepo("alias-out");
    const host = freshDir(OUTPUTS, "alias-out-host");
    mkdirSync(host, { recursive: true });
    const out = join(host, "out");
    try {
      symlinkSync(host, out, "junction");
    } catch {
      return;
    }
    await expectCode(captureSnapshot(baseOptions(repo, { outputRoot: out })), "OUTPUT_EXISTS");
  });

  test("detects an output collision created after validation instead of overwriting", async () => {
    const repo = makeRepo("collision");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const collideIo = {
      ...nodeSnapshotIo,
      writeFileExclusive(path: string, data: Buffer | string): void {
        nodeSnapshotIo.writeFileExclusive(path, Buffer.from("collision"));
        nodeSnapshotIo.writeFileExclusive(path, data);
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), collideIo), "OUTPUT_COLLISION");
  });
});

describe("round-1 repair: source symlink aliasing", () => {
  test("rejects an in-root junction alias with a harmless name before reading its target", async () => {
    const repo = makeRepo("inroot-alias");
    mkdirSync(join(repo, "private"), { recursive: true });
    writeFileSync(join(repo, "private", "token.txt"), "SECRET-TOKEN\n");
    try {
      symlinkSync(join(repo, "private"), join(repo, "notes"), "junction");
    } catch {
      return;
    }
    await expectCode(captureSnapshot(baseOptions(repo)), "SYMLINK_ESCAPE");
  });
});

describe("round-1 repair: publish-time revalidation", () => {
  test("rejects a HEAD change that happens after files were read", async () => {
    const repo = makeRepo("head-race");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    let committed = false;
    const headIo = {
      ...nodeSnapshotIo,
      readFile(path: string): Buffer {
        const buffer = nodeSnapshotIo.readFile(path);
        if (!committed && path.endsWith("keep.txt")) {
          committed = true;
          spawnSync(
            "git",
            [
              "-c",
              "user.email=audit@test.local",
              "-c",
              "user.name=audit-test",
              "commit",
              "--allow-empty",
              "-qm",
              "race",
            ],
            { cwd: repo, encoding: "utf8" },
          );
        }
        return buffer;
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), headIo), "RACE_DETECTED");
  });

  test("rejects a previously-read file that changes before the snapshot is published", async () => {
    const repo = makeRepo("late-change");
    writeFileSync(join(repo, "aaa.txt"), "aaa original\n");
    writeFileSync(join(repo, "zzz.txt"), "zzz original\n");
    let tampered = false;
    const lateIo = {
      ...nodeSnapshotIo,
      readFile(path: string): Buffer {
        const buffer = nodeSnapshotIo.readFile(path);
        if (!tampered && path.endsWith("zzz.txt")) {
          tampered = true;
          writeFileSync(join(repo, "aaa.txt"), "aaa tampered after read\n");
        }
        return buffer;
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), lateIo), "RACE_DETECTED");
  });
});

describe("round-1 repair: delta scope semantics", () => {
  test("declares delta scope and never claims whole-tree completeness on a clean repo", async () => {
    const repo = makeRepo("clean-delta");
    const manifest = await captureSnapshot(baseOptions(repo));

    expect(manifest.scope.delta).toBe(true);
    expect(manifest.scope.partial).toBe(false);

    const result = await checkFreshness(manifest);
    expect(result.fresh).toBe(true);
    expect(result.scopeComplete).toBe(false);
  });

  test("marks scope exclusions as partial", async () => {
    const repo = makeRepo("scope-exclusion");
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(join(repo, "docs", "readme.md"), "docs\n");

    const manifest = await captureSnapshot(baseOptions(repo, { scope: { exclusions: ["docs"] } }));
    expect(manifest.scope.partial).toBe(true);

    const result = await checkFreshness(manifest);
    expect(result.scopeComplete).toBe(false);
  });

  test("policy exclusions keep scopeComplete false", async () => {
    const repo = makeRepo("policy-excluded");
    writeFileSync(join(repo, ".env"), "SECRET=1\n");

    const manifest = await captureSnapshot(baseOptions(repo));
    expect(manifest.exclusions.length).toBeGreaterThan(0);

    const result = await checkFreshness(manifest);
    expect(result.scopeComplete).toBe(false);
  });
});

describe("round-1 repair: hard and incremental limits", () => {
  test("rejects an excessive limit option above the hard ceiling", async () => {
    const repo = makeRepo("limit-hard");
    await expect(
      captureSnapshot(baseOptions(repo, { limits: { maxFileBytes: 10 * 1024 * 1024 * 1024 } })),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
    await expect(
      captureSnapshot(baseOptions(repo, { limits: { maxFiles: 10_000_000 } })),
    ).rejects.toBeInstanceOf(SnapshotValidationError);
  });

  test("enforces the aggregate byte limit before reading the offending file", async () => {
    const repo = makeRepo("limit-bytes");
    writeFileSync(join(repo, "a.txt"), "0123456789");
    writeFileSync(join(repo, "b.txt"), "0123456789");
    let reads = 0;
    const countingIo = {
      ...nodeSnapshotIo,
      readFile(path: string): Buffer {
        reads += 1;
        return nodeSnapshotIo.readFile(path);
      },
    };
    await expectCode(
      captureSnapshot(baseOptions(repo, { limits: { maxTotalBytes: 15 } }), countingIo),
      "LIMIT_EXCEEDED",
    );
    expect(reads).toBe(1);
  });

  test("enforces the file-count limit incrementally", async () => {
    const repo = makeRepo("limit-files");
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    let reads = 0;
    const countingIo = {
      ...nodeSnapshotIo,
      readFile(path: string): Buffer {
        reads += 1;
        return nodeSnapshotIo.readFile(path);
      },
    };
    await expectCode(
      captureSnapshot(baseOptions(repo, { limits: { maxFiles: 1 } }), countingIo),
      "LIMIT_EXCEEDED",
    );
    expect(reads).toBe(1);
  });
});

describe("round-1 repair: unsafe git paths", () => {
  test("fails closed on an unsafe path reported by git instead of silently skipping", async () => {
    const repo = makeRepo("unsafe-path");
    writeFileSync(join(repo, "keep.txt"), "keep content\nchanged\n");
    const unsafeIo = {
      ...nodeSnapshotIo,
      git(cwd: string, args: string[]): string {
        const out = nodeSnapshotIo.git(cwd, args);
        if (args[0] === "status") return `${out} M bad\u0001name\0`;
        return out;
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), unsafeIo), "PATH_UNSAFE");
  });
});

// ---------------------------------------------------------------------------
// Round-2 repair regressions (path-boundary blockers from task-2-review-round2)
// ---------------------------------------------------------------------------

describe("round-2 repair: output tail ancestor links", () => {
  test("refuses a parent junction injected into the output tail before its directory is created", async () => {
    const repo = makeRepo("tail-junction");
    const host = outDir("tail-junction-host");
    mkdirSync(host, { recursive: true });
    const redirect = outDir("tail-junction-redirect");
    mkdirSync(redirect, { recursive: true });
    const outputRoot = join(host, "a", "b", "out");
    let injected = false;
    const injectIo = {
      ...nodeSnapshotIo,
      mkdirExclusive(path: string): void {
        if (!injected && path === join(host, "a")) {
          injected = true;
          rmSync(path, { recursive: true, force: true });
          symlinkSync(redirect, path, "junction");
        }
        nodeSnapshotIo.mkdirExclusive(path);
      },
    };
    await expectCode(
      captureSnapshot(baseOptions(repo, { outputRoot }), injectIo),
      "OUTPUT_COLLISION",
    );
    expect(existsSync(join(redirect, "b"))).toBe(false);
    expect(existsSync(join(redirect, "files"))).toBe(false);
    expect(existsSync(join(redirect, "manifest.json"))).toBe(false);
  });

  test("refuses a junction inserted at a copy destination parent before the file is written", async () => {
    const repo = makeRepo("dest-junction");
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "file.txt"), "payload\n");
    const redirect = outDir("dest-junction-redirect");
    mkdirSync(redirect, { recursive: true });
    let injected = false;
    const injectIo = {
      ...nodeSnapshotIo,
      mkdirExclusive(path: string): void {
        if (!injected && path.endsWith(join("files", "sub"))) {
          injected = true;
          rmSync(path, { recursive: true, force: true });
          symlinkSync(redirect, path, "junction");
        }
        nodeSnapshotIo.mkdirExclusive(path);
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), injectIo), "OUTPUT_COLLISION");
    expect(existsSync(join(redirect, "file.txt"))).toBe(false);
    expect(existsSync(join(redirect, "sub"))).toBe(false);
  });
});

describe("round-2 repair: source reread component checks", () => {
  test("rejects a source parent that becomes a link before publish-time revalidation", async () => {
    const repo = makeRepo("reread-parent-link");
    mkdirSync(join(repo, "sub"), { recursive: true });
    writeFileSync(join(repo, "sub", "file.txt"), "stable payload\n");
    writeFileSync(join(repo, "zzz.txt"), "trigger\n");
    let swapped = false;
    const linkIo = {
      ...nodeSnapshotIo,
      lstat(path: string) {
        const stats = nodeSnapshotIo.lstat(path);
        if (swapped && path === join(repo, "sub")) {
          return {
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            ino: stats.ino,
            isFile: () => stats.isFile(),
            isDirectory: () => stats.isDirectory(),
            isSymbolicLink: () => true,
          };
        }
        return stats;
      },
      readFile(path: string): Buffer {
        const buffer = nodeSnapshotIo.readFile(path);
        if (!swapped && path.endsWith("zzz.txt")) swapped = true;
        return buffer;
      },
    };
    await expectCode(captureSnapshot(baseOptions(repo), linkIo), "RACE_DETECTED");
  });
});
