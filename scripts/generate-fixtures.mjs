#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";
import { mkdir, readdir, rm, stat, writeFile, lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const VERSION = 1;
const DEFAULT_SEED = 20261107;
const MAX_BUFFER = 16 * 1024 * 1024;
const args = parseArgs(process.argv.slice(2));
let output = resolve(args.output);
const seed = args.seed;

let outputCreated = false;
try {
  await ensureSafeOutput(output);
  await mkdir(output, { recursive: true });
  output = await realpath(output);
  outputCreated = true;
  const gitVersion = (await git(["--version"])).trim();
  const capabilities = await probeCapabilities(output);
  const manifest = {
    schemaVersion: 1,
    generatorVersion: VERSION,
    seed,
    gitVersion,
    large: args.large,
    fixtures: {},
  };

  await makeEmpty(join(output, "empty"));
  manifest.fixtures.empty = await describeRepository(output, "empty", "unborn HEAD and zero commits");

  await makeTopology(join(output, "topology"), seed);
  manifest.fixtures.topology = await describeRepository(output, "topology", "root, branch, merge, octopus, identities, Unicode and untrusted text");
  manifest.fixtures.subdirectory = await describeRepository(output, "topology/nested/deep", "open an ordinary repository from a nested subdirectory");

  const boundaryExpected = await makeBoundary(join(output, "boundary"));
  manifest.fixtures.boundary = await describeRepository(output, "boundary", "NUL message, invalid UTF-8 message, and UTF-8-safe 4 KiB summary truncation", { providedExpectedCommits: boundaryExpected });

  await makeDetached(join(output, "detached"), join(output, "topology"));
  manifest.fixtures.detached = await describeRepository(output, "detached", "detached HEAD at the topology merge commit");

  const unusualPath = "path with spaces/中文\nrepository";
  await makeDetached(join(output, unusualPath), join(output, "topology"));
  manifest.fixtures.unusualPath = await describeRepository(output, unusualPath, "path containing spaces, Unicode and a newline");

  await git(["clone", "--quiet", "--bare", "--no-hardlinks", join(output, "topology"), join(output, "bare")]);
  manifest.fixtures.bare = await describeRepository(output, "bare", "bare clone of topology");

  await git(["-C", join(output, "topology"), "worktree", "add", "--quiet", join(output, "linked-worktree"), "side"]);
  manifest.fixtures.linkedWorktree = await describeRepository(output, "linked-worktree", "linked worktree sharing topology commonDir");

  await makeShallow(join(output, "shallow"), join(output, "topology"));
  manifest.fixtures.shallow = await describeRepository(output, "shallow", "depth two clone of topology");

  if (capabilities.sha256) {
    await makeSha256(join(output, "sha256"));
    manifest.fixtures.sha256 = await describeRepository(output, "sha256", "native SHA-256 object format");
    manifest.fixtures.sha256.supported = true;
  } else {
    manifest.fixtures.sha256 = { path: "sha256", purpose: "native SHA-256 object format", supported: false, reason: "Installed Git rejected --object-format=sha256" };
  }

  await makeMissingPromisor(join(output, "missing-promisor"));
  manifest.fixtures.missingPromisor = await describeRepository(output, "missing-promisor", "missing promisor commit with an unreachable remote helper sentinel", { expectMissing: true });
  manifest.fixtures.missingPromisor.expectedError = "MISSING_OBJECT";
  manifest.fixtures.missingPromisor.fetchSentinel = "fetch-attempts.txt";

  if (args.large) {
    await makeLarge(join(output, "large"), seed);
    manifest.fixtures.large = await describeRepository(output, "large", "exactly 100000 commits in a fixed linear history", { large: true });
    manifest.fixtures.large.commitCount = 100000;
    manifest.fixtures.large.generation = { strategy: "streaming git fast-import", topology: "linear", generatedCommitInvocations: 0 };
  }

  manifest.capabilities = capabilities;
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ output, seed, large: args.large, fixtures: Object.keys(manifest.fixtures) }, null, 2)}\n`);
} catch (error) {
  if (outputCreated && args.cleanupOnFailure) await rm(output, { recursive: true, force: true }).catch(() => {});
  process.stderr.write(`Fixture generation failed: ${error.message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  let output;
  let large = false;
  let seed = DEFAULT_SEED;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--output") output = argv[++index];
    else if (value.startsWith("--output=")) output = value.slice("--output=".length);
    else if (value === "--large") large = true;
    else if (value === "--seed") seed = parseSeed(argv[++index]);
    else if (value.startsWith("--seed=")) seed = parseSeed(value.slice("--seed=".length));
    else if (value === "--cleanup-on-failure") {}
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!output) throw new Error("Usage: node scripts/generate-fixtures.mjs --output <new-directory> [--large] [--seed <integer>]");
  return { output, large, seed, cleanupOnFailure: argv.includes("--cleanup-on-failure") };
}

function parseSeed(value) {
  if (value === undefined || !/^-?\d+$/.test(value)) throw new Error("--seed must be a safe integer");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("--seed must be a safe integer");
  return result;
}

async function ensureSafeOutput(directory) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Output must be a real directory: ${directory}`);
    if ((await readdir(directory)).length > 0) throw new Error(`Refusing to overwrite a non-empty output directory: ${directory}`);
    if (await pathIsGitDirectory(directory)) throw new Error(`Refusing to generate over a Git repository: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parentInfo = await stat(dirname(directory));
    if (!parentInfo.isDirectory()) throw new Error(`Output parent is not a directory: ${dirname(directory)}`);
  }
}

async function pathIsGitDirectory(directory) {
  try {
    const [bare, gitDir, topLevel] = await Promise.all([
      git(["-C", directory, "rev-parse", "--is-bare-repository"]),
      git(["-C", directory, "rev-parse", "--absolute-git-dir"]),
      git(["-C", directory, "rev-parse", "--show-toplevel"]).catch(() => ""),
    ]);
    return resolve(bare.trim() === "true" ? gitDir.trim() : topLevel.trim()) === directory;
  } catch {
    return false;
  }
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, { cwd: options.cwd, env: gitEnvironment(options.env), timeout: options.timeout ?? 30_000, maxBuffer: options.maxBuffer ?? MAX_BUFFER, encoding: "utf8" });
  return result.stdout;
}

function gitEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", ...extra };
}

async function probeCapabilities(output) {
  const probe = join(output, ".probe-sha256");
  await mkdir(probe);
  try {
    await git(["init", "--quiet", "--object-format=sha256", probe]);
    return { sha256: true };
  } catch {
    return { sha256: false };
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

async function init(directory, { bare = false, format } = {}) {
  await mkdir(dirname(directory), { recursive: true });
  const initArgs = ["init", "--quiet"];
  if (bare) initArgs.push("--bare");
  if (format) initArgs.push(`--object-format=${format}`);
  initArgs.push(directory);
  await git(initArgs);
}

async function makeEmpty(directory) {
  await init(directory);
}

async function makeTopology(directory, seed) {
  await init(directory);
  await git(["-C", directory, "config", "user.name", "Fixture Author"]);
  await git(["-C", directory, "config", "user.email", "fixture@example.invalid"]);
  await git(["-C", directory, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const commits = [
    { ref: "refs/heads/main", mark: 1, author: ["Ada Root", "ada@example.invalid", 1_700_000_000], committer: ["Ada Root", "ada@example.invalid", 1_700_000_000], message: `根提交\nbody contains seed=${seed}`, files: [["README.md", "root\n"], [".gitattributes", "*.html diff=sentinel\n"]] },
    { ref: "refs/heads/main", mark: 2, from: 1, author: ["Lin Branch", "lin@example.invalid", 1_700_000_100], committer: ["Commit Bot", "bot@example.invalid", 1_700_000_101], message: "feature: 分叉前的提交", files: [["story.txt", "first\n"]] },
    { ref: "refs/heads/main", mark: 3, from: 2, author: ["Lin Branch", "lin@example.invalid", 1_700_000_200], committer: ["Lin Branch", "lin@example.invalid", 1_700_000_200], message: "same timestamp: main", files: [["story.txt", "main line\n"]] },
    { ref: "refs/heads/side", mark: 4, from: 1, author: ["Grace Side", "grace@example.invalid", 1_700_000_200], committer: ["Review Bot", "review@example.invalid", 1_700_000_200, "+0530"], message: "literal <img src=x onerror=alert(1)> <script>fixture</script> & text\n正文也含 <b>HTML</b> 字符", files: [["side.txt", "side line\n"]] },
    { ref: "refs/heads/main", mark: 5, from: 3, merge: [4], author: ["Merge Author", "merge-author@example.invalid", 1_700_000_300], committer: ["Merge Committer", "merge-committer@example.invalid", 1_700_000_301], message: "merge side into main\nsecond line\n中文正文", files: [["story.txt", "merged\n"]] },
    { ref: "refs/heads/left", mark: 6, from: 5, author: ["Octopus A", "a@example.invalid", 1_700_000_400], committer: ["Octopus A", "a@example.invalid", 1_700_000_400], message: "left topic", files: [["left.txt", "left\n"]] },
    { ref: "refs/heads/right", mark: 7, from: 5, author: ["Octopus B", "b@example.invalid", 1_700_000_400], committer: ["Octopus B", "b@example.invalid", 1_700_000_400], message: "right topic", files: [["right.txt", "right\n"]] },
    { ref: "refs/heads/main", mark: 8, from: 5, merge: [6, 7], author: ["Release Author", "release@example.invalid", 1_700_000_500], committer: ["Release Bot", "release-bot@example.invalid", 1_700_000_501], message: "octopus merge", files: [["release.html", "<script>literal fixture content</script>\n"]] },
    { ref: "refs/heads/main", mark: 9, from: 8, author: ["Nested Author", "nested@example.invalid", 1_700_000_600], committer: ["Nested Committer", "nested-committer@example.invalid", 1_700_000_601], message: "nested path fixture", files: [["nested/deep/README.txt", "open this directory as the repository path\n"]] },
  ];
  await streamFastImport(directory, topologyStream(commits));
  await mkdir(join(directory, "nested", "deep"), { recursive: true });
  await git(["-C", directory, "tag", "annotated-release", "-m", "annotated tag", "refs/heads/main"], { env: { GIT_COMMITTER_DATE: "@1700000000 +0000" } });
  await git(["-C", directory, "tag", "lightweight-root", "refs/heads/main~4"]);
  await git(["-C", directory, "update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
}

async function makeBoundary(directory) {
  await init(directory);
  await git(["-C", directory, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const longSummary = `${"x".repeat(4095)}界`;
  await streamFastImport(directory, topologyStream([
    { ref: "refs/heads/main", mark: 1, author: ["Boundary Author", "boundary@example.invalid", 1_700_001_000], committer: ["Boundary Committer", "boundary-committer@example.invalid", 1_700_001_001], message: longSummary, files: [["boundary.txt", "boundary\n"]] },
    { ref: "refs/heads/main", mark: 2, from: 1, author: ["NUL Author", "nul@example.invalid", 1_700_001_100], committer: ["NUL Committer", "nul-committer@example.invalid", 1_700_001_101], message: "NUL\0headline\nbody after NUL", files: [] },
  ]));
  const parentOid = (await git(["-C", directory, "rev-parse", "HEAD"])).trim();
  const treeOid = (await git(["-C", directory, "rev-parse", "HEAD^{tree}"])).trim();
  const rawCommit = Buffer.concat([
    Buffer.from(`tree ${treeOid}\nparent ${parentOid}\nauthor Raw Author <raw@example.invalid> 1700001200 +0000\ncommitter Raw Committer <raw-committer@example.invalid> 1700001201 +0000\n\ninvalid-`),
    Buffer.from([0xff]),
    Buffer.from("-utf8 headline\nbody\n"),
  ]);
  const rawOid = (await gitBuffer(directory, ["hash-object", "--literally", "-t", "commit", "-w", "--stdin"], rawCommit)).toString("utf8").trim();
  await git(["-C", directory, "update-ref", "refs/heads/main", rawOid]);
  const oids = (await git(["-C", directory, "log", "--topo-order", "--format=%H", "HEAD"])).trim().split("\n");
  return Promise.all(oids.map(oid => rawExpectedCommit(directory, oid)));
}

function* topologyStream(commits) {
  for (const commit of commits) {
    yield `commit ${commit.ref}\nmark :${commit.mark}\nauthor ${identity(commit.author)}\ncommitter ${identity(commit.committer)}\ndata ${Buffer.byteLength(commit.message)}\n${commit.message}\n`;
    if (commit.from) yield `from :${commit.from}\n`;
    for (const merge of commit.merge ?? []) yield `merge :${merge}\n`;
    for (const [path, contents] of commit.files) {
      yield `M 100644 inline ${path}\ndata ${Buffer.byteLength(contents)}\n${contents}\n`;
    }
    yield "\n";
  }
  yield "done\n";
}

function identity([name, email, timestamp, offset = "+0000"]) {
  return `${name} <${email}> ${timestamp} ${offset}`;
}

async function streamFastImport(directory, chunks) {
  const child = spawn("git", ["-C", directory, "-c", "core.fsmonitor=false", "fast-import", "--quiet"], { stdio: ["pipe", "ignore", "pipe"], env: gitEnvironment() });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const close = new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolveClose() : reject(new Error(`git fast-import exited ${code ?? signal}: ${stderr}`)));
  });
  close.catch(() => {});
  try {
    for (const chunk of chunks) {
      if (!child.stdin.write(chunk)) await waitForDrain(child.stdin);
    }
    child.stdin.end();
    await close;
  } catch (error) {
    child.kill("SIGKILL");
    await close.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function waitForDrain(stream) {
  return new Promise((resolveDrain, reject) => {
    const cleanup = () => { stream.removeListener("drain", onDrain); stream.removeListener("error", onError); };
    const onDrain = () => { cleanup(); resolveDrain(); };
    const onError = error => { cleanup(); reject(error); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
  });
}

async function makeDetached(directory, source) {
  await git(["clone", "--quiet", "--no-hardlinks", source, directory]);
  const oid = (await git(["-C", source, "rev-parse", "refs/heads/main"])).trim();
  await git(["-C", directory, "checkout", "--quiet", "--detach", oid]);
}

async function makeShallow(directory, source) {
  const url = pathToFileURL(source).href;
  await git(["clone", "--quiet", "--depth=2", "--branch=main", url, directory]);
}

async function makeSha256(directory) {
  await init(directory, { format: "sha256" });
  await git(["-C", directory, "config", "user.name", "SHA256 Fixture"]);
  await git(["-C", directory, "config", "user.email", "sha256@example.invalid"]);
  await writeFile(join(directory, "sha256.txt"), "sha256 fixture\n");
  await git(["-C", directory, "add", "sha256.txt"]);
  await git(["-C", directory, "-c", "user.name=SHA256 Fixture", "-c", "user.email=sha256@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "sha256 object format"], { env: { GIT_AUTHOR_DATE: "@1700000000 +0000", GIT_COMMITTER_DATE: "@1700000001 +0000" } });
}

async function makeMissingPromisor(directory) {
  await init(directory);
  await git(["-C", directory, "config", "gc.auto", "0"]);
  await git(["-C", directory, "config", "maintenance.auto", "false"]);
  await git(["-C", directory, "config", "user.name", "Promisor Fixture"]);
  await git(["-C", directory, "config", "user.email", "promisor@example.invalid"]);
  await writeFile(join(directory, "promisor.txt"), "root\n");
  await git(["-C", directory, "add", "promisor.txt"]);
  await git(["-C", directory, "commit", "--quiet", "--no-gpg-sign", "--date=1700000000 +0000", "-m", "root object to remove"], { env: { GIT_COMMITTER_DATE: "@1700000000 +0000" } });
  const missing = (await git(["-C", directory, "rev-parse", "HEAD"])).trim();
  await writeFile(join(directory, "promisor.txt"), "child\n");
  await git(["-C", directory, "add", "promisor.txt"]);
  await git(["-C", directory, "commit", "--quiet", "--no-gpg-sign", "--date=1700000001 +0000", "-m", "commit with missing parent"], { env: { GIT_COMMITTER_DATE: "@1700000001 +0000" } });
  const objectPath = join(directory, ".git", "objects", missing.slice(0, 2), missing.slice(2));
  await rm(objectPath);
  await git(["-C", directory, "config", "extensions.partialClone", "origin"]);
  await git(["-C", directory, "config", "remote.origin.promisor", "true"]);
  await git(["-C", directory, "config", "remote.origin.partialCloneFilter", "blob:none"]);
  await git(["-C", directory, "config", "remote.origin.url", "sentinel::missing-promisor"]);
}

async function makeLarge(directory, seed) {
  await init(directory);
  await git(["-C", directory, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const stream = largeStream(seed);
  await streamFastImport(directory, stream);
  const generatedCount = Number((await git(["-C", directory, "rev-list", "--count", "HEAD"], { timeout: 120_000 })).trim());
  if (generatedCount !== 100_000) throw new Error(`Large fixture contains ${generatedCount} commits; expected exactly 100000`);
  await git(["-C", directory, "repack", "-ad", "--quiet"]);
}

function* largeStream(seed) {
  const blob = `CommitScope deterministic large fixture seed=${seed}\n`;
  yield `blob\nmark :1\ndata ${Buffer.byteLength(blob)}\n${blob}\n`;
  let previous = 0;
  let state = seed >>> 0;
  for (let index = 1; index <= 100_000; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const authorIndex = state % 4;
    const epoch = 1_600_000_000 + index;
    const message = `fixture ${index.toString().padStart(6, "0")} author=${authorIndex} token=${state.toString(16)}`;
    yield `commit refs/heads/main\nmark :${index + 1}\nauthor Author ${authorIndex} <author${authorIndex}@example.invalid> ${epoch} +0000\ncommitter Committer ${authorIndex % 2} <committer${authorIndex % 2}@example.invalid> ${epoch + 1} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${previous ? `from :${previous}\n` : ""}M 100644 :1 history.txt\n\n`;
    previous = index + 1;
  }
  yield "done\n";
}

async function describeRepository(root, relativePath, purpose, { expectMissing = false, large = false, providedExpectedCommits = null } = {}) {
  const directory = join(root, relativePath);
  const [bareText, objectFormat, shallowText, headText, refsText, countText, gitDir, commonDir] = await Promise.all([
    git(["-C", directory, "rev-parse", "--is-bare-repository"]),
    git(["-C", directory, "rev-parse", "--show-object-format"]),
    git(["-C", directory, "rev-parse", "--is-shallow-repository"]),
    git(["-C", directory, "rev-parse", "--verify", "HEAD"]).catch(() => ""),
    git(["-C", directory, "for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(*objectname)"]),
    git(["-C", directory, "count-objects", "-v"]).catch(() => ""),
    git(["-C", directory, "rev-parse", "--absolute-git-dir"]),
    git(["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
  ]);
  const refs = refsText.trim() ? refsText.trimEnd().split("\n").map(line => {
    const [name, oid, peeledOid = ""] = line.split("\0");
    return { name, oid, peeledOid: peeledOid || null };
  }) : [];
  const hasHead = Boolean(headText.trim());
  let expectedError = null;
  let commits = [];
  let totalCommits = 0;
  if (hasHead && !expectMissing) {
    const count = Number((await git(["-C", directory, "rev-list", "--count", "HEAD"], { timeout: large ? 120_000 : 30_000 })).trim());
    totalCommits = count;
    if (providedExpectedCommits) {
      const oids = (await git(["-C", directory, "log", "--topo-order", "--format=%H", "HEAD"])).trim().split("\n").filter(Boolean);
      if (oids.join("\n") !== providedExpectedCommits.map(commit => commit.oid).join("\n")) throw new Error("Provided boundary expectation order differs from independent git log");
      commits = providedExpectedCommits;
    } else {
      const limit = large ? 10 : 200;
      const oids = (await git(["-C", directory, "log", "--topo-order", `--max-count=${limit}`, "--format=%H", "HEAD"], { timeout: large ? 120_000 : 30_000 })).trim().split("\n").filter(Boolean);
      commits = await Promise.all(oids.map(oid => expectedCommit(directory, oid)));
    }
  } else if (expectMissing) {
    const headObject = await git(["-C", directory, "cat-file", "commit", "HEAD"]);
    const missingParentOid = /^parent ([0-9a-f]+)$/m.exec(headObject)?.[1];
    try {
      await git(["-C", directory, "log", "--topo-order", "--max-count=1", "--format=%H", "HEAD"]);
      throw new Error("Missing promisor fixture unexpectedly allowed git log to complete");
    } catch (error) {
      if (error.message === "Missing promisor fixture unexpectedly allowed git log to complete") throw error;
      expectedError = { command: "git log --topo-order --max-count=1 HEAD", code: error.code ?? null, stderr: (error.stderr ?? "").slice(-4096) };
      if (!missingParentOid || !expectedError.stderr.includes(missingParentOid)) throw new Error(`Missing promisor oracle did not identify the known missing parent ${missingParentOid}: ${expectedError.stderr}`);
      expectedError.missingParentOid = missingParentOid;
    }
  }
  const count = parseCountObjects(countText);
  return {
    path: relativePath,
    purpose,
    bare: bareText.trim() === "true",
    shallow: shallowText.trim() === "true",
    objectFormat: objectFormat.trim(),
    headOid: headText.trim() || null,
    gitDir: relativeTo(root, gitDir.trim()),
    commonDir: relativeTo(root, commonDir.trim()),
    refCount: refs.length,
    refs,
    commitCount: expectMissing ? null : totalCommits,
    expectedCommits: commits,
    ...(expectMissing ? { expectedError, expectedErrorCode: "MISSING_OBJECT" } : {}),
    ...(large ? { expectedCommitSampleCount: commits.length } : {}),
    packState: count,
  };
}

async function expectedCommit(directory, oid) {
  const format = "%H%x00%P%x00%an%x00%ae%x00%at%x00%ai%x00%cn%x00%ce%x00%ct%x00%ci%x00%B";
  const result = await git(["-C", directory, "show", "-s", `--format=${format}`, oid]);
  const fields = result.split("\0");
  const [actualOid, parents, authorName, authorEmail, authorEpoch, authorDate, committerName, committerEmail, committerEpoch, committerDate, ...messageParts] = fields;
  if (actualOid !== oid) throw new Error(`git show returned ${actualOid} while expecting ${oid}`);
  const message = messageParts.join("\0");
  return { oid, parents: parents ? parents.split(" ") : [], summary: message.split(/\r?\n/, 1)[0], author: { name: authorName, email: authorEmail, timestamp: authorEpoch, date: authorDate, offset: authorDate.slice(-5) }, committer: { name: committerName, email: committerEmail, timestamp: committerEpoch, date: committerDate, offset: committerDate.slice(-5) } };
}

async function rawExpectedCommit(directory, oid) {
  const raw = await gitBuffer(directory, ["cat-file", "commit", oid]);
  const separator = raw.indexOf(Buffer.from("\n\n"));
  if (separator < 0) throw new Error(`Commit ${oid} has no header/message separator`);
  const header = raw.subarray(0, separator).toString("utf8");
  const values = { parents: [], author: null, committer: null };
  for (const line of header.split("\n")) {
    if (line.startsWith("parent ")) values.parents.push(line.slice(7));
    else if (line.startsWith("author ")) values.author = parseRawIdentity(line.slice(7));
    else if (line.startsWith("committer ")) values.committer = parseRawIdentity(line.slice(10));
  }
  const message = raw.subarray(separator + 2);
  const newline = message.indexOf(0x0a);
  const rawSummary = message.subarray(0, newline < 0 ? message.length : newline);
  let summary;
  if (rawSummary.length <= 4096) summary = new TextDecoder("utf-8", { fatal: false }).decode(rawSummary);
  else {
    let summaryBytes = rawSummary.subarray(0, 4096);
    summary = undefined;
    const summaryDecoder = new TextDecoder("utf-8", { fatal: true });
    while (summaryBytes.length >= 0) {
      try { summary = summaryDecoder.decode(summaryBytes); break; }
      catch { summaryBytes = summaryBytes.subarray(0, summaryBytes.length - 1); }
    }
    if (summary === undefined) summary = "";
  }
  let messageIsLossy = false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(message); } catch { messageIsLossy = true; }
  return { oid, parents: values.parents, summary, summaryTruncated: rawSummary.length > 4096, author: values.author, committer: values.committer, textLossy: messageIsLossy };
}

function parseRawIdentity(value) {
  const match = /^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!match) throw new Error(`Malformed generated commit identity: ${value}`);
  return { name: match[1], email: match[2], timestamp: match[3], offset: match[4] };
}

function gitBuffer(directory, args, input = Buffer.alloc(0)) {
  return new Promise((resolveBuffer, rejectBuffer) => {
    const child = spawn("git", ["-C", directory, ...args], { stdio: ["pipe", "pipe", "pipe"], env: gitEnvironment() });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 4 * 1024 * 1024) child.kill("SIGKILL");
      else stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", error => { clearTimeout(timer); rejectBuffer(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveBuffer(Buffer.concat(stdout));
      else rejectBuffer(new Error(`git ${args.join(" ")} failed (${code ?? signal}): ${stderr}`));
    });
    child.stdin.end(input);
  });
}

function parseCountObjects(text) {
  const result = {};
  for (const line of text.split("\n")) {
    const match = /^(count|size|in-pack|packs|size-pack|prune-packable|garbage|size-garbage):\s+(\d+)/.exec(line);
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

function relativeTo(root, value) {
  if (!value) return null;
  const absolute = resolve(value);
  const rel = absolute === root ? "." : absolute.startsWith(`${root}${sep}`) ? absolute.slice(root.length + 1) : absolute;
  return rel;
}
