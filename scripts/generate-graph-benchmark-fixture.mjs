#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);
const output = parseOutput(process.argv.slice(2));
await ensureFreshOutput(output);
await mkdir(dirname(output), { recursive: true });
await mkdir(output, { recursive: false });
const repository = resolve(output, "wide-history");

await git(["init", "--quiet", "--initial-branch=main", repository]);
await git(["-C", repository, "config", "user.name", "Graph Benchmark"]);
await git(["-C", repository, "config", "user.email", "graph-benchmark@example.invalid"]);

const totalCommits = 100_000;
const branchCount = 8;
const lengths = Array.from({ length: branchCount }, (_, index) => index === branchCount - 1 ? 12_498 : 12_500);
assert.equal(lengths.reduce((sum, length) => sum + length, 0), totalCommits - 2);
const tips = [];
const branchMarkLists = [];
let mark = 1;
const branchTimes = 12_500;
const stream = [];
stream.push(fastImportCommit({ ref: "refs/heads/graph/base", mark, message: "shared graph base", timestamp: 1_700_000_000 }));
const baseMark = mark;
mark += 1;

for (let branch = 0; branch < branchCount; branch += 1) {
  const ref = `refs/heads/graph/topic-${String(branch).padStart(2, "0")}`;
  const marks = [];
  let parent = baseMark;
  for (let index = 0; index < lengths[branch]; index += 1) {
    const nextMark = mark++;
    const timestamp = 1_700_000_100 + index * 3 + branch;
    stream.push(fastImportCommit({ ref, mark: nextMark, parent, message: `graph-${branch}-${String(index).padStart(5, "0")}`, timestamp }));
    marks.push(nextMark);
    parent = nextMark;
  }
  tips.push(parent);
  branchMarkLists.push(marks);
}

const aliasCount = 990;
for (let index = 0; index < aliasCount; index += 1) {
  const branch = index % branchCount;
  const position = Math.min(lengths[branch] - 1, Math.floor(index / branchCount * lengths[branch] / Math.ceil(aliasCount / branchCount)));
  stream.push(`reset refs/heads/bench/ref-${String(index).padStart(4, "0")}\nfrom :${branchMarkLists[branch][position]}\n\n`);
}

const headMark = mark++;
stream.push(fastImportCommit({
  ref: "refs/heads/main",
  mark: headMark,
  parent: tips[0],
  merges: [...tips.slice(1), baseMark],
  message: "wide graph benchmark octopus head",
  timestamp: 1_800_000_000,
}));
stream.push("done\n");
await fastImport(repository, stream);
await git(["-C", repository, "repack", "-ad", "--quiet"]);

const headOid = (await git(["-C", repository, "rev-parse", "HEAD"])).trim();
const refLines = (await git(["-C", repository, "for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)", "refs/heads"])).trim().split("\n").filter(Boolean);
const refs = refLines.map(line => {
  const [name, oid] = line.split("\0");
  return { name, oid };
});
const graphRows = (await git(["-C", repository, "rev-list", "--topo-order", "--parents", "HEAD"])).trim().split("\n").filter(Boolean).map(line => {
  const [oid, ...parents] = line.trim().split(/\s+/);
  return { oid, parents };
});
assert.equal(graphRows.length, totalCommits, `expected 100000 commits, got ${graphRows.length}`);
assert.equal(refs.length, 1 + branchCount + aliasCount + 1, `expected 1000 refs, got ${refs.length}`);
assert.equal(graphRows[0].oid, headOid);
assert.equal(graphRows[0].parents.length, branchCount + 1, "octopus head should keep all eight branch tips and the shared base");

const rowIndex = new Map(graphRows.map((row, index) => [row.oid, index]));
const firstPrefixFrontier = [];
const processed = new Set();
const parentsSeen = new Set();
let maxParentSpan = 0;
let mergeCount = 0;
let maxParentCount = 0;
for (let index = 0; index < graphRows.length; index += 1) {
  const row = graphRows[index];
  if (row.parents.length > 1) mergeCount += 1;
  maxParentCount = Math.max(maxParentCount, row.parents.length);
  for (const parent of row.parents) {
    const parentIndex = rowIndex.get(parent);
    assert.ok(parentIndex > index, `parent must follow child in topo order: ${row.oid} -> ${parent}`);
    maxParentSpan = Math.max(maxParentSpan, parentIndex - index);
    parentsSeen.add(parent);
  }
  processed.add(row.oid);
  if (index < 2_000) {
    firstPrefixFrontier.push([...parentsSeen].filter(oid => !processed.has(oid)).length);
  }
}
const firstTwoKFrontierMax = Math.max(...firstPrefixFrontier);
assert.ok(firstTwoKFrontierMax >= 7, `first 2000 rows do not maintain a wide frontier: ${firstTwoKFrontierMax}`);
assert.ok(maxParentSpan > 200, `expected a long parent edge, got ${maxParentSpan}`);
assert.equal(mergeCount, 1, "fixture uses one 9-parent octopus and otherwise linear lanes");

const manifest = {
  schemaVersion: 1,
  fixture: "p2-01-wide-graph-scroll",
  repository: "wide-history",
  topology: "one shared root, eight long topic branches, one 9-parent octopus HEAD; 990 additional local branch refs point into those reachable lanes",
  expectedCommitCount: totalCommits,
  expectedRefCount: refs.length,
  branchCount: refs.length,
  headOid,
  objectFormat: (await git(["-C", repository, "rev-parse", "--show-object-format"])).trim(),
  mergeCount,
  maxParentCount,
  maxParentSpan,
  maxFrontierInFirst2000Rows: firstTwoKFrontierMax,
  refs,
};
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output: resolve(output), repository, ...manifest, refs: `manifest lists ${refs.length} refs` }, null, 2)}\n`);

function parseOutput(argv) {
  const argument = argv.find(value => value.startsWith("--output="));
  if (!argument || !argument.slice("--output=".length).startsWith("/")) throw new Error("Usage: node scripts/generate-graph-benchmark-fixture.mjs --output=/absolute/new/path");
  return resolve(argument.slice("--output=".length));
}

async function ensureFreshOutput(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (await readdir(path)).length > 0) throw new Error(`Refusing to overwrite existing fixture output: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function fastImportCommit({ ref, mark: oid, parent, merges = [], message, timestamp }) {
  let output = `commit ${ref}\nmark :${oid}\nauthor Graph Benchmark <graph-benchmark@example.invalid> ${timestamp} +0000\ncommitter Graph Benchmark <graph-benchmark@example.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
  if (parent !== undefined) output += `from :${parent}\n`;
  for (const merge of merges) output += `merge :${merge}\n`;
  return `${output}\n`;
}

async function fastImport(repositoryPath, chunks) {
  const child = spawn("git", ["-C", repositoryPath, "-c", "core.fsmonitor=false", "fast-import", "--quiet"], {
    stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    env: cleanEnvironment(),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
  child.stdin.on("error", () => {});
  const timer = setTimeout(() => killGroup(child, "SIGKILL"), 300_000);
  const close = new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (code, signal) => code === 0 ? resolveClose() : rejectClose(new Error(`git fast-import exited ${code ?? signal}: ${stderr}`)));
  });
  try {
    for (const chunk of chunks) if (!child.stdin.write(chunk)) await new Promise((resolveDrain, rejectDrain) => {
      const cleanup = () => {
        child.stdin.removeListener("drain", onDrain);
        child.stdin.removeListener("error", onError);
      };
      const onDrain = () => { cleanup(); resolveDrain(); };
      const onError = error => { cleanup(); rejectDrain(error); };
      child.stdin.once("drain", onDrain);
      child.stdin.once("error", onError);
    });
    child.stdin.end();
    await close;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
  }
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, { env: cleanEnvironment(), timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
