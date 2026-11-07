import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

/** Create an isolated graph whose expected reachability is easy to query with stock Git. */
export async function createNavigationFixture(root) {
  const repository = join(root, "repository with space\nand newline");
  const remote = join(root, "origin.git");
  const linkedPath = join(root, "linked worktree\npath");
  const detachedPath = join(root, "detached worktree");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "--bare", remote]);
  await git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  await config(repository);
  await git(repository, ["remote", "add", "origin", remote]);

  await writeCommitFile(repository, "special/space name.txt", "space\n", "base with special paths");
  const base = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "--quiet", "-b", "feature/merged"]);
  await writeCommitFile(repository, "feature merged.txt", "merged\n", "merged branch commit");
  const merged = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "--quiet", "main"]);
  await git(repository, ["merge", "--quiet", "--ff-only", "feature/merged"]);
  await writeCommitFile(repository, "special/new\nline.txt", "newline path\n", "main descendant");
  const mainTip = await git(repository, ["rev-parse", "HEAD"]);

  await git(repository, ["checkout", "--quiet", "-b", "feature/diverged", base]);
  await writeCommitFile(repository, "diverged.txt", "diverged\n", "diverged branch");
  const diverged = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["checkout", "--quiet", "main"]);

  await git(repository, ["checkout", "--quiet", "-b", "remote-only", base]);
  await writeCommitFile(repository, "remote-only.txt", "remote\n", "remote-only commit");
  const remoteOnly = await git(repository, ["rev-parse", "HEAD"]);
  await git(repository, ["push", "--quiet", "-u", "origin", "main", "feature/merged", "feature/diverged", "remote-only"]);
  await git(repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  await git(repository, ["checkout", "--quiet", "main"]);

  await git(repository, ["tag", "-a", "release/annotated", "-m", "annotated release", mainTip]);
  const tagOnlyTree = await git(repository, ["rev-parse", `${base}^{tree}`]);
  const tagOnly = await git(repository, ["-c", "user.name=Navigation Test", "-c", "user.email=navigation@example.invalid", "commit-tree", tagOnlyTree, "-m", "tag-only history"]);
  await git(repository, ["tag", "tag-only-history", tagOnly]);
  const reflogOnly = await git(repository, ["-c", "user.name=Navigation Test", "-c", "user.email=navigation@example.invalid", "commit-tree", tagOnlyTree, "-m", "reflog-only history"]);
  await git(repository, ["-c", "core.logAllRefUpdates=true", "update-ref", "-m", "temporary reflog root", "refs/heads/reflog-only", reflogOnly]);
  await git(repository, ["-c", "core.logAllRefUpdates=true", "update-ref", "-m", "move reflog root away", "refs/heads/reflog-only", mainTip, reflogOnly]);
  const blobSource = join(root, "non-commit-tag-target.txt");
  await writeFile(blobSource, "blob target\n");
  const blob = await git(repository, ["hash-object", "-w", "--", blobSource]);
  await git(repository, ["tag", "non-commit-tag", blob]);

  // Keep an object reachable only through refs/stash; allBranches must not include it.
  await writeFile(join(repository, "stash-only.txt"), "stash payload\n");
  await git(repository, ["stash", "push", "--quiet", "-u", "-m", "stash-only history"]);
  const stashTip = await git(repository, ["rev-parse", "refs/stash"]);

  await git(repository, ["worktree", "add", "--quiet", "-b", "linked/topic", linkedPath, mainTip]);
  await config(linkedPath);
  await writeCommitFile(linkedPath, "linked-only.txt", "linked\n", "linked worktree commit");
  const linkedTip = await git(linkedPath, ["rev-parse", "HEAD"]);
  await git(repository, ["worktree", "add", "--quiet", "--detach", detachedPath, diverged]);

  let sha256Repository = null;
  let sha256Tip = null;
  const candidate = join(root, "sha256-repository");
  try {
    await git(root, ["init", "--quiet", "--initial-branch=main", "--object-format=sha256", candidate]);
    await config(candidate);
    await writeCommitFile(candidate, "sha256.txt", "sha256\n", "sha256 root");
    sha256Repository = candidate;
    sha256Tip = await git(candidate, ["rev-parse", "HEAD"]);
  } catch {
    // Older system Git builds may not support SHA-256 repositories.
  }

  return {
    repository: await realpath(repository),
    remote: await realpath(remote),
    linkedPath: await realpath(linkedPath),
    detachedPath: await realpath(detachedPath),
    commits: { base, merged, mainTip, diverged, remoteOnly, tagOnly, reflogOnly, stashTip, linkedTip, sha256Tip },
    sha256Repository: sha256Repository ? await realpath(sha256Repository) : null,
  };
}

export async function git(cwd, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = await execFileAsync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options, env: { ...env, ...options.env },
  });
  return result.stdout.trimEnd();
}

async function config(repository) {
  await git(repository, ["config", "user.name", "Navigation Test"]);
  await git(repository, ["config", "user.email", "navigation@example.invalid"]);
}

async function writeCommitFile(repository, relativePath, contents, message) {
  const path = join(repository, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  await git(repository, ["add", "--", relativePath]);
  await git(repository, ["commit", "--quiet", "-m", message]);
}
