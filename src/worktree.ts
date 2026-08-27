/**
 * Worktree manager for Teamwork.
 *
 * Each agent (Sentinel, builder, verifier, searcher) gets its own
 * git worktree so concurrent file edits don't collide. The Sentinel
 * owns the orchestration; the workers never touch each other's
 * worktrees.
 *
 * This module is intentionally pure-Node — no shell-out where we
 * can avoid it. The `git worktree add` step is the one place we
 * shell out, because there's no Node API for it.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const SHELL_QUOTE = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

export interface WorktreeInfo {
  agentName: string;
  path: string;          // absolute path
  branch: string;        // e.g. "teamwork/agent-builder"
  baseBranch: string;    // e.g. "teamwork/base-<session-id>"
}

export interface WorktreeManager {
  /** Create the base branch + Sentinel worktree for a session. */
  initSession(sessionId: string, options?: { cwd?: string }): WorktreeInfo;
  /** Create a worker worktree from a base branch. */
  addAgent(agentName: string, sessionId: string, options?: { cwd?: string }): WorktreeInfo;
  /** Remove an agent's worktree and prune. */
  removeAgent(agentName: string, sessionId: string, options?: { cwd?: string }): void;
  /** Remove all worktrees for a session (cleanup). */
  cleanupSession(sessionId: string, options?: { cwd?: string }): void;
  /** List worktrees. */
  list(sessionId: string, options?: { cwd?: string }): WorktreeInfo[];
  /** Check if the current directory is a git repo. */
  isGitRepo(options?: { cwd?: string }): boolean;
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

function run(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    throw new Error(
      `Command failed: ${cmd}\n` +
      `exit: ${e.status}\n` +
      `stderr: ${e.stderr}\n` +
      `stdout: ${e.stdout ?? ""}`,
    );
  }
}

export function createWorktreeManager(): WorktreeManager {
  return {
    isGitRepo(opts) {
      try {
        run("git rev-parse --git-dir", opts?.cwd);
        return true;
      } catch {
        return false;
      }
    },

    initSession(sessionId, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      if (!this.isGitRepo({ cwd })) {
        // No git repo — we still create the .opencode/teamwork
        // directory, but skip the worktree. The user can initialize
        // git later.
        const dir = resolve(cwd, sessionDir(sessionId), "worktrees", "sentinel");
        mkdirSync(dir, { recursive: true });
        return { agentName: "sentinel", path: dir, branch: baseBranch(sessionId), baseBranch: baseBranch(sessionId) };
      }

      const base = baseBranch(sessionId);
      // Create the base branch from current HEAD. If it already
      // exists, this is a resume — just check it out.
      try {
        run(`git rev-parse --verify ${SHELL_QUOTE(base)}`, cwd);
      } catch {
        run(`git branch ${SHELL_QUOTE(base)}`, cwd);
      }
      const dir = resolve(cwd, sessionDir(sessionId), "worktrees", "sentinel");
      try {
        run(`git worktree add ${SHELL_QUOTE(dir)} ${SHELL_QUOTE(base)}`, cwd);
      } catch (err) {
        // Worktree already exists — that's OK on resume.
        if (!(err as Error).message.includes("already exists")) throw err;
      }
      return { agentName: "sentinel", path: dir, branch: base, baseBranch: base };
    },

    addAgent(agentName, sessionId, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const base = baseBranch(sessionId);
      const branch = agentBranch(agentName, sessionId);
      const dir = resolve(cwd, sessionDir(sessionId), "worktrees", `agent-${agentName}`);
      mkdirSync(resolve(cwd, sessionDir(sessionId), "worktrees"), { recursive: true });
      try {
        run(`git worktree add ${SHELL_QUOTE(dir)} -b ${SHELL_QUOTE(branch)} ${SHELL_QUOTE(base)}`, cwd);
      } catch (err) {
        if (!(err as Error).message.includes("already exists")) throw err;
        // Resume: branch exists, just re-add the worktree
        try {
          run(`git worktree add ${SHELL_QUOTE(dir)} ${SHELL_QUOTE(branch)}`, cwd);
        } catch (err2) {
          if (!(err2 as Error).message.includes("already exists")) throw err2;
        }
      }
      return { agentName, path: dir, branch, baseBranch: base };
    },

    removeAgent(agentName, sessionId, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const branch = agentBranch(agentName, sessionId);
      const dir = resolve(cwd, sessionDir(sessionId), "worktrees", `agent-${agentName}`);
      try {
        run(`git worktree remove --force ${SHELL_QUOTE(dir)}`, cwd);
      } catch {
        // best effort
      }
      try {
        run(`git branch -D ${SHELL_QUOTE(branch)}`, cwd);
      } catch {
        // best effort
      }
      try {
        run(`git worktree prune`, cwd);
      } catch {
        // best effort
      }
    },

    cleanupSession(sessionId, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const dir = resolve(cwd, sessionDir(sessionId), "worktrees");
      if (existsSync(dir)) {
        run(`git worktree remove --force ${SHELL_QUOTE(dir)} 2>/dev/null || true`, cwd);
        rmSync(dir, { recursive: true, force: true });
      }
      // Delete all session branches
      try {
        run(`git branch -D $(git branch --list "teamwork/*-${sessionId.slice(0, 8)}") 2>/dev/null || true`, cwd);
      } catch {
        // best effort
      }
      try {
        run(`git worktree prune`, cwd);
      } catch {
        // best effort
      }
    },

    list(sessionId, opts) {
      const cwd = opts?.cwd ?? process.cwd();
      const out = run(`git worktree list --porcelain`, cwd);
      const out2: WorktreeInfo[] = [];
      const prefix = sessionDir(sessionId);
      for (const block of out.split("\n\n")) {
        const pathLine = block.split("\n").find((l) => l.startsWith("worktree "));
        const branchLine = block.split("\n").find((l) => l.startsWith("branch "));
        if (!pathLine || !branchLine) continue;
        const path = pathLine.replace(/^worktree /, "").trim();
        if (!path.includes(prefix)) continue;
        const branch = branchLine.replace(/^branch /, "").replace(/^refs\/heads\//, "").trim();
        const agentName = basename(path).replace(/^agent-/, "");
        out2.push({ agentName, path, branch, baseBranch: baseBranch(sessionId) });
      }
      return out2;
    },
  };
}
