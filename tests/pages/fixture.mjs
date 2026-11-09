import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "../details/fixture.mjs";

/**
 * Repositories for the workspace, files and blame acceptance tests. Each one is built with ordinary Git
 * commands at fixed dates so the tests can compare the daemon with independent Git output.
 */
export async function createPagesFixtures(root) {
  await mkdir(root, { recursive: true });
  return {
    workspace: await createWorkspaceRepository(join(root, "workspace repo")),
    conflict: await createConflictRepository(join(root, "conflict repo")),
    empty: await createEmptyRepository(join(root, "empty repo")),
    ...(await createCleanAndLinked(root)),
    files: await createFilesRepository(join(root, "files repo")),
    blame: await createBlameRepository(join(root, "blame repo")),
  };
}

export { git };

const BASE_TIME = 1_700_100_000;

function identity(name, time) {
  return {
    GIT_AUTHOR_NAME: `${name} Author`, GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.invalid`, GIT_AUTHOR_DATE: `@${time} +0000`,
    GIT_COMMITTER_NAME: `${name} Committer`, GIT_COMMITTER_EMAIL: `${name.toLowerCase()}-c@example.invalid`, GIT_COMMITTER_DATE: `@${time} +0000`,
  };
}

async function init(repository) {
  await mkdir(dirname(repository), { recursive: true });
  await git(dirname(repository), ["init", "--quiet", "--initial-branch=main", repository]);
}

async function put(repository, path, content, mode) {
  const absolute = join(repository, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  if (mode) await chmod(absolute, mode);
}

async function commit(repository, message, name, time, paths = ["."]) {
  await git(repository, ["add", "--", ...paths]);
  await git(repository, ["commit", "--quiet", "--no-verify", "-m", message], { env: identity(name, time) });
  return git(repository, ["rev-parse", "HEAD"]);
}

function numbered(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join("\n") + "\n";
}

function edit(text, lineNumber, replacement) {
  const lines = text.split("\n");
  lines[lineNumber - 1] = replacement;
  return lines.join("\n");
}

async function createWorkspaceRepository(repository) {
  await init(repository);
  const partial = numbered("partial ", 12);
  const large = "x".repeat(99) + "\n";
  await put(repository, "partial.txt", partial);
  await put(repository, "staged-only.txt", numbered("staged ", 6));
  await put(repository, "unstaged-only.txt", numbered("unstaged ", 6));
  await put(repository, "deleted-staged.txt", "deleted in the index\n");
  await put(repository, "deleted-unstaged.txt", "deleted from the working tree\n");
  await put(repository, "rename-src.txt", numbered("rename source line ", 10));
  await put(repository, "binary.bin", Buffer.from([0, 1, 2, 3, 255, 0, 65, 66]));
  await put(repository, "large.txt", large.repeat(26 * 1024));
  await put(repository, "unicodé 目录/文件 名.txt", "第一行\n第二行\n");
  await put(repository, "script.sh", "#!/bin/sh\necho hi\n", 0o644);
  await put(repository, ".gitignore", "ignored.log\n");
  await commit(repository, "Workspace base", "Base", BASE_TIME);

  // Partly staged: one change in the index, another only in the working tree.
  await put(repository, "partial.txt", edit(partial, 2, "partial 2 staged"));
  await git(repository, ["add", "--", "partial.txt"]);
  await put(repository, "partial.txt", edit(edit(partial, 2, "partial 2 staged"), 10, "partial 10 unstaged"));
  // The staged version also loses its final newline.
  await put(repository, "staged-only.txt", "staged 1\nstaged 2 changed\nstaged 3");
  await git(repository, ["add", "--", "staged-only.txt"]);
  await put(repository, "unstaged-only.txt", edit(numbered("unstaged ", 6), 5, "unstaged 5 changed"));
  await git(repository, ["rm", "--quiet", "--", "deleted-staged.txt"]);
  await rm(join(repository, "deleted-unstaged.txt"));
  await mkdir(join(repository, "renamed"), { recursive: true });
  await git(repository, ["mv", "rename-src.txt", "renamed/dst.txt"]);
  await put(repository, "renamed/dst.txt", edit(numbered("rename source line ", 10), 10, "rename tail changed in the working tree"));
  await put(repository, "binary.bin", Buffer.from([0, 1, 2, 3, 254, 0, 65, 67, 68]));
  await put(repository, "large.txt", large.repeat(26 * 1024) + "one more line\n");
  await put(repository, "unicodé 目录/文件 名.txt", "第一行\n第二行 已暂存\n");
  await git(repository, ["add", "--", "unicodé 目录/文件 名.txt"]);
  await chmod(join(repository, "script.sh"), 0o755);
  await put(repository, "added.txt", "a new staged file\n");
  await git(repository, ["add", "--", "added.txt"]);
  // A gitlink staged without a checked-out submodule.
  await mkdir(join(repository, "sub"), { recursive: true });
  await git(repository, ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`]);

  await put(repository, "new file.txt", numbered("untracked line ", 300));
  await put(repository, "untracked dir/nested.txt", "nested untracked\n");
  await put(repository, "untracked-big.bin", Buffer.alloc(1024 * 1024 + 10, 0x61));
  await put(repository, "untracked-binary.dat", Buffer.from([0x50, 0, 0x51, 0]));
  await symlink("partial.txt", join(repository, "untracked-link"));
  await put(repository, "ignored.log", "ignored\n");
  return repository;
}

async function createConflictRepository(repository) {
  await init(repository);
  const base = numbered("conflict ", 5);
  await put(repository, "conflict.txt", base);
  await put(repository, "deleted-by-them.txt", "kept on main\n");
  await put(repository, "deleted-by-us.txt", "kept on side\n");
  await put(repository, "clean.txt", "untouched\n");
  await commit(repository, "Conflict base", "Base", BASE_TIME);
  await git(repository, ["checkout", "--quiet", "-b", "side"]);
  await put(repository, "conflict.txt", edit(base, 3, "conflict 3 side"));
  await git(repository, ["rm", "--quiet", "--", "deleted-by-them.txt"]);
  await put(repository, "deleted-by-us.txt", "changed on side\n");
  await put(repository, "both-added.txt", "added on side\n");
  await commit(repository, "Side changes", "Side", BASE_TIME + 100);
  await git(repository, ["checkout", "--quiet", "main"]);
  await put(repository, "conflict.txt", edit(base, 3, "conflict 3 main"));
  await put(repository, "deleted-by-them.txt", "changed on main\n");
  await git(repository, ["rm", "--quiet", "--", "deleted-by-us.txt"]);
  await put(repository, "both-added.txt", "added on main\n");
  await commit(repository, "Main changes", "Main", BASE_TIME + 200);
  try {
    await git(repository, ["merge", "--no-edit", "side"], { env: identity("Merge", BASE_TIME + 300) });
    throw new Error("the conflict fixture merge unexpectedly succeeded");
  } catch (error) {
    if (!/CONFLICT|exit code 1|Command failed/i.test(`${error.message}${error.stdout ?? ""}`)) throw error;
  }
  await put(repository, "clean.txt", "edited during the merge\n");
  return repository;
}

async function createEmptyRepository(repository) {
  await init(repository);
  await put(repository, "first.txt", "staged before the first commit\n");
  await git(repository, ["add", "--", "first.txt"]);
  await put(repository, "loose.txt", "untracked in an empty repository\n");
  return repository;
}

async function createCleanAndLinked(root) {
  const clean = join(root, "clean repo");
  await init(clean);
  await put(clean, "readme.txt", "clean\n");
  await put(clean, "notes.txt", numbered("note ", 4));
  await commit(clean, "Clean base", "Base", BASE_TIME);
  const linked = join(root, "linked worktree");
  await git(clean, ["worktree", "add", "--quiet", "-b", "linked-branch", linked]);
  await put(linked, "notes.txt", edit(numbered("note ", 4), 2, "note 2 in the linked worktree"));
  await put(linked, "linked-only.txt", "untracked in the linked worktree\n");
  const bare = join(root, "bare repo.git");
  await git(root, ["clone", "--quiet", "--bare", clean, bare]);
  return { clean, linked, bare };
}

async function createFilesRepository(repository) {
  await init(repository);
  const a = numbered("a", 20);
  await put(repository, "src/a.txt", a);
  await put(repository, "src/gone.txt", "removed later\n");
  await put(repository, "docs/readme.md", numbered("readme paragraph ", 8));
  await put(repository, "bin.dat", Buffer.from([0, 159, 146, 150, 0, 1]));
  await put(repository, "lfs.bin", `version https://git-lfs.github.com/spec/v1\noid sha256:${"ab".repeat(32)}\nsize 12345\n`);
  await put(repository, "empty.txt", "");
  await put(repository, "exec.sh", "#!/bin/sh\necho run\n", 0o755);
  await symlink("src/a.txt", join(repository, "link"));
  await put(repository, "unicodé 目录/文件 名.txt", "unicode path\n");
  await put(repository, "-dash.txt", "starts with a dash\n");
  await put(repository, "big.txt", numbered("big ", 6000));
  for (let index = 1; index <= 7; index += 1) await put(repository, `many/item-${index}.txt`, `item ${index}\n`);
  await git(repository, ["add", "--", "."]);
  await git(repository, ["update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},sub`]);
  const invalidPath = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const blob = await git(repository, ["hash-object", "-w", "--stdin"], { input: Buffer.from("invalid UTF-8 path\n") });
  await git(repository, ["update-index", "-z", "--index-info"], { input: Buffer.concat([Buffer.from(`100644 ${blob} 0\t`), invalidPath, Buffer.from([0])]) });
  await git(repository, ["commit", "--quiet", "--no-verify", "-m", "Files root"], { env: identity("Root", BASE_TIME) });
  const root = await git(repository, ["rev-parse", "HEAD"]);

  await git(repository, ["checkout", "--quiet", "-b", "side"]);
  await put(repository, "src/a.txt", edit(a, 15, "a15 side"));
  await put(repository, "side-only.txt", "only on the side branch\n");
  const side = await commit(repository, "Side edits a.txt", "Side", BASE_TIME + 100, ["src/a.txt", "side-only.txt"]);
  await git(repository, ["checkout", "--quiet", "main"]);

  await put(repository, "src/a.txt", edit(a, 3, "a3 main"));
  await git(repository, ["mv", "docs/readme.md", "docs/README.md"]);
  await git(repository, ["rm", "--quiet", "--", "bin.dat"]);
  const renamed = await commit(repository, "Main edits a.txt and renames the readme", "Main", BASE_TIME + 200, ["src/a.txt", "docs"]);

  await git(repository, ["merge", "--quiet", "--no-ff", "--no-edit", "side", "-m", "Merge side into main"], { env: identity("Merge", BASE_TIME + 300) });
  const merge = await git(repository, ["rev-parse", "HEAD"]);

  await put(repository, "src/a.txt", edit(edit(edit(a, 3, "a3 main"), 15, "a15 side"), 10, "a10 after merge"));
  await git(repository, ["rm", "--quiet", "--", "src/gone.txt"]);
  const head = await commit(repository, "Edit a.txt again and remove gone.txt", "Head", BASE_TIME + 400, ["src"]);
  return { repository, root, side, renamed, merge, head, invalidPath };
}

async function createBlameRepository(repository) {
  await init(repository);
  const oldPath = "old dir/旧 名.txt";
  const newPath = "new dir/新 名.txt";
  const base = numbered("line ", 6);
  await put(repository, oldPath, base);
  await put(repository, "empty.txt", "");
  await put(repository, "too-many-lines.txt", "x\n".repeat(20_001));
  await put(repository, "too-many-bytes.txt", ("y".repeat(1023) + "\n").repeat(1025));
  await put(repository, "bin.dat", Buffer.from([0, 1, 2, 0, 3]));
  const alternating = Array.from({ length: 12_000 }, (_, index) => `alternating line ${index + 1}`);
  await put(repository, "alternating.txt", alternating.join("\n") + "\n");
  const root = await commit(repository, "Blame root", "Root", BASE_TIME);

  await put(repository, oldPath, edit(base, 2, "line 2 edited"));
  const second = await commit(repository, "Edit line 2 before the rename", "Second", BASE_TIME + 100);
  await mkdir(join(repository, "new dir"), { recursive: true });
  await git(repository, ["mv", oldPath, newPath]);
  const rename = await commit(repository, "Rename the whole file", "Rename", BASE_TIME + 200);
  const afterRename = edit(edit(base, 2, "line 2 edited"), 4, "line 4 after the rename");
  await put(repository, newPath, afterRename);
  await put(repository, "alternating.txt", alternating.map((line, index) => index % 2 ? `${line} changed` : line).join("\n") + "\n");
  const fourth = await commit(repository, "Edit after the rename", "Fourth", BASE_TIME + 300);

  await git(repository, ["checkout", "--quiet", "-b", "side"]);
  await put(repository, newPath, edit(afterRename, 6, "line 6 from side"));
  const side = await commit(repository, "Side edits line 6", "Side", BASE_TIME + 400);
  await git(repository, ["checkout", "--quiet", "main"]);
  await put(repository, newPath, edit(afterRename, 1, "line 1 on main"));
  const fifth = await commit(repository, "Main edits line 1", "Fifth", BASE_TIME + 500);
  await git(repository, ["merge", "--quiet", "--no-ff", "--no-edit", "side", "-m", "Merge side for blame"], { env: identity("Merge", BASE_TIME + 600) });
  const merge = await git(repository, ["rev-parse", "HEAD"]);
  return { repository, oldPath, newPath, root, second, rename, fourth, side, fifth, merge };
}
