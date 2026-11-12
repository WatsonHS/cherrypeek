import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { PagesDaemonClient, createDaemonEnvironment, projectSession } from "./daemon-client.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const fixture = JSON.parse(await readFile(resolve(process.env.COMMITSCOPE_PAGES_FIXTURE), "utf8"));
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const dataRoot = resolve(process.env.COMMITSCOPE_PAGES_DATA_ROOT);
const home = resolve(process.env.COMMITSCOPE_PAGES_HOME);
const wrapper = process.env.COMMITSCOPE_PAGES_GIT_WRAPPER ? resolve(process.env.COMMITSCOPE_PAGES_GIT_WRAPPER) : null;
const gatePath = resolve(process.env.COMMITSCOPE_PAGES_GATE_FILE);
const startedPath = resolve(process.env.COMMITSCOPE_PAGES_GATE_STARTED);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const hex = text => Buffer.from(text, "utf8").toString("hex");
const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typeChanged" };
const CONFLICT = { "123": "bothModified", "23": "bothAdded", "1": "bothDeleted", "2": "addedByUs", "3": "addedByThem", "13": "deletedByUs", "12": "deletedByThem" };

// ---------------------------------------------------------------------------------------------
// P4-09 workspace status, diffs and previews against independent Git
// ---------------------------------------------------------------------------------------------

for (const [label, key] of [
  ["partly staged, untracked, deleted, renamed, binary, oversized, mode-only and gitlink changes", "workspace"],
  ["a merge stopped on conflicts", "conflict"],
  ["an empty repository with a staged first file", "empty"],
  ["a clean repository", "clean"],
  ["a linked worktree on its own branch", "linked"],
]) {
  test(`workspace status matches independent Git: ${label}`, async t => {
    const repository = fixture[key];
    const before = await snapshotTree(repository);
    const client = await openClient(`workspace-${key}`, repository);
    let status; let diffs; let previews;
    try {
      status = await client.workspaceStatus();
      diffs = await readAllDiffs(client, status);
      previews = await readUntrackedPreviews(client, status);
    } finally {
      await client.stop();
    }
    assert.deepEqual(await snapshotTree(repository), before, "reads leave the working tree, index, HEAD and refs unchanged");

    const expected = await expectedWorkspace(repository);
    assert.equal(status.complete, true);
    assert.equal(status.headReference, expected.headReference);
    assert.equal(status.headOid, expected.headOid);
    assert.equal(status.operation, expected.operation);
    assert.equal(status.totalPaths, expected.entries.size);
    assert.equal(status.conflictCount, [...expected.entries.values()].filter(entry => entry.conflict).length);
    const actual = new Map(status.entries.map(entry => [entry.path.rawHex, entry]));
    assert.deepEqual([...actual.keys()].sort(), [...expected.entries.keys()].sort(), "the same paths are listed");
    for (const [pathHex, want] of expected.entries) {
      const entry = actual.get(pathHex);
      const where = Buffer.from(pathHex, "hex").toString("utf8");
      assert.equal(entry.originalPath?.rawHex ?? null, want.originalPathHex, `${where}: original path`);
      assert.deepEqual(entry.staged, want.staged, `${where}: staged change`);
      assert.deepEqual(entry.unstaged, want.unstaged, `${where}: unstaged change`);
      assert.equal(entry.untracked, want.untracked, `${where}: untracked`);
      assert.equal(entry.untrackedSize, want.untrackedSize, `${where}: untracked size`);
      assert.equal(entry.conflict, want.conflict, `${where}: conflict`);
    }
    await compareDiffs(repository, diffs);
    await comparePreviews(repository, previews);
    t.diagnostic(`${status.entries.length} entries, ${diffs.length} diffs, ${previews.length} previews compared`);
  });
}

test("workspace diffs explain binary, oversized and gitlink changes; conflicts and bare repositories answer clearly", async () => {
  const client = await openClient("workspace-kinds", fixture.workspace);
  try {
    const binary = await client.workspaceDiff("unstaged", hex("binary.bin"));
    assert.equal(binary.kind, "binary");
    assert.equal(binary.patch.includes("@@"), false);
    const large = await client.workspaceDiff("unstaged", hex("large.txt"));
    assert.equal(large.kind, "tooLarge");
    assert.equal(large.patch, "");
    const gitlink = await client.workspaceDiff("staged", hex("sub"));
    assert.equal(gitlink.kind, "gitlink");
    const big = await client.workspaceFile(hex("untracked-big.bin"), 200);
    assert.equal(big.kind, "tooLarge");
    assert.equal(big.text, "");
    const binaryFile = await client.workspaceFile(hex("untracked-binary.dat"), 200);
    assert.equal(binaryFile.kind, "binary");
    const link = await client.workspaceFile(hex("untracked-link"), 200);
    assert.equal(link.kind, "symlink");
    assert.equal(link.symlinkTarget.display, "partial.txt");
    await assert.rejects(client.workspaceFile(hex("../outside.txt"), 200), error => error.code === "INVALID_REQUEST");
    await assert.rejects(client.workspaceFile(hex(".git/config"), 200), error => error.code === "INVALID_REQUEST");
  } finally {
    await client.stop();
  }

  const conflict = await openClient("workspace-conflict-diff", fixture.conflict);
  try {
    await assert.rejects(conflict.workspaceDiff("unstaged", hex("conflict.txt")), error => error.code === "MISSING_OBJECT");
  } finally {
    await conflict.stop();
  }

  const bare = await openClient("workspace-bare", fixture.bare);
  try {
    await assert.rejects(bare.workspaceStatus(), error => error.code === "INVALID_REQUEST", "a bare repository has no working tree and is never reported clean");
  } finally {
    await bare.stop();
  }
});

test("the linked worktree and its main checkout are read separately", async () => {
  const main = await openClient("workspace-main-of-linked", fixture.clean);
  const linked = await openClient("workspace-linked-of-main", fixture.linked);
  try {
    const mainStatus = await main.workspaceStatus();
    const linkedStatus = await linked.workspaceStatus();
    assert.equal(mainStatus.headReference, "refs/heads/main");
    assert.equal(mainStatus.entries.length, 0);
    assert.equal(linkedStatus.headReference, "refs/heads/linked-branch");
    assert.deepEqual(linkedStatus.entries.map(entry => entry.path.display).sort(), ["linked-only.txt", "notes.txt"]);
  } finally {
    await main.stop();
    await linked.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// P4-10 files page and P4-11 full-file diffs against independent Git
// ---------------------------------------------------------------------------------------------

test("directory pages match git ls-tree on the current and another branch without a checkout", async () => {
  const { repository, head, side, root } = fixture.files;
  const before = await snapshotTree(repository);
  const client = await openClient("files-tree", repository);
  try {
    for (const [commit, directory] of [[head, null], [head, "src"], [head, "unicodé 目录"], [side, null], [root, null], [head, "many"]]) {
      const page = await client.listTree(commit, directory === null ? null : hex(directory));
      const expected = await gitTree(repository, commit, directory);
      assert.equal(page.total, expected.length);
      assert.equal(page.hasMore, false);
      assert.deepEqual(page.entries.map(projectTreeEntry), expected, `${directory ?? "(root)"} at ${commit.slice(0, 7)}`);
    }
    // Pages of three entries add up to the whole directory.
    const all = [];
    let offset = 0;
    for (;;) {
      const page = await client.listTree(head, hex("many"), offset, 3);
      all.push(...page.entries.map(projectTreeEntry));
      offset += page.entries.length;
      if (!page.hasMore) break;
    }
    assert.deepEqual(all, await gitTree(repository, head, "many"));
    await assert.rejects(client.listTree(head, hex("no-such-directory")), error => error.code === "MISSING_OBJECT");
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(repository), before, "browsing other versions does not check anything out");
  assert.equal(await git(repository, ["symbolic-ref", "HEAD"]), "refs/heads/main");
});

test("file contents match the blobs Git stores, including special file kinds", async () => {
  const { repository, head, root, side, invalidPathHex } = fixture.files;
  const client = await openClient("files-content", repository);
  try {
    for (const commit of [head, root, side]) {
      for (const entry of await gitTreeRecursive(repository, commit)) {
        const content = await client.fileContent(commit, entry.pathHex);
        const where = `${Buffer.from(entry.pathHex, "hex").toString("utf8")} at ${commit.slice(0, 7)}`;
        assert.equal(content.path.rawHex, entry.pathHex, where);
        if (entry.mode === "160000") { assert.equal(content.kind, "submodule", where); continue; }
        const bytes = await git(repository, ["cat-file", "blob", entry.oid], { binary: true });
        assert.equal(content.blobOid, entry.oid, where);
        assert.equal(content.size, bytes.length, where);
        if (entry.mode === "120000") {
          assert.equal(content.kind, "symlink", where);
          assert.equal(content.symlinkTarget.rawHex, bytes.toString("hex"), where);
        } else if (bytes.subarray(0, 8192).includes(0)) {
          assert.equal(content.kind, "binary", where);
        } else if (bytes.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n")) {
          assert.equal(content.kind, "lfs", where);
        } else {
          assert.equal(content.kind, "text", where);
          const lines = lineCount(bytes.toString("utf8"));
          assert.equal(content.totalLines, lines, where);
          const kept = Math.min(lines, 5000);
          assert.equal(content.lines, kept, where);
          assert.equal(content.truncated, lines > 5000, where);
          assert.equal(content.text, firstLines(bytes.toString("utf8"), kept), where);
        }
      }
    }
    const gone = await client.fileContent(head, hex("src/gone.txt"));
    assert.equal(gone.kind, "missing", "a path deleted at this version is reported missing");
    const invalid = await client.fileContent(head, invalidPathHex);
    assert.equal(invalid.text, "invalid UTF-8 path\n");
    assert.equal(invalid.path.textLossy, true);
  } finally {
    await client.stop();
  }
});

test("file and directory history match git rev-list on the literal path, page by page", async () => {
  const { repository, head, side, merge, invalidPathHex } = fixture.files;
  const client = await openClient("files-history", repository);
  try {
    const cases = [
      { commit: head, path: "src/a.txt" },
      { commit: head, path: "src/gone.txt" },
      { commit: head, path: "docs/README.md" },
      { commit: head, path: "docs/readme.md" },
      { commit: head, path: "src", kind: "directory" },
      { commit: head, path: "docs", kind: "directory" },
      { commit: side, path: "src/a.txt" },
      { commit: merge, path: "side-only.txt" },
      { commit: head, path: "src/a.txt", message: "SIDE" },
      { commit: head, path: "never-existed.txt" },
      { commit: head, pathHex: invalidPathHex },
    ];
    for (const item of cases) {
      const pathHex = item.pathHex ?? hex(item.path);
      const kind = item.kind ?? "file";
      const message = item.message ?? "";
      const where = `${item.path ?? "invalid UTF-8 path"}${message ? ` /${message}/` : ""} at ${item.commit.slice(0, 7)}`;
      const page = await client.fileHistory(item.commit, pathHex, { kind, message });
      assert.equal(page.nextCursor, null, where);
      const expected = await gitPathHistory(repository, item.commit, pathHex, kind, message);
      assert.deepEqual(page.entries.map(entry => entry.commit.oid), expected.map(entry => entry.oid), `${where}: commits`);
      for (const [index, entry] of page.entries.entries()) {
        assert.deepEqual(projectHistoryChange(entry.change), expected[index].change, `${where}: change in ${entry.commit.oid.slice(0, 7)}`);
      }
      // One entry per page walks to the same list.
      const walked = [];
      let cursor = null;
      do {
        const next = await client.fileHistory(item.commit, pathHex, { kind, message, cursor, pageSize: 1 });
        walked.push(...next.entries.map(entry => entry.commit.oid));
        cursor = next.nextCursor;
      } while (cursor);
      assert.deepEqual(walked, expected.map(entry => entry.oid), `${where}: paging`);
    }
  } finally {
    await client.stop();
  }
});

test("single changes match git diff against the chosen parent, and full-file mode rebuilds both blobs", async () => {
  const { repository, root, renamed, merge, head } = fixture.files;
  const client = await openClient("files-change", repository);
  try {
    const parents = (await git(repository, ["rev-list", "--parents", "-n1", merge])).split(" ").slice(1);
    const cases = [
      { oid: merge, parentIndex: 0, base: parents[0], path: "src/a.txt" },
      { oid: merge, parentIndex: 1, base: parents[1], path: "src/a.txt" },
      { oid: root, parentIndex: null, base: EMPTY_TREE, path: "src/a.txt" },
      { oid: head, parentIndex: 0, base: `${head}^`, path: "src/gone.txt" },
      { oid: renamed, parentIndex: 0, base: `${renamed}^`, path: "docs/README.md", oldPath: "docs/readme.md" },
      { oid: root, parentIndex: null, base: EMPTY_TREE, path: "empty.txt" },
    ];
    for (const item of cases) {
      const where = `${item.path} in ${item.oid.slice(0, 7)} against parent ${item.parentIndex}`;
      const diff = await client.fileChange(item.oid, item.parentIndex, hex(item.path), item.oldPath ? hex(item.oldPath) : null);
      const paths = item.oldPath ? [item.oldPath, item.path] : [item.path];
      const expected = await git(repository, ["diff", "-M", "--no-color", "--no-ext-diff", "--no-textconv", item.base, item.oid, "--", ...paths], { binary: true });
      assert.equal(hunks(diff.patch), hunks(expected.toString("utf8")), `${where}: hunks`);
      assert.equal(diff.truncated, false, where);

      const full = await client.fileChange(item.oid, item.parentIndex, hex(item.path), item.oldPath ? hex(item.oldPath) : null, true);
      const oldBlob = await blobAt(repository, item.base, item.oldPath ?? item.path);
      const newBlob = await blobAt(repository, item.oid, item.path);
      assertFullFile(full.patch, oldBlob, newBlob, where);
    }
    await assert.rejects(client.fileChange(root, null, hex("big.txt"), null, true), error => error.code === "RESOURCE_LIMIT", "files over 5,000 lines have no full-file mode");
    const changesOnly = await client.fileChange(root, null, hex("big.txt"));
    assert.equal(changesOnly.truncated, true, "the changes-only diff of a 6,000-line addition is cut at its line limit");
  } finally {
    await client.stop();
  }
});

test("a directory's changes in a commit match git diff on that directory against the chosen parent", async () => {
  const { repository, root, renamed, merge, head } = fixture.files;
  const client = await openClient("files-path-changes", repository);
  const letter = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", typeChanged: "T" };
  const project = file => `${letter[file.status]} ${file.oldPath?.rawHex ?? "-"} ${file.newPath?.rawHex ?? "-"}`;
  try {
    const parents = (await git(repository, ["rev-list", "--parents", "-n1", merge])).split(" ").slice(1);
    const cases = [
      { oid: head, parentIndex: 0, base: `${head}^`, directory: "src" },
      { oid: merge, parentIndex: 0, base: parents[0], directory: "src" },
      { oid: merge, parentIndex: 1, base: parents[1], directory: "" },
      { oid: renamed, parentIndex: 0, base: `${renamed}^`, directory: "docs" },
      { oid: root, parentIndex: null, base: EMPTY_TREE, directory: "many" },
      { oid: root, parentIndex: null, base: EMPTY_TREE, directory: "unicodé 目录" },
      { oid: root, parentIndex: null, base: EMPTY_TREE, directory: "" },
    ];
    for (const item of cases) {
      const where = `${item.directory || "(repository)"} in ${item.oid.slice(0, 7)} against parent ${item.parentIndex}`;
      const page = await client.listPathChanges(item.oid, item.parentIndex, item.directory ? hex(item.directory) : "");
      const scope = item.directory ? ["--", `${item.directory}/`] : [];
      const expected = parseRaw(await git(repository, ["diff", "-z", "--raw", "--no-abbrev", "-M", item.base, item.oid, ...scope], { binary: true }))
        .map(change => `${change.letter} ${change.oldPathHex ?? (change.letter === "A" ? "-" : change.pathHex)} ${change.letter === "D" ? "-" : change.pathHex}`);
      assert.deepEqual(page.files.map(project).sort(), expected.sort(), where);
      assert.equal(page.totalFiles, expected.length, where);
      assert.equal(page.hasMore, false, where);
    }
    // Pages of three add up to the whole list.
    const all = [];
    for (let offset = 0; ;) {
      const page = await client.listPathChanges(root, null, "", offset, 3);
      all.push(...page.files.map(project));
      offset += page.files.length;
      if (!page.hasMore) break;
    }
    assert.deepEqual(all, (await client.listPathChanges(root, null, "")).files.map(project));
    await assert.rejects(client.listPathChanges(root, 0, hex("src")), error => error.code === "INVALID_REQUEST", "a root commit takes no parent index");
  } finally {
    await client.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// P4-12 blame against git blame --porcelain
// ---------------------------------------------------------------------------------------------

test("blame matches git blame --porcelain across renames, merges, the root commit and many blocks", async t => {
  const blame = fixture.blame;
  const before = await snapshotTree(blame.repository);
  const client = await openClient("blame-porcelain", blame.repository);
  try {
    const cases = [
      [blame.merge, blame.newPath],
      [blame.fourth, blame.newPath],
      [blame.side, blame.newPath],
      [blame.second, blame.oldPath],
      [blame.root, blame.oldPath],
      [blame.merge, "alternating.txt"],
    ];
    for (const [commit, path] of cases) {
      const where = `${path} at ${commit.slice(0, 7)}`;
      const result = await client.blame(commit, hex(path));
      const expected = await gitBlamePorcelain(blame.repository, commit, path);
      assert.equal(result.commit, commit, where);
      assert.equal(result.path.rawHex, hex(path), where);
      assert.equal(result.totalLines, expected.lines.length, where);
      assert.deepEqual(expandBlocks(result.blocks, hex(path)), expected.lines, `${where}: every line`);
      for (const [oid, want] of expected.commits) {
        const got = result.commits.get(oid);
        assert.ok(got, `${where}: commit ${oid} described`);
        assert.deepEqual({ authorName: got.authorName, authorEmail: got.authorEmail, authorTime: got.authorTime, summary: got.summary }, want, `${where}: commit ${oid.slice(0, 7)}`);
      }
      assert.equal(result.commits.size, expected.commits.size, `${where}: no extra commits`);
      if (path === "alternating.txt") {
        assert.ok(result.chunkCount > 1, "12,000 blocks arrive in several chunks");
        t.diagnostic(`alternating.txt: ${result.blocks.length} blocks in ${result.chunkCount} chunks`);
      }
    }
    const renamedLines = expandBlocks((await client.blame(blame.merge, hex(blame.newPath))).blocks, hex(blame.newPath));
    assert.ok(renamedLines.some(line => line.pathHex === hex(blame.oldPath)), "lines from before the rename carry the old path");
    const empty = await client.blame(blame.merge, hex("empty.txt"));
    assert.equal(empty.totalLines, 0);
    assert.equal(empty.blocks.length, 0);
    assert.equal(empty.chunkCount, 1);
    assert.equal((await gitBlamePorcelain(blame.repository, blame.merge, "empty.txt")).lines.length, 0);
    await assert.rejects(client.blame(blame.merge, hex("too-many-lines.txt")), error => error.code === "RESOURCE_LIMIT");
    await assert.rejects(client.blame(blame.merge, hex("too-many-bytes.txt")), error => error.code === "RESOURCE_LIMIT");
    await assert.rejects(client.blame(blame.merge, hex("bin.dat")), error => error.code === "INVALID_REQUEST");
    await assert.rejects(client.blame(blame.merge, hex("missing.txt")), error => error.code === "MISSING_OBJECT");
  } finally {
    await client.stop();
  }
  assert.deepEqual(await snapshotTree(blame.repository), before, "blame writes nothing into the repository");
});

test("a cached blame equals the computed one and is served without running Git", { skip: !wrapper }, async () => {
  const blame = fixture.blame;
  const name = "blame-cache";
  const client = await openClient(name, blame.repository, { gate: true });
  try {
    const first = await client.blame(blame.merge, hex(blame.newPath));
    const cacheFiles = await findFiles(join(dataRoot, name), path => path.includes("blame-cache-v1"));
    assert.ok(cacheFiles.length >= 1, "the result is cached in the app data directory");
    await rm(startedPath, { force: true });
    await writeFile(gatePath, "blame");
    const second = await client.blame(blame.merge, hex(blame.newPath));
    assert.equal(await exists(startedPath), false, "the cached answer did not start git blame");
    assert.deepEqual(second.blocks, first.blocks);
    assert.deepEqual([...second.commits.entries()], [...first.commits.entries()]);
  } finally {
    await rm(gatePath, { force: true });
    await client.stop();
  }
});

// ---------------------------------------------------------------------------------------------
// Cancellation: the held Git child is killed and reaped, then the same read succeeds
// ---------------------------------------------------------------------------------------------

test("cancelled workspace, tree, content, history and blame reads reap their Git child", { skip: process.platform === "win32" || !wrapper }, async t => {
  const files = fixture.files;
  const blame = fixture.blame;
  const cases = [
    { label: "readWorkspaceStatus", repository: fixture.workspace, hold: "status", start: client => client.begin("readWorkspaceStatus", { maxEntries: 2000 }), retry: client => client.workspaceStatus() },
    { label: "listTree", repository: files.repository, hold: "ls-tree", start: client => client.begin("listTree", { commit: files.head, pathHex: null, offset: 0, limit: 500 }), retry: client => client.listTree(files.head, null) },
    { label: "readFileContent", repository: files.repository, hold: "ls-tree", start: client => client.begin("readFileContent", { commit: files.head, pathHex: hex("src/a.txt"), maxLines: 5000 }), retry: client => client.fileContent(files.head, hex("src/a.txt")) },
    { label: "readFileHistory", repository: files.repository, hold: "--grep=gatetoken", start: client => client.begin("readFileHistory", { commit: files.head, pathHex: hex("src/a.txt"), kind: "file", message: "gatetoken", cursor: null, pageSize: 200 }), retry: client => client.fileHistory(files.head, hex("src/a.txt"), { message: "gatetoken" }) },
    { label: "readBlame", repository: blame.repository, hold: "blame", start: client => client.begin("readBlame", { commit: blame.fourth, pathHex: hex(blame.newPath) }, 60_000), retry: client => client.blame(blame.fourth, hex(blame.newPath)) },
  ];
  for (const item of cases) {
    const before = await snapshotTree(item.repository);
    const client = await openClient(`cancel-${item.label}`, item.repository, { gate: true });
    try {
      await rm(startedPath, { force: true });
      await writeFile(gatePath, item.hold);
      const request = item.start(client);
      const pid = await waitForPid(startedPath, 10_000);
      const cancelledAt = performance.now();
      client.cancel(request.requestId);
      await assert.rejects(request.result, error => error.code === "CANCELLED", `${item.label}: answered CANCELLED`);
      const reapedAfter = await waitForExit(pid, 3000) - cancelledAt;
      assert.equal(await exists(gatePath), true, `${item.label}: the child ended because the daemon killed it, not because the gate opened`);
      t.diagnostic(`${item.label}: Git child ${pid} reaped ${reapedAfter.toFixed(0)} ms after cancel`);
      assert.ok(reapedAfter < 1000, `${item.label}: reaped within one second`);
      await rm(gatePath, { force: true });
      await item.retry(client);
    } finally {
      await rm(gatePath, { force: true });
      await client.stop();
    }
    assert.deepEqual(await snapshotTree(item.repository), before, `${item.label}: cancel and retry leave the repository unchanged`);
  }
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// P5-01 fetch: the one operation so far that writes to the repository
// ---------------------------------------------------------------------------------------------

const COMMIT_ENV = { GIT_AUTHOR_NAME: "Fetch Test", GIT_AUTHOR_EMAIL: "fetch@example.invalid", GIT_COMMITTER_NAME: "Fetch Test", GIT_COMMITTER_EMAIL: "fetch@example.invalid" };

/** `upstream` with main and topic, plus two clones: the daemon fetches in `local`, plain Git in `reference`. */
async function createFetchFixture(name) {
  const root = join(dataRoot, "..", `fetch-${name}`);
  const [upstream, local, reference] = ["upstream", "local", "reference"].map(part => join(root, part));
  await mkdir(upstream, { recursive: true });
  await git(upstream, ["init", "--quiet", "-b", "main"]);
  await commitFile(upstream, "a.txt", "one\n");
  await git(upstream, ["branch", "topic"]);
  for (const clone of [local, reference]) await git(root, ["clone", "--quiet", upstream, clone]);
  return { upstream, local, reference };
}

async function commitFile(repository, file, text) {
  await writeFile(join(repository, file), text);
  await git(repository, ["add", "."]);
  await git(repository, ["commit", "--quiet", "-m", file], { env: COMMIT_ENV });
}

const remoteRefs = repository => git(repository, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes"]);

/** What a fetch must leave alone. FETCH_HEAD and the remote-tracking refs are what it is for. */
async function localState(repository) {
  return {
    head: await git(repository, ["symbolic-ref", "HEAD"]),
    branches: await git(repository, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    status: await git(repository, ["status", "--porcelain=v2"]),
    index: (await readFile(join(repository, ".git", "index"))).toString("hex"),
  };
}

function fetched(response) {
  assert.equal(response.chunks.length, 1);
  const chunk = response.chunks[0];
  assert.equal(chunk.data.section, "repositoryFetched");
  assert.equal(chunk.done && chunk.coverage.complete, true);
  return chunk.data.result;
}

test("fetch matches independent git fetch and leaves HEAD, local branches, the index and the working tree alone", async () => {
  const { upstream, local, reference } = await createFetchFixture("compare");
  await commitFile(upstream, "b.txt", "two\n");
  await git(upstream, ["branch", "-D", "topic"]);
  await git(upstream, ["branch", "later"]);
  await writeFile(join(local, "dirty.txt"), "uncommitted");
  const before = await localState(local);
  const client = await openClient("fetch-compare", local);
  try {
    const result = fetched(await client.call("fetchRepository", { remote: null, prune: false }, 60_000));
    assert.deepEqual(result.remotes, ["origin"]);
    await git(reference, ["fetch", "--quiet", "--all"]);
    assert.equal(await remoteRefs(local), await remoteRefs(reference), "without prune the deleted branch stays, as with git fetch");
    assert.match(await remoteRefs(local), /refs\/remotes\/origin\/topic /u);

    fetched(await client.call("fetchRepository", { remote: "origin", prune: true }, 60_000));
    await git(reference, ["fetch", "--quiet", "--prune", "origin"]);
    assert.equal(await remoteRefs(local), await remoteRefs(reference));
    assert.doesNotMatch(await remoteRefs(local), /refs\/remotes\/origin\/topic /u);
    assert.equal(await git(local, ["rev-parse", "origin/main"]), await git(upstream, ["rev-parse", "main"]));

    // The browsing snapshot is still the one opened before the fetch; only a refresh moves it.
    const status = await client.workspaceStatus();
    assert.equal(status.entries.length, 1);
  } finally {
    await client.stop();
  }
  assert.deepEqual(await localState(local), before);
});

test("a fetch that cannot run is refused or fails without touching the repository", async () => {
  const { upstream, local } = await createFetchFixture("refuse");
  const before = await snapshotTree(local);
  const client = await openClient("fetch-refuse", local);
  try {
    for (const remote of ["elsewhere", "--upload-pack=/usr/bin/true", ""]) {
      await assert.rejects(client.call("fetchRepository", { remote, prune: false }, 60_000), error => error.code === "INVALID_REQUEST", `remote ${JSON.stringify(remote)}`);
    }
    await assert.rejects(client.call("fetchRepository", { prune: false }, 60_000), error => error.code === "INVALID_REQUEST");
    assert.deepEqual(await snapshotTree(local), before, "refused requests write nothing at all");
    await rm(upstream, { recursive: true, force: true });
    await assert.rejects(client.call("fetchRepository", { remote: null, prune: false }, 60_000), error => error.code === "GIT_ERROR" && error.message.length > "GIT_ERROR: ".length);
  } finally {
    await client.stop();
  }
  const noRemote = await openClient("fetch-no-remote", fixture.clean);
  try {
    await assert.rejects(noRemote.call("fetchRepository", { remote: null, prune: false }, 60_000), error => error.code === "INVALID_REQUEST");
  } finally {
    await noRemote.stop();
  }
});

test("a fetch in progress keeps both read slots free, refuses a second operation, and is reaped on cancel", { skip: process.platform === "win32" || !wrapper }, async t => {
  const { upstream, local } = await createFetchFixture("held");
  await commitFile(upstream, "b.txt", "two\n");
  const client = await openClient("fetch-held", local, { gate: true });
  try {
    await rm(startedPath, { force: true });
    await writeFile(gatePath, "fetch");
    const held = client.begin("fetchRepository", { remote: null, prune: false }, 60_000);
    const settled = held.result.then(() => "done", error => error.code);
    const pid = await waitForPid(startedPath, 10_000);
    await assert.rejects(client.call("fetchRepository", { remote: null, prune: false }, 60_000), error => error.code === "BUSY");
    const reads = await Promise.all([client.workspaceStatus(), client.listTree(client.session.headOid ?? await git(local, ["rev-parse", "HEAD"]), null)]);
    assert.equal(reads.length, 2, "two reads run beside the held fetch");
    const cancelledAt = performance.now();
    client.cancel(held.requestId);
    const reapedAfter = await waitForExit(pid, 3000) - cancelledAt;
    assert.equal(await settled, "CANCELLED");
    assert.equal(await exists(gatePath), true, "the child ended because the daemon stopped it, not because the gate opened");
    t.diagnostic(`fetch: Git child ${pid} reaped ${reapedAfter.toFixed(0)} ms after cancel`);
    await rm(gatePath, { force: true });
    fetched(await client.call("fetchRepository", { remote: null, prune: false }, 60_000));
    assert.equal(await git(local, ["rev-parse", "origin/main"]), await git(upstream, ["rev-parse", "main"]), "a fetch after the cancelled one works");
  } finally {
    await rm(gatePath, { force: true });
    await client.stop();
  }
});

async function openClient(name, repository, { gate = false } = {}) {
  const extra = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  if (gate) Object.assign(extra, { PATH: `${wrapper}:${process.env.PATH ?? ""}`, COMMITSCOPE_PAGES_GATE_FILE: gatePath, COMMITSCOPE_PAGES_GATE_STARTED: startedPath });
  const client = new PagesDaemonClient(daemonPath, { cwd: repository, env: createDaemonEnvironment(join(dataRoot, name), extra) });
  await client.start();
  client.session = projectSession(await client.open(repository));
  assert.ok(client.session, "openRepository returned a session");
  return client;
}

async function readAllDiffs(client, status) {
  const diffs = [];
  for (const entry of status.entries) {
    for (const side of ["staged", "unstaged"]) {
      if (!entry[side]) continue;
      const oldPathHex = side === "staged" ? entry.originalPath?.rawHex ?? null : null;
      const diff = await client.workspaceDiff(side, entry.path.rawHex, oldPathHex);
      let full = null;
      if (diff.kind === "text") full = await client.workspaceDiff(side, entry.path.rawHex, oldPathHex, true);
      diffs.push({ side, pathHex: entry.path.rawHex, oldPathHex, diff, full });
    }
  }
  return diffs;
}

async function readUntrackedPreviews(client, status) {
  const previews = [];
  for (const entry of status.entries.filter(item => item.untracked)) {
    previews.push({ pathHex: entry.path.rawHex, short: await client.workspaceFile(entry.path.rawHex, 200), long: await client.workspaceFile(entry.path.rawHex, 700) });
  }
  return previews;
}

async function expectedWorkspace(repository) {
  const entries = new Map();
  const entry = pathHex => {
    if (!entries.has(pathHex)) entries.set(pathHex, { originalPathHex: null, staged: null, unstaged: null, untracked: false, untrackedSize: null, conflict: null });
    return entries.get(pathHex);
  };
  const stages = new Map();
  for (const record of splitNul(await git(repository, ["ls-files", "-z", "-u"], { binary: true }))) {
    const tab = record.indexOf(9);
    const stage = record.subarray(0, tab).toString("utf8").split(" ")[2];
    const pathHex = record.subarray(tab + 1).toString("hex");
    stages.set(pathHex, `${stages.get(pathHex) ?? ""}${stage}`);
  }
  for (const [pathHex, set] of stages) entry(pathHex).conflict = CONFLICT[[...set].sort().join("")];

  for (const side of ["staged", "unstaged"]) {
    const flags = side === "staged" ? ["--cached", "-M"] : ["--no-renames"];
    const raw = parseRaw(await git(repository, ["diff", ...flags, "-z", "--raw", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"], { binary: true }));
    const numstat = parseNumstat(await git(repository, ["diff", ...flags, "-z", "--numstat", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"], { binary: true }));
    for (const change of raw) {
      if (stages.has(change.pathHex) || change.letter === "U") continue;
      const counts = numstat.get(change.pathHex);
      const target = entry(change.pathHex);
      if (change.oldPathHex) target.originalPathHex = change.oldPathHex;
      target[side] = {
        status: STATUS[change.letter],
        additions: counts.binary ? null : counts.additions,
        deletions: counts.binary ? null : counts.deletions,
        binary: counts.binary,
        gitlink: change.oldMode === "160000" || change.newMode === "160000",
      };
    }
  }
  for (const path of splitNul(await git(repository, ["ls-files", "-z", "--others", "--exclude-standard"], { binary: true }))) {
    const target = entry(path.toString("hex"));
    target.untracked = true;
    target.untrackedSize = (await lstat(join(repository, path.toString("utf8")))).size;
  }
  let headReference = null;
  try { headReference = await git(repository, ["symbolic-ref", "-q", "HEAD"]); } catch {}
  let headOid = null;
  try { headOid = await git(repository, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]); } catch {}
  let operation = "none";
  try { await git(repository, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]); operation = "merge"; } catch {}
  return { entries, headReference, headOid, operation };
}

async function compareDiffs(repository, diffs) {
  for (const { side, pathHex, oldPathHex, diff, full } of diffs) {
    const path = Buffer.from(pathHex, "hex").toString("utf8");
    const oldPath = oldPathHex ? Buffer.from(oldPathHex, "hex").toString("utf8") : null;
    const where = `${side} ${path}`;
    const paths = oldPath ? [oldPath, path] : [path];
    const flags = side === "staged" ? ["--cached", "-M"] : ["--no-renames"];
    const expected = await git(repository, ["diff", ...flags, "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--", ...paths], { binary: true });
    const sizes = await workspaceSizes(repository, side, path, oldPath);
    assert.equal(diff.oldSize, sizes.old, `${where}: old size`);
    assert.equal(diff.newSize, sizes.new, `${where}: new size`);
    if (diff.kind === "text" || diff.kind === "gitlink") assert.equal(hunks(diff.patch), hunks(expected.toString("utf8")), `${where}: hunks`);
    if (full) {
      const [oldBlob, newBlob] = await workspaceSides(repository, side, path, oldPath);
      assertFullFile(full.patch, oldBlob, newBlob, `${where} (full file)`);
    }
  }
}

async function comparePreviews(repository, previews) {
  for (const { pathHex, short, long } of previews) {
    const path = Buffer.from(pathHex, "hex").toString("utf8");
    const metadata = await lstat(join(repository, path));
    assert.equal(short.size, metadata.size, `${path}: size`);
    if (short.kind !== "text") continue;
    const text = (await readFile(join(repository, path))).toString("utf8");
    const lines = lineCount(text);
    assert.equal(short.lines, Math.min(lines, 200), `${path}: first page lines`);
    assert.equal(short.truncated, lines > 200, `${path}: first page truncated`);
    assert.equal(short.text, firstLines(text, Math.min(lines, 200)), `${path}: first page text`);
    assert.equal(long.text, firstLines(text, Math.min(lines, 700)), `${path}: longer page text`);
    assert.equal(long.truncated, lines > 700, `${path}: longer page truncated`);
  }
}

async function workspaceSizes(repository, side, path, oldPath) {
  const objectSize = async spec => {
    try { return Number(await git(repository, ["cat-file", "-s", spec])); } catch { return null; }
  };
  if (side === "staged") return { old: await objectSize(`HEAD:${oldPath ?? path}`), new: await objectSize(`:${path}`) };
  let size = null;
  try { size = (await lstat(join(repository, path))).size; } catch {}
  return { old: await objectSize(`:${path}`), new: size };
}

async function workspaceSides(repository, side, path, oldPath) {
  const blob = async spec => {
    try { return (await git(repository, ["cat-file", "blob", spec], { binary: true })).toString("utf8"); } catch { return ""; }
  };
  if (side === "staged") return [await blob(`HEAD:${oldPath ?? path}`), await blob(`:${path}`)];
  let worktree = "";
  try { worktree = (await readFile(join(repository, path))).toString("utf8"); } catch {}
  return [await blob(`:${path}`), worktree];
}

async function blobAt(repository, commit, path) {
  if (commit === EMPTY_TREE) return "";
  try { return (await git(repository, ["cat-file", "blob", `${commit}:${path}`], { binary: true })).toString("utf8"); } catch { return ""; }
}

/** Full-file patches rebuild both blobs exactly, with one hunk whose header counts every line. */
function assertFullFile(patch, oldBlob, newBlob, where) {
  const rebuilt = rebuild(patch);
  if (oldBlob === newBlob) {
    assert.equal(rebuilt.headers.length, 0, `${where}: no hunk when nothing changed`);
    return;
  }
  assert.equal(rebuilt.old, oldBlob, `${where}: old side equals the old blob`);
  assert.equal(rebuilt.new, newBlob, `${where}: new side equals the new blob`);
  assert.equal(rebuilt.headers.length, 1, `${where}: one hunk covers the file`);
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rebuilt.headers[0]);
  const oldLines = lineCount(oldBlob);
  const newLines = lineCount(newBlob);
  assert.equal(Number(match[1]), oldLines ? 1 : 0, `${where}: old start line`);
  assert.equal(Number(match[2] ?? 1), oldLines, `${where}: old line count`);
  assert.equal(Number(match[3]), newLines ? 1 : 0, `${where}: new start line`);
  assert.equal(Number(match[4] ?? 1), newLines, `${where}: new line count`);
}

function rebuild(patch) {
  const body = hunks(patch);
  const oldSide = []; const newSide = []; const headers = [];
  let last = null;
  for (const line of body.split("\n").slice(0, -1)) {
    if (line.startsWith("@@")) { headers.push(line); continue; }
    const tag = line[0];
    const text = `${line.slice(1)}\n`;
    if (tag === "\\") {
      if (last === " " || last === "-") oldSide[oldSide.length - 1] = oldSide.at(-1).slice(0, -1);
      if (last === " " || last === "+") newSide[newSide.length - 1] = newSide.at(-1).slice(0, -1);
      continue;
    }
    if (tag === " " || tag === "-") oldSide.push(text);
    if (tag === " " || tag === "+") newSide.push(text);
    last = tag;
  }
  return { old: oldSide.join(""), new: newSide.join(""), headers };
}

function hunks(patch) {
  if (patch.startsWith("@@")) return patch;
  const index = patch.indexOf("\n@@");
  return index < 0 ? "" : patch.slice(index + 1);
}

function lineCount(text) {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function firstLines(text, count) {
  if (count === 0) return "";
  let index = -1;
  for (let line = 0; line < count; line += 1) {
    index = text.indexOf("\n", index + 1);
    if (index < 0) return text;
  }
  return text.slice(0, index + 1);
}

async function gitTree(repository, commit, directory) {
  const args = ["ls-tree", "-z", "--long", commit];
  if (directory !== null) args.push("--", `${directory}/`);
  const entries = splitNul(await git(repository, args, { binary: true })).map(record => {
    const tab = record.indexOf(9);
    const [mode, type, oid, size] = record.subarray(0, tab).toString("utf8").trim().split(/\s+/);
    const path = record.subarray(tab + 1);
    const slash = path.lastIndexOf(0x2f);
    const kind = type === "tree" ? "directory" : type === "commit" ? "submodule" : mode === "120000" ? "symlink" : "file";
    return { nameHex: path.subarray(slash + 1).toString("hex"), pathHex: path.toString("hex"), kind, mode, oid, size: size === "-" ? null : Number(size) };
  });
  return entries.sort((left, right) => (left.kind !== "directory") - (right.kind !== "directory") || Buffer.compare(Buffer.from(left.nameHex, "hex"), Buffer.from(right.nameHex, "hex")));
}

async function gitTreeRecursive(repository, commit) {
  return splitNul(await git(repository, ["ls-tree", "-r", "-z", commit], { binary: true })).map(record => {
    const tab = record.indexOf(9);
    const [mode, , oid] = record.subarray(0, tab).toString("utf8").split(" ");
    return { mode, oid, pathHex: record.subarray(tab + 1).toString("hex") };
  });
}

function projectTreeEntry(entry) {
  return { nameHex: entry.name.rawHex, pathHex: entry.path.rawHex, kind: entry.kind, mode: entry.mode, oid: entry.oid, size: entry.size };
}

/** Literal-path history from rev-list, with each change described against the first parent. */
async function gitPathHistory(repository, commit, pathHex, kind, message) {
  const path = Buffer.from(pathHex, "hex");
  const pathspec = kind === "directory" ? `${path.toString("utf8")}/` : path;
  const grep = message ? ["--regexp-ignore-case", "--fixed-strings", `--grep=${message}`] : [];
  // A non-UTF-8 pathspec cannot travel as a process argument, so that case reads the list via stdin.
  const listed = Buffer.isBuffer(pathspec)
    ? await git(repository, ["rev-list", ...grep, commit, "--stdin"], { input: Buffer.concat([Buffer.from("--\n"), pathspec, Buffer.from("\n")]) })
    : await git(repository, ["rev-list", ...grep, commit, "--", pathspec]);
  const oids = listed.split("\n").filter(Boolean);
  const result = [];
  for (const oid of oids) {
    const parent = (await git(repository, ["rev-list", "--parents", "-n1", oid])).split(" ")[1] ?? EMPTY_TREE;
    const scope = Buffer.isBuffer(pathspec) ? [] : ["--", pathspec];
    const raw = parseRaw(await git(repository, ["diff", "-z", "--raw", "--no-abbrev", "--no-renames", parent, oid, ...scope], { binary: true }))
      .filter(change => kind === "directory" ? change.pathHex.startsWith(hex(`${path.toString("utf8")}/`)) : change.pathHex === pathHex);
    const numstat = parseNumstat(await git(repository, ["diff", "-z", "--numstat", "--no-renames", parent, oid, ...scope], { binary: true }));
    const counts = raw.map(change => numstat.get(change.pathHex));
    const binary = counts.some(item => item.binary);
    let status;
    if (kind === "file") status = STATUS[raw[0]?.letter ?? "M"];
    else if (raw.length && raw.every(change => change.letter === "A")) status = "added";
    else if (raw.length && raw.every(change => change.letter === "D")) status = "deleted";
    else status = "modified";
    let oldPathHex = null;
    if (kind === "file" && status === "added" && parent !== EMPTY_TREE) {
      const renamed = parseRaw(await git(repository, ["diff", "-z", "--raw", "--no-abbrev", "-M", parent, oid], { binary: true }))
        .find(change => change.letter === "R" && change.pathHex === pathHex);
      if (renamed) { status = "renamed"; oldPathHex = renamed.oldPathHex; }
    }
    result.push({
      oid,
      change: {
        status,
        oldPathHex,
        additions: binary ? null : counts.reduce((sum, item) => sum + item.additions, 0),
        deletions: binary ? null : counts.reduce((sum, item) => sum + item.deletions, 0),
        binary,
        files: Math.max(raw.length, 1),
      },
    });
  }
  return result;
}

function projectHistoryChange(change) {
  return { status: change.status, oldPathHex: change.oldPath?.rawHex ?? null, additions: change.additions, deletions: change.deletions, binary: change.binary, files: change.files };
}

async function gitBlamePorcelain(repository, commit, path) {
  const output = await git(repository, ["blame", "--porcelain", "--no-textconv", commit, "--", path], { binary: true });
  const lines = [];
  const commits = new Map();
  const commitPath = new Map();
  const records = output.toString("utf8").split("\n");
  let index = 0;
  while (index < records.length && records[index]) {
    const [oid, original, final] = records[index++].split(" ");
    const details = {};
    let filename = null;
    while (!records[index].startsWith("\t")) {
      const line = records[index++];
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "filename") filename = unquote(value);
      else details[key] = value;
    }
    index += 1;
    if (details.author !== undefined) {
      commits.set(oid, { authorName: details.author, authorEmail: details["author-mail"].replace(/^<|>$/g, ""), authorTime: Number(details["author-time"]), summary: details.summary });
    }
    if (filename) commitPath.set(oid, filename);
    lines[Number(final) - 1] = { oid, originalLine: Number(original), pathHex: commitPath.get(oid).toString("hex") };
  }
  return { lines, commits };
}

function expandBlocks(blocks, requestedPathHex) {
  const lines = [];
  for (const block of blocks) {
    for (let offset = 0; offset < block.lineCount; offset += 1) {
      lines[block.startLine - 1 + offset] = { oid: block.oid, originalLine: block.originalStartLine + offset, pathHex: block.originalPath?.rawHex ?? requestedPathHex };
    }
  }
  return lines;
}

/** Git's C-style path quoting, as printed after "filename" in porcelain output. */
function unquote(value) {
  if (!value.startsWith("\"")) return Buffer.from(value, "utf8");
  const bytes = [];
  const source = Buffer.from(value.slice(1, -1), "utf8");
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "\"": 34 };
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== 92) { bytes.push(source[index]); continue; }
    const next = String.fromCharCode(source[index + 1]);
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(source.subarray(index + 1, index + 4).toString("latin1"), 8));
      index += 3;
    } else {
      bytes.push(escapes[next]);
      index += 1;
    }
  }
  return Buffer.from(bytes);
}

function parseRaw(buffer) {
  const tokens = splitNul(buffer);
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    const [oldMode, newMode, , , status] = tokens[index++].toString("utf8").slice(1).split(" ");
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const oldPathHex = tokens[index++].toString("hex");
      changes.push({ letter, oldMode, newMode, oldPathHex, pathHex: tokens[index++].toString("hex") });
    } else {
      changes.push({ letter, oldMode, newMode, oldPathHex: null, pathHex: tokens[index++].toString("hex") });
    }
  }
  return changes;
}

function parseNumstat(buffer) {
  const tokens = splitNul(buffer);
  const result = new Map();
  for (let index = 0; index < tokens.length;) {
    const [added, deleted, path] = tokens[index++].toString("latin1").split("\t");
    let pathHex;
    if (path === "") { index += 1; pathHex = tokens[index++].toString("hex"); }
    else pathHex = Buffer.from(path, "latin1").toString("hex");
    result.set(pathHex, { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted), binary: added === "-" });
  }
  return result;
}

function splitNul(buffer) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    parts.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

async function findFiles(root, predicate) {
  const found = [];
  async function visit(directory) {
    let names;
    try { names = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const item of names) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await visit(path);
      else if (predicate(path)) found.push(path);
    }
  }
  await visit(root);
  return found;
}

async function waitForPid(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = (await readFile(path, "utf8")).trim();
      if (text) return Number(text);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10);
  }
  throw new Error("Timed out waiting for the held Git command");
}

/** Resolves when the process no longer exists; a zombie still answers signal 0, so this also proves it was reaped. */
async function waitForExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return performance.now(); throw error; }
    await delay(5);
  }
  throw new Error(`Git child ${pid} was still present ${timeoutMs} ms after cancel`);
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// M5 fixed-template operation contracts and refusal snapshots.
await import('./operations-git.test.mjs');
await import('./stats-git.test.mjs');
