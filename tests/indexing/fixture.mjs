import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

/** A compact but multi-batch Git graph with independently distinguishable metadata. */
export async function createMetadataFixture(root, { count = 130, sha256 = false } = {}) {
  const repository = join(root, "metadata repository\nwith spaces");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "Fixture Author"]);
  await git(repository, ["config", "user.email", "fixture-author@example.invalid"]);
  const stream = [];
  let mark = 0;
  let previous = null;
  const mainMarks = [];
  for (let index = 1; index <= count; index += 1) {
    mark += 1;
    mainMarks.push(mark);
    const special = index === 3;
    const summary = special ? "中文 metadata · punctuation !?" : `metadata commit ${String(index).padStart(4, "0")}`;
    const message = special
      ? `${summary}\n\n正文保留多行、标点：，。！？ and Unicode 🔎\nCo-authored-by: Second Person <second@example.invalid>`
      : `${summary}\n\nbody for commit ${index}\nsecond line ${index}\n${"x".repeat(768)}`;
    const authorName = special ? "作者甲" : `Author ${index % 7}`;
    const authorEmail = special ? "author-special@example.invalid" : `author-${index % 7}@example.invalid`;
    const committerName = special ? "提交者乙" : `Committer ${index % 5}`;
    const committerEmail = special ? "committer-special@example.invalid" : `committer-${index % 5}@example.invalid`;
    const timestamp = 1_780_000_000 + index;
    const authorOffset = index % 2 === 0 ? "+0845" : "-0430";
    const committerOffset = index % 2 === 0 ? "-0330" : "+1245";
    const lines = [
      "commit refs/heads/main",
      `mark :${mark}`,
      `author ${authorName} <${authorEmail}> ${timestamp} ${authorOffset}`,
      `committer ${committerName} <${committerEmail}> ${timestamp + 73} ${committerOffset}`,
      `data ${Buffer.byteLength(message, "utf8")}`,
      message,
      ...(previous === null ? [] : [`from :${previous}`]),
      "",
    ];
    stream.push(lines.join("\n"));
    previous = mark;
  }

  const forkIndex = Math.max(2, Math.floor(count * 0.72));
  const sideStart = mainMarks[forkIndex - 1];
  const sideMarks = [];
  let sidePrevious = sideStart;
  for (let index = 1; index <= 7; index += 1) {
    mark += 1;
    sideMarks.push(mark);
    const message = `side branch ${index}\nseparate history ${index}`;
    stream.push([
      "commit refs/heads/side",
      `mark :${mark}`,
      `author Side Author <side-author@example.invalid> ${1_780_100_000 + index} +0530`,
      `committer Side Committer <side-committer@example.invalid> ${1_780_100_100 + index} -0700`,
      `data ${Buffer.byteLength(message, "utf8")}`,
      message,
      `from :${sidePrevious}`,
      "",
    ].join("\n"));
    sidePrevious = mark;
  }

  mark += 1;
  const mergeMark = mark;
  const mergeMessage = "merge side into main\n\nThis message has an ordered two-parent commit.";
  stream.push([
    "commit refs/heads/main",
    `mark :${mergeMark}`,
    `author Merge Author <merge-author@example.invalid> 1780200000 +0000`,
    `committer Merge Committer <merge-committer@example.invalid> 1780200010 +0000`,
    `data ${Buffer.byteLength(mergeMessage, "utf8")}`,
    mergeMessage,
    `from :${mainMarks.at(-1)}`,
    `merge :${sideMarks.at(-1)}`,
    "",
    "done",
    "",
  ].join("\n"));
  await runFastImport(repository, stream.join(""));
  const mainTip = await git(repository, ["rev-parse", "refs/heads/main"]);
  const sideTip = await git(repository, ["rev-parse", "refs/heads/side"]);
  const mainReachableCount = Number(await git(repository, ["rev-list", "--count", mainTip]));
  const sideReachableCount = Number(await git(repository, ["rev-list", "--count", sideTip]));
  const mergeParents = (await git(repository, ["show", "-s", "--format=%P", mainTip])).split(" ").filter(Boolean);
  if (mergeParents.length !== 2) throw new Error(`Expected a two-parent merge, got ${mergeParents.length}`);

  let sha256Repository = null;
  let sha256Tip = null;
  if (sha256) {
    const candidate = join(root, "sha256 repository");
    try {
      await git(root, ["init", "--quiet", "--initial-branch=main", "--object-format=sha256", candidate]);
      const message = "SHA-256 metadata\n\n64-character object id";
      await runFastImport(candidate, [
        "commit refs/heads/main\nmark :1\nauthor Hash Author <hash-author@example.invalid> 1780000000 +0000\ncommitter Hash Committer <hash-committer@example.invalid> 1780000010 +0000\n",
        `data ${Buffer.byteLength(message, "utf8")}\n${message}\n\ndone\n`,
      ].join(""));
      sha256Repository = await realpath(candidate);
      sha256Tip = await git(candidate, ["rev-parse", "HEAD"]);
    } catch {
      // Older system Git builds may not support SHA-256 repositories.
    }
  }

  return {
    repository: await realpath(repository),
    sha256Repository,
    tips: [mainTip, sideTip],
    mainTip,
    sideTip,
    mergeTip: mainTip,
    mergeParents,
    specialOid: await git(repository, ["rev-parse", `refs/heads/main~${count - 2}`]),
    commitCount: Number(await git(repository, ["rev-list", "--count", ...[mainTip, sideTip]])),
    mainReachableCount,
    sideReachableCount,
    count,
    sha256Tip,
  };
}

export async function createMetadataLruFixture(root, { branchCount = 9 } = {}) {
  const repository = join(root, "snapshot-cache-repository");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  await git(repository, ["config", "user.name", "Snapshot Cache Author"]);
  await git(repository, ["config", "user.email", "snapshot-cache@example.invalid"]);
  await writeCommitFile(repository, "base.txt", "base\n", "snapshot cache base");
  const baseTip = await git(repository, ["rev-parse", "HEAD"]);
  const branches = [];
  for (let index = 1; index <= branchCount; index += 1) {
    const name = `lru-${String(index).padStart(2, "0")}`;
    await git(repository, ["checkout", "--quiet", "-b", name, baseTip]);
    await writeCommitFile(repository, `branch-${index}.txt`, `branch ${index}\n`, `snapshot cache branch ${index}`);
    branches.push({ name, tip: await git(repository, ["rev-parse", "HEAD"]) });
    await git(repository, ["checkout", "--quiet", "main"]);
  }
  return { repository: await realpath(repository), baseTip, branches };
}

export async function createLooseMissingFixture(repository, commitCount = 90) {
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "--quiet", "--initial-branch=main"]);
  await git(repository, ["config", "user.name", "Missing Object Author"]);
  await git(repository, ["config", "user.email", "missing-object@example.invalid"]);
  for (let index = 1; index <= commitCount; index += 1) {
    await git(repository, ["commit", "--quiet", "--allow-empty", "-m", `loose commit ${index}`]);
  }
  const missingOid = await git(repository, ["rev-parse", `HEAD~${Math.floor(commitCount * 0.72)}`]);
  const actualCount = Number(await git(repository, ["rev-list", "--count", "HEAD"]));
  const objectPath = join(repository, ".git", "objects", missingOid.slice(0, 2), missingOid.slice(2));
  return { repository: await realpath(repository), missingOid, commitCount: actualCount, objectPath };
}

export async function git(cwd, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = await execFileAsync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options, env: { ...env, ...options.env },
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : result.stdout.trimEnd();
}

async function writeCommitFile(repository, relativePath, contents, message) {
  const path = join(repository, relativePath);
  await writeFile(path, contents);
  await git(repository, ["add", "--", relativePath]);
  await git(repository, ["commit", "--quiet", "-m", message]);
}

function runFastImport(repository, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile("git", ["-C", repository, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fast-import", "--quiet"], {
      encoding: "utf8", maxBuffer: 1024 * 1024, env: cleanEnvironment(),
    }, (error, _stdout, stderr) => {
      if (error) rejectRun(new Error(`git fast-import failed: ${error.message}\n${stderr}`));
      else resolveRun();
    });
    child.stdin.end(input);
  });
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
