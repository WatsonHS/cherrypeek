import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SearchDaemonClient, createDaemonEnvironment, projectMetadataStatus, projectSearchIdentities, projectSearchPage, projectSession } from "./daemon-client.mjs";
import { git, readGitCommits } from "./fixture.mjs";

const repository = resolve(process.env.COMMITSCOPE_PROJECT_REPOSITORY);
const daemonPath = resolve(process.env.COMMITSCOPE_DAEMON_PATH);
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-project-search-trial-"));
const appDataDir = join(temporaryRoot, "app-data");
const before = await gitStateSnapshot(repository);
const queryMeasurements = [];
const client = new SearchDaemonClient(daemonPath, {
  cwd: repository,
  env: createDaemonEnvironment(appDataDir),
});

try {
  await client.start();
  const session = projectSession(await client.open(repository));
  assert.ok(session, "the actual project repository opens through the daemon protocol");
  const firstHistory = await client.readPage(session, null, 8);
  assert.ok(firstHistory.chunks.length > 0, "actual project history displays before full metadata indexing");
  const status = await waitForIndex(client, session, value => value.state === "complete");
  const gitTips = session.tips;
  const oids = (await git(repository, ["rev-list", "--topo-order", ...gitTips])).split("\n").filter(Boolean);
  const records = await readGitCommits(repository, oids);

  const metadataQuery = query({ message: "metadata", caseSensitive: true });
  const metadataRows = await measure("完整消息 metadata", tick => collectAll(client, session, metadataQuery, 20, tick));
  const metadataExpected = sort(records.filter(record => record.message.includes("metadata")), "committer");
  assert.ok(metadataExpected.length > 0, "the actual project history has a real metadata-message match");
  assert.deepEqual(metadataRows.map(row => row.oid), metadataExpected.map(record => record.oid),
    "actual project full-message results match independent rev-list and cat-file objects");
  assert.equal(metadataRows[0].author.email, metadataExpected[0].author.email);
  assert.equal(metadataRows[0].committer.email, metadataExpected[0].committer.email);

  const authorIdentity = records[0].author;
  const authorQuery = query({ authors: [{ name: authorIdentity.name, email: authorIdentity.email }] });
  const authorRows = await measure("精确 Author", tick => collectAll(client, session, authorQuery, 20, tick));
  const authorExpected = sort(records.filter(record => record.author.name === authorIdentity.name && record.author.email === authorIdentity.email), "committer");
  assert.deepEqual(authorRows.map(row => row.oid), authorExpected.map(record => record.oid),
    "actual project Author filtering matches the exact raw Git name/email pair");

  const headOid = await git(repository, ["rev-parse", "HEAD"]);
  const headPrefixQuery = query({ oidPrefix: headOid.slice(0, 4) });
  const prefixRows = await measure(`HEAD OID 前缀 ${headOid.slice(0, 4)}`, tick => collectAll(client, session, headPrefixQuery, 20, tick));
  const prefixExpected = sort(records.filter(record => record.oid.startsWith(headOid.slice(0, 4))), "committer");
  assert.deepEqual(prefixRows.map(row => row.oid), prefixExpected.map(record => record.oid));

  const identities = await measure("Author 身份建议", async tick => {
    tick();
    return projectSearchIdentities(await client.listSearchIdentities(session, "author", "", 100));
  });
  const unique = new Map();
  for (const record of records) unique.set(`${record.author.name}\0${record.author.email}`, { name: record.author.name, email: record.author.email });
  const identityOracle = [...unique.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : left.email < right.email ? -1 : left.email > right.email ? 1 : 0);
  assert.deepEqual(identities.identities, identityOracle, "actual project Author suggestions match unique raw Git identities");
  assert.equal(status.coverage.processed, oids.length);
  await client.stop();
  assert.deepEqual(await gitStateSnapshot(repository), before, "real project search, indexing and identity listing leave HEAD, refs and index unchanged");
  const report = [
    `Actual project repository trial passed: ${oids.length} reachable commits across ${gitTips.length} frozen tip(s), ${status.coverage.processed} indexed members; temporary app data only.`,
    `Daemon build profile: ${process.env.COMMITSCOPE_DAEMON_PROFILE ?? "unknown"}.`,
  ];
  for (const item of queryMeasurements) {
    report.push(`  ${item.label}: ${item.resultCount} result(s), ${item.elapsedMs.toFixed(1)} ms daemon request/response end-to-end (${item.requests} request(s), including complete paging).`);
  }
  report.push("  Git HEAD, refs and index SHA-256 were unchanged. Concurrent worktree edits are outside this check.");
  report.push("  This small project history sample does not establish search performance for 100,000-commit repositories.");
  await mkdir(resolve("output/test"), { recursive: true });
  await writeFile(resolve("output/test/p1-06-real-repository.log"), report.join("\n") + "\n");
  process.stdout.write(report.join("\n") + "\n");
} finally {
  await client.stop().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

function query(overrides = {}) {
  return {
    message: "",
    caseSensitive: false,
    authors: [],
    committers: [],
    oidPrefix: "",
    path: null,
    timeField: "committer",
    fromTimestamp: null,
    toTimestamp: null,
    timeZone: "Asia/Shanghai",
    ...overrides,
  };
}

async function gitStateSnapshot(repo) {
  const head = await git(repo, ["rev-parse", "--verify", "HEAD"]);
  const refs = await git(repo, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]);
  const indexPath = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const index = await readFile(indexPath).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  return {
    head,
    refs,
    index: index ? createHash("sha256").update(index).digest("hex") : null,
  };
}

function sort(records, timeField) {
  return records.slice().sort((left, right) => {
    const leftTime = left[timeField].timestamp;
    const rightTime = right[timeField].timestamp;
    return rightTime - leftTime || (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0);
  });
}

async function collectAll(target, session, searchQuery, pageSize, tick = () => {}) {
  tick();
  let page = projectSearchPage(await target.searchCommits(session, searchQuery, { pageSize }));
  assert.equal(page.coverage.complete, true);
  const rows = [...page.commits];
  while (page.nextCursor) {
    const cursor = page.nextCursor;
    tick();
    page = projectSearchPage(await target.searchCommits(session, searchQuery, { cursor, pageSize }));
    assert.equal(page.coverage.complete, true);
    assert.equal(page.pageOffset, rows.length);
    rows.push(...page.commits);
  }
  assert.equal(new Set(rows.map(row => row.oid)).size, rows.length);
  return rows;
}

async function measure(label, operation) {
  let requests = 0;
  const started = performance.now();
  const result = await operation(() => { requests += 1; });
  const elapsedMs = performance.now() - started;
  // The operation is wrapped below so timings cover all daemon request/response
  // round trips needed to consume the complete query result.
  queryMeasurements.push({ label, resultCount: Array.isArray(result) ? result.length : result.identities.length, elapsedMs, requests });
  return result;
}

async function waitForIndex(target, session, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const response = await target.getMetadataIndexStatus(session);
    const chunk = response.chunks.find(message => message.data.section === "metadataIndex");
    latest = chunk?.data.status;
    assert.ok(latest, "metadata index status section is returned");
    assert.equal(response.completion.coverage.complete, true);
    assert.equal(response.completion.coverage.processed, 1);
    if (predicate(latest)) return latest;
    await delay(50);
  }
  throw new Error(`Timed out waiting for actual project index: ${JSON.stringify(latest)}`);
}
