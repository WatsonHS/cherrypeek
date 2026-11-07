import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/** Build a compact, independent Git oracle fixture for commit details and parent-relative changes. */
export async function createDetailsFixture(root, { sha256: includeSha256 = true } = {}) {
  await mkdir(root, { recursive: true });
  const repository = join(root, "detail fixture with spaces\nrepository");
  await git(root, ["init", "--quiet", "--initial-branch=main", repository]);

  const rawPath = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const rawPath2 = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xfe, 0x2e, 0x74, 0x78, 0x74]);
  const rootEntries = [
    await blobEntry(repository, "base.txt", "root base\n"),
    await blobEntry(repository, "delete-me.txt", "remove on main\n"),
    await blobEntry(repository, "rename-old.txt", "rename unchanged\n"),
    await blobEntry(repository, "type-change", "regular blob\n"),
    await blobEntry(repository, "unicodé/起点.txt", "路径\n"),
    await blobEntry(repository, "line\nbreak.txt", "newline in path\n"),
    await blobEntry(repository, "binary.dat", Buffer.from([0, 1, 2, 255, 0x41])),
    await blobEntry(repository, ".gitattributes", "attr-probe.txt !diff\nspecial.txt !binary\n"),
    await blobEntry(repository, "special.txt", "text that Git attributes mark binary\n"),
    await blobEntry(repository, "attr-probe.txt", "text whose captured diff driver marks it binary\n"),
    await blobEntry(repository, "nested/root.txt", "root directory\n"),
    { mode: "100644", oid: await hashBlob(repository, "non UTF-8 path\n"), rawPath },
    { mode: "100644", oid: await hashBlob(repository, "second invalid UTF-8 path\n"), rawPath: rawPath2 },
    await blobEntry(repository, " spaced\tpath ", "path with outer spaces and a tab\n"),
    await blobEntry(repository, "--option-looking", "path starts with hyphens\n"),
  ];
  const rootCommit = await commit(repository, "root", rootEntries, [], {
    author: ["Root Author", "root@example.invalid", 1_700_000_000, "+0130"],
    committer: ["Root Committer", "root-committer@example.invalid", 1_700_000_010, "-0430"],
    message: "Root detail fixture\n\nRoot body with Unicode: 根提交\n",
  });

  const mainEntries = replaceEntries(rootEntries, [
    await blobEntry(repository, "base.txt", "main edited the base\n"),
    await blobEntry(repository, "rename-new/renamed.txt", "rename unchanged\n"),
    await symlinkEntry(repository, "type-change", "target.txt"),
    await blobEntry(repository, "main-added.txt", "added on first parent\n"),
    await blobEntry(repository, "special.txt", "changed text, still binary by captured attributes\n"),
    await blobEntry(repository, "attr-probe.txt", "changed text for the captured diff driver\n"),
    await blobEntry(repository, ".gitattributes", "*.txt diff=poison\nspecial.txt binary\n"),
    { mode: "100644", oid: await hashBlob(repository, "changed non UTF-8 path\n"), rawPath },
    { mode: "100644", oid: await hashBlob(repository, "changed second invalid UTF-8 path\n"), rawPath: rawPath2 },
    await blobEntry(repository, " spaced\tpath ", "changed path with outer spaces and a tab\n"),
    await blobEntry(repository, "--option-looking", "changed option-looking path\n"),
  ], ["delete-me.txt", "rename-old.txt", "type-change"]);
  const mainCommit = await commit(repository, "refs/heads/main", mainEntries, [rootCommit], {
    author: ["Main Author", "main@example.invalid", 1_700_001_000, "+0845"],
    committer: ["Main Committer", "main-committer@example.invalid", 1_700_001_030, "-0330"],
    message: "Main-side change\n\nThis commit moves and removes paths.\n",
  });

  const sideEntries = replaceEntries(rootEntries, [
    await blobEntry(repository, "base.txt", "side edited the base\n"),
    await blobEntry(repository, "side-only/侧面.txt", "side addition\n"),
    { mode: "160000", oid: await makeSubmoduleCommit(root), path: "vendor/module" },
  ], ["base.txt"]);
  const sideCommit = await commit(repository, "refs/heads/side", sideEntries, [rootCommit], {
    author: ["Side Author", "side@example.invalid", 1_700_001_100, "+0530"],
    committer: ["Side Committer", "side-committer@example.invalid", 1_700_001_200, "+0000"],
    message: "Side-parent changes\n\nAdds a gitlink and a Unicode path.\n",
  });

  const mergeEntries = replaceEntries(mainEntries, [
    await blobEntry(repository, "base.txt", "resolved both sides\n"),
    await blobEntry(repository, "side-only/侧面.txt", "side addition\n"),
    { mode: "160000", oid: await makeSubmoduleCommit(root), path: "vendor/module" },
    await blobEntry(repository, "line\nbreak-added.txt", "added by merge\n"),
    await blobEntry(repository, "binary.dat", Buffer.from([0, 0xff, 0x00, 0x10, 0x42])),
  ], ["base.txt"]);
  const mergeCommit = await commit(repository, "refs/heads/main", mergeEntries, [mainCommit, sideCommit], {
    author: ["Merge Author", "merge@example.invalid", 1_700_002_000, "+0000"],
    committer: ["Merge Committer", "merge-committer@example.invalid", 1_700_002_100, "+0000"],
    message: "Merge side into main\n\nThe middle paragraph contains a trailer lookalike:\nReviewed-by: Body Text <body@example.invalid>\n\nThis is still body text.\n\nReviewed-by: Ada Reviewer <ada@example.invalid>\nCo-authored-by: Lin Author <lin@example.invalid>\n continuation line\nReviewed-by: Ada Reviewer <ada@example.invalid>\n",
  });

  const topicA = await createTopicChain(repository, mergeCommit, 205);
  const topicBEntries = replaceEntries(mergeEntries, [await blobEntry(repository, "topic-b.txt", "topic B\n")]);
  const topicB = await commit(repository, "refs/heads/topic/b", topicBEntries, [mergeCommit], {
    author: ["Octopus Author B", "octo-b@example.invalid", 1_700_003_100, "+0000"],
    committer: ["Octopus Committer", "octo-b-committer@example.invalid", 1_700_003_110, "+0000"],
    message: "Octopus topic B\n",
  });
  const octopusEntries = replaceEntries(mergeEntries, [
    await blobEntry(repository, "topic-a.txt", "topic A\n"),
    await blobEntry(repository, "topic-b.txt", "topic B\n"),
  ]);
  const octopusCommit = await commit(repository, "refs/heads/main", octopusEntries, [mergeCommit, topicA, topicB], {
    author: ["Octopus Release", "release@example.invalid", 1_700_004_000, "+0000"],
    committer: ["Release Bot", "release-bot@example.invalid", 1_700_004_020, "+0000"],
    message: "Octopus release\n\nThree-parent group fixture.\n",
  });

  const wideEntries = replaceEntries(octopusEntries, await manyBlobEntries(repository, "wide", 205));
  const wideFiles = await commit(repository, "refs/heads/main", wideEntries, [octopusCommit], {
    author: ["Wide Files Author", "wide@example.invalid", 1_700_004_500, "+0000"],
    committer: ["Wide Files Committer", "wide-committer@example.invalid", 1_700_004_510, "+0000"],
    message: "Commit with more than one file page\n",
  });
  const headEntries = replaceEntries(wideEntries, [await blobEntry(repository, ".gitattributes", "attr-probe.txt !diff\nspecial.txt !binary\n")]);
  const head = await commit(repository, "refs/heads/main", headEntries, [wideFiles], {
    author: ["Head Follow-up Author", "head-followup@example.invalid", 1_700_004_600, "+0000"],
    committer: ["Head Follow-up Committer", "head-followup-committer@example.invalid", 1_700_004_610, "+0000"],
    message: "Change worktree attribute source after target commit\n",
  });

  const unrelated = await commit(repository, "refs/heads/unrelated", rootEntries, [], {
    author: ["Unrelated Author", "unrelated@example.invalid", 1_700_005_000, "+0000"],
    committer: ["Unrelated Committer", "unrelated-committer@example.invalid", 1_700_005_000, "+0000"],
    message: "Independent root for contains checks\n",
  });
  const resourceLimit = await commit(repository, "refs/heads/resource-limit", [await blobEntry(repository, "resource.txt", "resource-boundary\n")], [rootCommit], {
    author: ["Resource Author", "resource@example.invalid", 1_700_005_100, "+0000"],
    committer: ["Resource Committer", "resource-committer@example.invalid", 1_700_005_100, "+0000"],
    message: `Resource boundary\n\n${"x".repeat(600 * 1024)}\n`,
  });
  await git(repository, ["update-ref", "refs/remotes/origin/main", octopusCommit]);
  await git(repository, ["update-ref", "refs/remotes/origin/side", sideCommit]);
  await git(repository, ["update-ref", "refs/tags/detail-merge", mergeCommit]);
  await git(repository, ["tag", "-a", "detail-annotated", "-m", "annotated detail tag", mergeCommit], { env: {
    GIT_COMMITTER_NAME: "Fixture Tagger", GIT_COMMITTER_EMAIL: "tagger@example.invalid", GIT_COMMITTER_DATE: "@1700000060 +0000",
  } });

  const sentinel = join(root, "trailer-command-was-run.txt");
  const externalSentinel = join(root, "external-diff-command-was-run.txt");
  const sentinelScript = join(root, "git-command-sentinel.sh");
  await writeFile(sentinelScript, `#!/bin/sh\nprintf invoked >> '${externalSentinel.replaceAll("'", "'\\''")} '\ncat\n`);
  await chmod(sentinelScript, 0o700);
  await git(repository, ["config", "diff.poison.command", sentinelScript]);
  await git(repository, ["config", "diff.poison.textconv", sentinelScript]);
  await git(repository, ["config", "diff.poison.binary", "true"]);
  await git(repository, ["config", "trailer.reviewed-by.command", `printf invoked > '${sentinel.replaceAll("'", "'\\''")}'`]);
  await git(repository, ["config", "trailer.reviewed-by.cmd", `printf invoked > '${sentinel.replaceAll("'", "'\\''")}'`]);
  await git(repository, ["config", "trailer.separators", "="]);
  await writeFile(join(repository, ".gitattributes"), "special.txt !binary\nattr-probe.txt !diff\n*.txt !diff\n");
  await git(repository, ["config", "trailer.reviewed-by.ifexists", "doNothing"]);

  let sha256 = null;
  const sha256Repository = join(root, "detail sha256");
  if (includeSha256) {
    try {
      await git(root, ["init", "--quiet", "--initial-branch=main", "--object-format=sha256", sha256Repository]);
    } catch (error) {
      if (!/object-format|sha256|unsupported|unknown option/i.test(`${error.message}\n${error.stderr ?? ""}`)) throw error;
    }
  }
  if (includeSha256 && await isGitRepository(sha256Repository)) {
    const shaOid = await commit(sha256Repository, "refs/heads/main", [await blobEntry(sha256Repository, "sha.txt", "sha256 detail\n")], [], {
      author: ["SHA Author", "sha@example.invalid", 1_700_006_000, "+0000"],
      committer: ["SHA Committer", "sha-committer@example.invalid", 1_700_006_001, "+0000"],
      message: "SHA-256 detail OID\n",
    });
    sha256 = { repository: await realpath(sha256Repository), oid: shaOid };
  }

  return {
    repository: await realpath(repository),
    root: rootCommit,
    main: mainCommit,
    side: sideCommit,
    merge: mergeCommit,
    topicA,
    topicACommitCount: 205,
    topicB,
    octopus: octopusCommit,
    wideFiles,
    head,
    unrelated,
    resourceLimit,
    rawPathHex: rawPath.toString("hex"),
    rawPath2Hex: rawPath2.toString("hex"),
    trailerMessage: "Merge side into main\n\nThe middle paragraph contains a trailer lookalike:\nReviewed-by: Body Text <body@example.invalid>\n\nThis is still body text.\n\nReviewed-by: Ada Reviewer <ada@example.invalid>\nCo-authored-by: Lin Author <lin@example.invalid>\n continuation line\nReviewed-by: Ada Reviewer <ada@example.invalid>\n",
    trailerSentinel: sentinel,
    externalSentinel,
    sha256,
  };
}

export async function git(repository, args, { binary = false, env: extraEnv = {}, input } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  const fullArgs = ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", repository, ...args];
  const commandEnv = { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", ...extraEnv };
  if (input !== undefined) {
    const output = await runGitInput(fullArgs, input, commandEnv);
    return binary ? output : output.toString("utf8").trimEnd();
  }
  const result = await execFileAsync("git", fullArgs, { encoding: binary ? "buffer" : "utf8", maxBuffer: 32 * 1024 * 1024, env: commandEnv });
  return binary ? result.stdout : result.stdout.trimEnd();
}

async function hashBlob(repository, contents) {
  const input = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return (await runGitInput(["-C", repository, "hash-object", "-w", "--stdin"], input, cleanGitEnvironment())).toString("utf8").trim();
}

async function blobEntry(repository, path, content) {
  return { mode: "100644", oid: await hashBlob(repository, content), path };
}

async function manyBlobEntries(repository, directory, count) {
  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    entries.push(await blobEntry(repository, `${directory}/${String(index).padStart(3, "0")}.txt`, `${directory} file ${index}\n`));
  }
  return entries;
}

async function symlinkEntry(repository, path, target) {
  return { mode: "120000", oid: await hashBlob(repository, target), path };
}

async function makeSubmoduleCommit(root) {
  const repository = join(root, "submodule source");
  try { await git(root, ["init", "--quiet", "--initial-branch=main", repository]); }
  catch (error) { if (!/already exists|exist/i.test(error.message)) throw error; }
  const entry = await blobEntry(repository, "module.txt", "submodule\n");
  return commit(repository, "refs/heads/main", [entry], [], {
    author: ["Submodule Author", "submodule@example.invalid", 1_700_000_500, "+0000"],
    committer: ["Submodule Committer", "submodule-committer@example.invalid", 1_700_000_501, "+0000"],
    message: "Submodule commit\n",
  });
}

function replaceEntries(base, replacements = [], removals = []) {
  const removed = new Set(removals);
  const next = new Map(base.filter(entry => !removed.has(entry.path)).map(entry => [entry.path ?? entry.rawPath.toString("hex"), entry]));
  for (const entry of replacements) next.set(entry.path ?? entry.rawPath.toString("hex"), entry);
  return [...next.values()];
}

async function commit(repository, ref, entries, parents, { author, committer, message }) {
  const tree = await writeTree(repository, entries);
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  const output = await runGitInput(["-C", repository, ...args], Buffer.from(message, "utf8"), {
    ...cleanGitEnvironment(),
    GIT_AUTHOR_NAME: author[0], GIT_AUTHOR_EMAIL: author[1], GIT_AUTHOR_DATE: `@${author[2]} ${author[3]}`,
    GIT_COMMITTER_NAME: committer[0], GIT_COMMITTER_EMAIL: committer[1], GIT_COMMITTER_DATE: `@${committer[2]} ${committer[3]}`,
  });
  const oid = output.toString("utf8").trim();
  await git(repository, ["update-ref", ref, oid]);
  return oid;
}

async function createTopicChain(repository, baseOid, count) {
  const content = "topic A\n";
  const blobOid = await hashBlob(repository, content);
  let mark = 1;
  const stream = [];
  for (let index = 1; index <= count; index += 1) {
    const authorName = index % 2 === 0 ? "Octopus Author Shared" : "Octopus Author A";
    const authorEmail = index % 2 === 0 ? "octo-shared@example.invalid" : "octo-a@example.invalid";
    const message = `Octopus topic A ${String(index).padStart(3, "0")}`;
    stream.push(
      `commit refs/heads/topic/a\nmark :${mark}\nauthor ${authorName} <${authorEmail}> ${1_700_003_000 + index} +0000\ncommitter Octopus Committer <octo-committer@example.invalid> ${1_700_003_500 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${index === 1 ? baseOid : `:${mark - 1}`}\n`,
    );
    if (index === 1) stream.push(`M 100644 ${blobOid} topic-a.txt\n`);
    stream.push("\n");
    mark += 1;
  }
  stream.push("done\n");
  await runFastImport(repository, stream.join(""));
  return await git(repository, ["rev-parse", "refs/heads/topic/a"]);
}

async function writeTree(repository, entries) {
  const indexPath = join(repository, `.git`, `index.details-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    await git(repository, ["read-tree", "--empty"], { env });
    const records = [];
    for (const entry of entries) {
      const prefix = Buffer.from(`${entry.mode} ${entry.oid} 0\t`);
      const path = entry.rawPath ?? Buffer.from(entry.path, "utf8");
      records.push(prefix, path, Buffer.from([0]));
    }
    await git(repository, ["update-index", "-z", "--index-info"], { env, input: Buffer.concat(records) });
    return await git(repository, ["write-tree"], { env });
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(indexPath, { force: true }));
  }
}

async function isGitRepository(repository) {
  try { await git(repository, ["rev-parse", "--git-dir"]); return true; }
  catch (error) { if (error.code === "ENOENT" || /not a git repository/i.test(error.stderr ?? error.message)) return false; throw error; }
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

function runGitInput(args, input, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code !== 0) rejectRun(new Error(`git ${args.join(" ")} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`));
      else resolveRun(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function runFastImport(repository, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", repository, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fast-import", "--quiet"], {
      env: cleanGitEnvironment(), stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
    });
    const stderr = [];
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code !== 0) rejectRun(new Error(`git fast-import failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`));
      else resolveRun();
    });
    child.stdin.end(input);
  });
}
