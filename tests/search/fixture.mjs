import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const authors = [
  { name: "Alice Search", email: "alice-search@example.invalid" },
  { name: "Bob Search", email: "bob-search@example.invalid" },
  { name: "Carol Search", email: "carol-search@example.invalid" },
];
const committers = [
  { name: "Xavier Committer", email: "xavier-committer@example.invalid" },
  { name: "Yuki Committer", email: "yuki-committer@example.invalid" },
];

export async function createSearchFixture(root, { count = 2_600 } = {}) {
  const repository = join(root, "metadata search repository\nwith spaces");
  await mkdir(root, { recursive: true });
  await git(root, ["init", "--quiet", "--initial-branch=main", repository]);
  const stream = [];
  let mark = 0;
  let previous = null;
  const mainMarks = [];

  for (let index = 0; index < count; index += 1) {
    mark += 1;
    mainMarks.push(mark);
    const author = authors[index % authors.length];
    const committer = committers[index % committers.length];
    let message = `common searchable marker\n\nbody row ${String(index).padStart(4, "0")} contains searchable content.`;
    let authorTimestamp = 1_700_000_000 + index * 300;
    let committerTimestamp = authorTimestamp + 97;
    let authorOffset = index % 2 === 0 ? "+0845" : "-0430";
    let committerOffset = index % 2 === 0 ? "-0330" : "+1245";

    if (index >= 2_100) {
      message = `common searchable marker · wide-frame commit ${index} ${"x".repeat(1_250)}\n\nWide summaries force the search page response through multiple bounded protocol frames.`;
    }

    if (index === 0) {
      message = "common searchable marker · late-sorting root\n\nThe root has a future time so it arrives late in the indexed prefix but sorts first.";
      authorTimestamp = 2_000_000_000;
      committerTimestamp = 2_000_000_000;
    } else if (index === 1) {
      message = "common searchable marker · 中文短词，标题命中！\n\n正文包含两字词语和标点：，。！？\nCo-authored-by: Search Partner <partner@example.invalid>";
    } else if (index === 2) {
      message = "common searchable marker · Casefold Straße\n\nGreek ΟΣ, Turkish İ, composed café and decomposed café.";
    } else if (index === 3) {
      message = "common searchable marker · Casefold STRASSE\n\nGreek ος, Turkish i, composed café and decomposed café.";
    } else if (index === 4) {
      message = "common searchable marker · lookalike hash deadbeef\n\nA message query that resembles a hash remains a message query.";
    }
    if (index === 1_200) {
      // A middle ancestor is much older than the following commits. Search must not stop on a time boundary.
      authorTimestamp = 1_500_000_000;
      committerTimestamp = 1_500_000_013;
    }
    if (index === 1_201) {
      // Author and Committer timestamps intentionally land on different date windows.
      authorTimestamp = 1_700_000_000;
      committerTimestamp = 1_700_000_100;
    }
    if (index === 1_202) {
      authorTimestamp = 1_700_000_005;
      committerTimestamp = 1_700_000_101;
    }
    if (index === 800 || index === 801) {
      committerTimestamp = 1_700_100_000;
    }
    if (index >= 2_000 && index <= 2_003) {
      const dstBoundaryTimestamps = [1_772_956_799, 1_772_956_800, 1_773_039_599, 1_773_039_600];
      authorTimestamp = dstBoundaryTimestamps[index - 2_000];
      committerTimestamp = dstBoundaryTimestamps[index - 2_000];
      authorOffset = "+0530";
      committerOffset = "-0700";
      message = `common searchable marker · DST boundary ${index - 2_000}`;
    }

    const timestamp = date => `${date} +0000`;
    const lines = [
      "commit refs/heads/main",
      `mark :${mark}`,
      `author ${author.name} <${author.email}> ${timestamp(authorTimestamp)}`,
      `committer ${committer.name} <${committer.email}> ${timestamp(committerTimestamp)}`,
      `data ${Buffer.byteLength(message, "utf8")}`,
      message,
      ...(previous === null ? [] : [`from :${previous}`]),
      "",
    ];
    stream.push(lines.join("\n"));
    previous = mark;
  }

  const forkMark = mainMarks[Math.floor(count * 0.55) - 1];
  let sidePrevious = forkMark;
  const sideMarks = [];
  for (let index = 0; index < 13; index += 1) {
    mark += 1;
    sideMarks.push(mark);
    const author = authors[(index + 1) % authors.length];
    const committer = committers[(index + 1) % committers.length];
    const authorTimestamp = 1_800_000_000 + index * 60;
    const committerTimestamp = authorTimestamp + 5;
    const message = `common searchable marker\n\nside branch searchable row ${index}.`;
    stream.push([
      "commit refs/heads/side",
      `mark :${mark}`,
      `author ${author.name} <${author.email}> ${authorTimestamp} -0700`,
      `committer ${committer.name} <${committer.email}> ${committerTimestamp} +0530`,
      `data ${Buffer.byteLength(message, "utf8")}`,
      message,
      `from :${sidePrevious}`,
      "",
    ].join("\n"));
    sidePrevious = mark;
  }

  mark += 1;
  const mergeMessage = "common searchable marker · merge side\n\nIndependent Git oracle preserves two parents.";
  const mergeAuthor = { name: "Merge Search Author", email: "merge-search-author@example.invalid" };
  const mergeCommitter = { name: "Merge Search Committer", email: "merge-search-committer@example.invalid" };
  stream.push([
    "commit refs/heads/main",
    `mark :${mark}`,
    `author ${mergeAuthor.name} <${mergeAuthor.email}> 1800001000 +0000`,
    `committer ${mergeCommitter.name} <${mergeCommitter.email}> 1800001010 +0000`,
    `data ${Buffer.byteLength(mergeMessage, "utf8")}`,
    mergeMessage,
    `from :${mainMarks.at(-1)}`,
    `merge :${sideMarks.at(-1)}`,
    "",
    `reset refs/heads/pre-merge\nfrom :${mainMarks.at(-1)}\n`,
    "done",
    "",
  ].join("\n"));
  await runFastImport(repository, stream.join(""));

  const mainTip = await git(repository, ["rev-parse", "refs/heads/main"]);
  const sideTip = await git(repository, ["rev-parse", "refs/heads/side"]);
  const preMergeTip = await git(repository, ["rev-parse", "refs/heads/pre-merge"]);
  const oids = (await git(repository, ["rev-list", "--topo-order", mainTip])).split("\n").filter(Boolean);
  const preMergeOids = (await git(repository, ["rev-list", "--topo-order", preMergeTip])).split("\n").filter(Boolean);
  const shortPrefixes = new Map();
  for (const oid of oids) {
    const prefix = oid.slice(0, 4);
    shortPrefixes.set(prefix, [...(shortPrefixes.get(prefix) ?? []), oid]);
  }
  const ambiguousPrefix = [...shortPrefixes.entries()].find(([, values]) => values.length > 1);
  if (!ambiguousPrefix) throw new Error(`Preflight fixture has no colliding four-character OID prefix (${oids.length} commits)`);

  const expected = new Map((await readGitCommits(repository, oids)).map(commit => [commit.oid, commit]));
  const sortedOids = list => list.slice().sort((leftOid, rightOid) => {
    const left = expected.get(leftOid).committer.timestamp;
    const right = expected.get(rightOid).committer.timestamp;
    return right - left || (leftOid < rightOid ? -1 : leftOid > rightOid ? 1 : 0);
  });
  const snapshot = await snapshotTree(repository);
  const firstSearchPage = [...expected.values()].sort((left, right) => right.committer.timestamp - left.committer.timestamp ||
    (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0)).slice(0, 500);
  const framePageBytes = Buffer.byteLength(JSON.stringify(firstSearchPage.map(({ oid, parents, message, author, committer }) => ({
    oid, parents, summary: message.split("\n", 1)[0], author, committer,
  }))), "utf8");
  if (framePageBytes <= 512 * 1024) throw new Error(`Preflight page would not exercise response chunking (${framePageBytes} bytes)`);
  const authorRoot = await git(repository, ["rev-parse", `${mainTip}~${count}`]);
  const earliest = expected.get(authorRoot);
  if (earliest.committer.timestamp !== 2_000_000_000) throw new Error(`Preflight failed: delayed root timestamp is ${earliest.committer.timestamp}`);
  if (oids.length < 2_500) throw new Error(`Preflight needs at least 2500 reachable commits, found ${oids.length}`);

  let sha256Repository = null;
  let sha256Tip = null;
  const sha256Path = join(root, "sha256 search repository");
  try {
    await git(root, ["init", "--quiet", "--initial-branch=main", "--object-format=sha256", sha256Path]);
    const shaMessage = "SHA-256 search fixture\n\nfull 64-character OID search";
    await runFastImport(sha256Path, [
      "commit refs/heads/main\nmark :1\nauthor SHA Search <sha-search@example.invalid> 1800000000 +0000\ncommitter SHA Search Committer <sha-committer@example.invalid> 1800000010 +0000\n",
      `data ${Buffer.byteLength(shaMessage, "utf8")}\n${shaMessage}\ndone\n`,
    ].join(""));
    sha256Repository = await realpath(sha256Path);
    sha256Tip = await git(sha256Repository, ["rev-parse", "HEAD"]);
  } catch {
    // Keep SHA-256 coverage conditional on system Git support, matching P1-05 fixture behavior.
  }

  return {
    repository: await realpath(repository),
    mainTip,
    sideTip,
    preMergeTip,
    preMergeOids,
    tips: [mainTip, sideTip],
    commits: expected,
    oids,
    ambiguousPrefix: ambiguousPrefix[0],
    ambiguousOids: sortedOids(ambiguousPrefix[1]),
    unicodeOids: {
      casefold: sortedOids([...expected.values()].filter(record => record.message.includes("Casefold Straße") || record.message.includes("Casefold STRASSE")).map(record => record.oid)),
      uppercaseOnly: sortedOids([...expected.values()].filter(record => record.message.includes("Casefold STRASSE")).map(record => record.oid)),
      sigma: sortedOids([...expected.values()].filter(record => record.message.includes("Greek ΟΣ") || record.message.includes("Greek ος")).map(record => record.oid)),
      turkishI: sortedOids([...expected.values()].filter(record => record.message.includes("Turkish İ") || record.message.includes("Turkish i")).map(record => record.oid)),
      composed: sortedOids([...expected.values()].filter(record => record.message.includes("composed café")).map(record => record.oid)),
      decomposed: sortedOids([...expected.values()].filter(record => record.message.includes("composed café")).map(record => record.oid)),
      chinese: sortedOids([...expected.values()].filter(record => record.message.includes("中文")).map(record => record.oid)),
      punctuation: sortedOids([...expected.values()].filter(record => record.message.includes("，。")).map(record => record.oid)),
      hashLikeMessage: sortedOids([...expected.values()].filter(record => record.message.includes("deadbeef")).map(record => record.oid)),
    },
    lateOid: authorRoot,
    rootOid: authorRoot,
    snapshot,
    framePageBytes,
    sha256Repository,
    sha256Tip,
    count,
  };
}

export async function git(cwd, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  const result = await execFileAsync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options, env: { ...env, ...options.env },
  });
  return Buffer.isBuffer(result.stdout) ? result.stdout : result.stdout.trimEnd();
}

function parseCommit(oid, raw) {
  const separator = raw.indexOf("\n\n");
  if (separator < 0) throw new Error(`Malformed commit object ${oid}`);
  const headerLines = raw.slice(0, separator).split("\n");
  const identity = key => {
    const line = headerLines.find(value => value.startsWith(`${key} `));
    const match = line?.match(/^(?:author|committer) (.*) <(.*)> (-?\d+) ([+-]\d{4})$/u);
    if (!match) throw new Error(`Missing ${key} header in ${oid}`);
    return { name: match[1], email: match[2], timestamp: Number(match[3]), offset: match[4] };
  };
  return {
    oid,
    parents: headerLines.filter(line => line.startsWith("parent ")).map(line => line.slice(7)),
    author: identity("author"),
    committer: identity("committer"),
    message: raw.slice(separator + 2),
  };
}

function catFileBatch(repository, oids) {
  return new Promise((resolveBatch, rejectBatch) => {
    const child = spawn("git", ["-C", repository, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"], env: cleanEnvironment() });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", rejectBatch);
    child.once("close", code => {
      if (code !== 0) return rejectBatch(new Error(`git cat-file --batch failed: ${stderr}`));
      try {
        const output = Buffer.concat(chunks);
        const commits = [];
        let offset = 0;
        for (const expectedOid of oids) {
          const lineEnd = output.indexOf(0x0a, offset);
          if (lineEnd < 0) throw new Error(`Missing cat-file header for ${expectedOid}`);
          const header = output.subarray(offset, lineEnd).toString("ascii").split(" ");
          if (header[0] !== expectedOid || header[1] !== "commit") throw new Error(`Unexpected cat-file response: ${header.join(" ")}`);
          const size = Number(header[2]);
          const bodyStart = lineEnd + 1;
          const bodyEnd = bodyStart + size;
          if (!Number.isSafeInteger(size) || bodyEnd > output.length || output[bodyEnd] !== 0x0a) throw new Error(`Truncated cat-file body for ${expectedOid}`);
          commits.push(parseCommit(expectedOid, output.subarray(bodyStart, bodyEnd).toString("utf8")));
          offset = bodyEnd + 1;
        }
        resolveBatch(commits);
      } catch (error) { rejectBatch(error); }
    });
    child.stdin.end(`${oids.join("\n")}\n`);
  });
}

export function readGitCommits(repository, oids) {
  return catFileBatch(repository, oids);
}

export async function snapshotTree(repository) {
  const output = await git(repository, ["status", "--porcelain=v2", "--branch"]);
  const refs = await git(repository, ["for-each-ref", "--format=%(refname)%00%(objectname)"]);
  const head = await git(repository, ["rev-parse", "HEAD"]);
  return { output, refs, head };
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
