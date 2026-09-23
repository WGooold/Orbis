import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { readGitBranch } from "./git-branch.js";

const execFileAsync = promisify(execFile);

it("reads the working tree's current HEAD, including checkout, linked worktrees and detached HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-working-branch-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    await execFileAsync("git", args, { cwd, env: gitEnv, windowsHide: true });
  };
  try {
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main");
    // Even an empty repository has a branch; rev-parse HEAD alone would miss this.
    expect(await readGitBranch(repo)).toEqual({ branch: "main", commit: null });
    await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "initial");
    await git(repo, "worktree", "add", "-b", "feature/mobile", worktree);
    const child = join(worktree, "nested");
    await mkdir(child);
    expect(await readGitBranch(child)).toEqual({ branch: "feature/mobile", commit: null });
    await git(worktree, "switch", "-c", "fix/layout");
    expect(await readGitBranch(child)).toEqual({ branch: "fix/layout", commit: null });
    await git(worktree, "checkout", "--detach");
    expect(await readGitBranch(child)).toEqual({ branch: null, commit: expect.stringMatching(/^[a-f0-9]{8,64}$/u) });
    expect(await readGitBranch(repo)).toEqual({ branch: "main", commit: null });
    expect(await readGitBranch(root)).toEqual({ branch: null, commit: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
