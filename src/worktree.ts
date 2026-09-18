/**
 * Worktree manager for Teamwork.
 *
 * Each agent (sentinel, builder, verifier, searcher) gets its own git
 * worktree so concurrent edits can't collide and the verifier can inspect a
 * worker's branch without touching it.
 *
 * Cross-platform + injection-safe by construction: every git call is spawned
 * with an argv array and `shell: false`. The previous implementation built
 * shell strings and escaped them POSIX-style, which is wrong on Windows
 * (where `execSync` goes through cmd.exe) and dangerous because agent names
 * come from a model-produced plan. `assertAgentName` fails closed on
 * anything that isn't a plain identifier, so a hostile plan can't escape the
 * run directory via `../`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

export interface WorktreeInfo {
  agentName: string;
  path: string; // absolute path
  branch: string; // e.g. "teamwork/agent-builder-<session8>"
  baseBranch: string; // e.g. "teamwork/base-<session-id>"
}

export interface WorktreeManager {
  initSession(sessionId: string, options?: { cwd?: string }): WorktreeInfo;
  addAgent(agentName: string, sessionId: string, options?: { cwd?: string }): WorktreeInfo;
  removeAgent(agentName: string, sessionId: string, options?: { cwd?: string }): void;
  cleanupSession(sessionId: string, options?: { cwd?: string }): void;
  list(sessionId: string, options?: { cwd?: string }): WorktreeInfo[];
  isGitRepo(options?: { cwd?: string }): boolean;
}

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class WorktreeError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

/** Agent names end up in branch names and filesystem paths. Fail closed. */
export function assertAgentName(name: string): void {
  if (!AGENT_NAME_RE.test(name)) {
    throw new WorktreeError(
      `invalid agent name "${name}" — expected 1-32 chars of [A-Za-z0-9_-]`,
    );
  }
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new WorktreeError(
      `invalid session id "${sessionId}" — expected 1-128 chars of [A-Za-z0-9._-]`,
    );
  }
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

/** Run git with an argv array. No shell, no string interpolation. */
export function git(args: string[], cwd?: string): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.error) {
    return { ok: false, stdout, stderr: `${stderr}${res.error.message}`, status: null };
  }
  return { ok: res.status === 0, stdout, stderr, status: res.status };
}

export function runDirFor(cwd: string, sessionId: string): string {
  return join(cwd, ".opencode", "teamwork", sessionId);
}

function sessionDir(sessionId: string): string {
  return join(".opencode", "teamwork", sessionId);
}

function baseBranch(sessionId: string): string {
  return `teamwork/base-${sessionId}`;
}

function agentBranch(agentName: string, sessionId: string): string {
  return `teamwork/agent-${agentName}-${sessionId.slice(0, 8)}`;
}

function worktreesRoot(cwd: string, sessionId: string): string {
  return resolve(cwd, sessionDir(sessionId), "worktrees");
}

/** Refuse to touch a path outside the run's worktrees directory. */
function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(normalizedRoot + sep)) {
    throw new WorktreeError(`refusing to operate outside ${normalizedRoot}: ${normalizedTarget}`);
  }
}

export function createWorktreeManager(): WorktreeManager {
  return {
    isGitRepo(opts) {
      return git(["rev-parse", "--git-dir"], opts?.cwd).ok;
    },

    initSession(sessionId, opts) {
      assertSessionId(sessionId);
      const cwd = opts?.cwd ?? process.cwd();
      const dir = join(worktreesRoot(cwd, sessionId), "sentinel");

      if (!this.isGitRepo({ cwd })) {
        // Not a git repo: keep the directory layout so artifacts and paths
        // stay stable, but skip git entirely. The caller is told via the
        // branch name being the base branch.
        mkdirSync(dir, { recursive: true });
        return { agentName: "sentinel", path: dir, branch: baseBranch(sessionId), baseBranch: baseBranch(sessionId) };
      }

      const base = baseBranch(sessionId);
      const exists = git(["rev-parse", "--verify", base], cwd).ok;
      if (!exists) {
        const created = git(["branch", base], cwd);
        if (!created.ok) throw new WorktreeError(`git branch ${base} failed`, created.stderr);
      }
      mkdirSync(worktreesRoot(cwd, sessionId), { recursive: true });
      const added = git(["worktree", "add", dir, base], cwd);
      if (!added.ok && !/already exists|is already registered/i.test(added.stderr)) {
        throw new WorktreeError(`git worktree add failed for sentinel`, added.stderr);
      }
      return { agentName: "sentinel", path: dir, branch: base, baseBranch: base };
    },

    addAgent(agentName, sessionId, opts) {
      assertAgentName(agentName);
      assertSessionId(sessionId);
      const cwd = opts?.cwd ?? process.cwd();
      const base = baseBranch(sessionId);
      const branch = agentBranch(agentName, sessionId);
      const root = worktreesRoot(cwd, sessionId);
      const dir = join(root, `agent-${agentName}`);
      assertInside(root, dir);
      mkdirSync(root, { recursive: true });

      const added = git(["worktree", "add", dir, "-b", branch, base], cwd);
      if (!added.ok) {
        if (!/already exists|is already registered/i.test(added.stderr)) {
          throw new WorktreeError(`git worktree add failed for ${agentName}`, added.stderr);
        }
        // Resume path: branch exists, worktree may or may not.
        if (!existsSync(dir)) {
          const reattach = git(["worktree", "add", dir, branch], cwd);
          if (!reattach.ok && !/already exists|is already registered/i.test(reattach.stderr)) {
            throw new WorktreeError(`git worktree re-attach failed for ${agentName}`, reattach.stderr);
          }
        }
      }
      return { agentName, path: dir, branch, baseBranch: base };
    },

    removeAgent(agentName, sessionId, opts) {
      assertAgentName(agentName);
      assertSessionId(sessionId);
      const cwd = opts?.cwd ?? process.cwd();
      const root = worktreesRoot(cwd, sessionId);
      const dir = join(root, `agent-${agentName}`);
      assertInside(root, dir);
      git(["worktree", "remove", "--force", dir], cwd); // best effort
      git(["branch", "-D", agentBranch(agentName, sessionId)], cwd); // best effort
      git(["worktree", "prune"], cwd);
    },

    cleanupSession(sessionId, opts) {
      assertSessionId(sessionId);
      const cwd = opts?.cwd ?? process.cwd();
      const root = worktreesRoot(cwd, sessionId);

      // Remove worktrees git actually knows about. The old implementation ran
      // `git worktree remove` against the *parent* directory (never a
      // worktree), swallowed the failure, then rmSync'd directories git still
      // had registered — leaving stale worktree metadata behind.
      for (const info of this.list(sessionId, { cwd })) {
        git(["worktree", "remove", "--force", info.path], cwd);
      }
      if (existsSync(root)) {
        for (const entry of readWorktreeDirs(root)) {
          assertInside(root, entry);
          rmSync(entry, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
      }
      // Delete session branches, then prune. Branch names come from git, not
      // from a shell expansion (the old code used $(...) which is a no-op on
      // Windows and unquoted elsewhere).
      const suffix = sessionId.slice(0, 8);
      const branches = git(["branch", "--list", `teamwork/*-${suffix}`], cwd);
      if (branches.ok) {
        for (const line of branches.stdout.split("\n")) {
          const name = line.replace(/^\*?\s*/, "").trim();
          if (!name) continue;
          git(["branch", "-D", name], cwd);
        }
      }
      const base = baseBranch(sessionId);
      if (git(["rev-parse", "--verify", base], cwd).ok) {
        git(["branch", "-D", base], cwd);
      }
      git(["worktree", "prune"], cwd);
    },

    list(sessionId, opts) {
      assertSessionId(sessionId);
      const cwd = opts?.cwd ?? process.cwd();
      const out = git(["worktree", "list", "--porcelain"], cwd);
      const results: WorktreeInfo[] = [];
      if (!out.ok) return results;
      const prefix = sessionDir(sessionId).split(sep).join("/");
      for (const block of out.stdout.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        const pathLine = lines.find((l) => l.startsWith("worktree "));
        const branchLine = lines.find((l) => l.startsWith("branch "));
        if (!pathLine || !branchLine) continue;
        const path = pathLine.slice("worktree ".length).trim();
        const normalized = path.split(sep).join("/");
        if (!normalized.includes(prefix)) continue;
        const branch = branchLine
          .slice("branch ".length)
          .trim()
          .replace(/^refs\/heads\//, "");
        const agentName = basename(path).replace(/^agent-/, "") || "sentinel";
        results.push({ agentName, path, branch, baseBranch: baseBranch(sessionId) });
      }
      return results;
    },
  };
}

function readWorktreeDirs(root: string): string[] {
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
}

/**
 * Read a file from a worktree at a recorded commit-ish, without checking it
 * out. Used by the verifier to hash evidence deterministically.
 */
export function readFromWorktree(worktreePath: string, relPath: string): string | null {
  const target = join(worktreePath, relPath);
  if (!existsSync(target)) return null;
  try {
    return readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}
