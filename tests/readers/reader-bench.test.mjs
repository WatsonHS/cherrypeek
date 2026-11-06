import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ReaderBenchClient, runGitOracle } from "../../scripts/reader-bench-client.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const benchPath = resolve(process.env.COMMITSCOPE_READER_BENCH_PATH);
const fixtureRoot = resolve(process.env.COMMITSCOPE_READER_FIXTURE_ROOT);
const largeRepository = resolve(process.env.COMMITSCOPE_READER_LARGE_REPO);
const gitExecutable = resolve(process.env.COMMITSCOPE_READER_GIT_EXECUTABLE);
const tempRoot = resolve(process.env.COMMITSCOPE_READER_TEMP_ROOT);
const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8"));
const largeHead = execFileSync(gitExecutable, ["--no-replace-objects", "-C", largeRepository, "rev-parse", "HEAD"], { encoding: "utf8", env: cleanEnv() }).trim();
const largeCommitCount = Number(execFileSync(gitExecutable, ["--no-replace-objects", "-C", largeRepository, "rev-list", "--count", "HEAD"], { encoding: "utf8", env: cleanEnv() }).trim());
const topology = join(fixtureRoot, "topology");

await Promise.all([access(benchPath), access(largeRepository), access(topology)]);
assert.equal(largeCommitCount, 100_000, "P0-04 must reuse a fixed 100k baseline fixture");

test("CLI and gix return the fixed 200-row page at the head, deep offsets, and the tail", async t => {
  const before = await snapshotTree(largeRepository);
  const offsets = [0, 10_000, 50_000, 90_000, 99_900, 100_000];
  for (const offset of offsets) {
    const oracle = await runGitOracle({
      repository: largeRepository,
      gitExecutable,
      headOid: largeHead,
      operation: "page",
      offset,
      limit: 200,
      oids: [],
    });
    for (const backend of ["cli", "gix"]) {
      const { result, shutdown } = await runJob({
        repository: largeRepository,
        job: pageJob(backend, largeRepository, largeHead, offset, 200),
      });
      assertSuccessfulExit(shutdown);
      assert.equal(result.status, "ok", `${backend} page offset ${offset}: ${result.errorCode ?? result.message}`);
      const expectedVisited = backend === "gix" ? offset + oracle.visitedCount : oracle.visitedCount;
      assert.equal(result.visitedCount, expectedVisited, `${backend} backend-specific visited count at offset ${offset}`);
      assert.equal(result.hasMore, oracle.hasMore, `${backend} hasMore at offset ${offset}`);
      const orderMatches = sameArray(result.oids, oracle.oids);
      if (orderMatches) {
        assert.equal(result.rawBytes, oracle.rawBytes, `${backend} page raw bytes at offset ${offset}`);
        assert.equal(result.objectsDigest, oracle.objectsDigest, `${backend} page objects digest at offset ${offset}`);
      } else {
        t.diagnostic(JSON.stringify({
          semanticGap: "topological sequence differs from independent git rev-list --topo-order",
          backend,
          repository: largeRepository,
          offset,
          limit: 200,
          expectedOidPrefix: oracle.oids.slice(0, 20),
          actualOidPrefix: result.oids.slice(0, 20),
          expectedCount: oracle.oids.length,
          actualCount: result.oids.length,
        }));
        assert.deepEqual([...result.oids].sort(), [...oracle.oids].sort(), `${backend} page commit set at offset ${offset}`);
        assertTopologicalSequence(result.oids, new Map(oracle.objects.map(object => [object.oid, parentsFromRawCommit(object.bytes)])), backend);
        if (backend === "cli") assert.deepEqual(result.oids, oracle.oids);
      }
    }
    if (offset === 99_900) {
      assert.equal(oracle.oids.length, 100);
      assert.equal(oracle.hasMore, false);
    }
    if (offset === 100_000) {
      assert.deepEqual(oracle.oids, []);
      assert.equal(oracle.hasMore, false);
    }
  }
  assert.deepEqual(await snapshotTree(largeRepository), before, "deep reads must not change the 100k baseline fixture");
});

test("topology order is checked against Git; raw object digests include NUL and invalid UTF-8 bytes", async t => {
  const before = await snapshotTree(fixtureRoot);
  const oracle = await runGitOracle({
    repository: topology,
    gitExecutable,
    headOid: manifest.fixtures.topology.headOid,
    operation: "page",
    offset: 0,
    limit: 200,
    oids: [],
  });
  assert.ok(oracle.oids.length >= 8, "topology fixture must include merge and octopus history");
  const expectedParents = new Map(oracle.objects.map(object => [object.oid, parentsFromRawCommit(object.bytes)]));
  for (const backend of ["cli", "gix"]) {
    const { result, shutdown } = await runJob({
      repository: topology,
      job: pageJob(backend, topology, manifest.fixtures.topology.headOid, 0, 200),
    });
    assertSuccessfulExit(shutdown);
    assert.equal(result.status, "ok", `${backend} topology page: ${result.errorCode ?? result.message}`);
    const orderMatches = sameArray(result.oids, oracle.oids);
    if (!orderMatches) {
      t.diagnostic(JSON.stringify({
        semanticGap: "merge/octopus OID sequence differs from independent Git; compare exact output and don't claim compatibility",
        backend,
        expectedOids: oracle.oids,
        actualOids: result.oids,
      }));
    }
    assert.deepEqual([...result.oids].sort(), [...oracle.oids].sort(), `${backend} topology page commit set`);
    assertTopologicalSequence(result.oids, expectedParents, backend);
    if (orderMatches) {
      assert.equal(result.rawBytes, oracle.rawBytes, `${backend} topology raw bytes`);
      assert.equal(result.objectsDigest, oracle.objectsDigest, `${backend} topology objects digest`);
    }
    if (backend === "cli") assert.ok(orderMatches, "CLI sequence must match independent rev-list exactly");
  }

  const mutationRoot = join(tempRoot, "raw-object-repository");
  await cloneShared(topology, mutationRoot);
  const rawCommit = await createBinaryCommit(mutationRoot);
  const rawSnapshot = await snapshotTree(mutationRoot);
  const rawOracle = await runGitOracle({
    repository: mutationRoot,
    gitExecutable,
    headOid: manifest.fixtures.topology.headOid,
    operation: "objects",
    offset: 0,
    limit: 1,
    oids: [rawCommit.oid],
  });
  assert.equal(rawOracle.objects[0].size, rawCommit.payload.length);
  assert.ok(rawOracle.objects[0].bytes.includes(0x00), "fixture object must include NUL in the commit message");
  assert.ok(rawOracle.objects[0].bytes.includes(0xff), "fixture object must include non-UTF-8 bytes");

  for (const backend of ["cli", "gix"]) {
    const { result, shutdown } = await runJob({
      repository: mutationRoot,
      job: {
        backend,
        operation: "objects",
        repository: mutationRoot,
        gitExecutable,
        headOid: manifest.fixtures.topology.headOid,
        offset: 0,
        limit: 1,
        oids: [rawCommit.oid],
      },
    });
    assertSuccessfulExit(shutdown);
    assert.equal(result.status, "ok", `${backend} must read raw NUL/non-UTF-8 commit objects: ${result.errorCode} ${result.message}`);
    assert.equal(result.rawBytes, rawOracle.rawBytes, `${backend} raw byte count`);
    assert.equal(result.objectsDigest, rawOracle.objectsDigest, `${backend} raw object digest`);
  }
  assert.deepEqual(await snapshotTree(mutationRoot), rawSnapshot, "object reads must not mutate the test repository");

  const oversizedRepository = join(tempRoot, "oversized-commit-repository");
  await cloneShared(topology, oversizedRepository);
  const oversized = await createOversizedCommit(oversizedRepository);
  assert.ok(oversized.payload.length > 1024 * 1024, "oversized fixture measures raw bytes, including non-text content");
  const oversizedSnapshot = await snapshotTree(oversizedRepository);
  for (const backend of ["cli", "gix"]) {
    const { result, shutdown } = await runJob({
      repository: oversizedRepository,
      job: {
        backend,
        operation: "objects",
        repository: oversizedRepository,
        gitExecutable,
        headOid: manifest.fixtures.topology.headOid,
        offset: 0,
        limit: 1,
        oids: [oversized.oid],
      },
    });
    assertSuccessfulExit(shutdown);
    assert.equal(result.status, "error", `${backend} must reject a commit object larger than 1 MiB`);
    assert.equal(result.errorCode, "RESOURCE_LIMIT", `${backend} oversized byte limit`);
  }
  assert.deepEqual(await snapshotTree(oversizedRepository), oversizedSnapshot, "oversized-object failures must stay read-only");
  assert.deepEqual(await snapshotTree(fixtureRoot), before, "reader checks must not mutate generated source fixtures");
});

test("reader compatibility matrix is read-only and isolated from environment, replace refs, and helpers", async t => {
  const before = await snapshotTree(fixtureRoot);
  const cases = [
    ["bare", manifest.fixtures.bare],
    ["linkedWorktree", manifest.fixtures.linkedWorktree],
    ["shallow", manifest.fixtures.shallow],
    ["sha256", manifest.fixtures.sha256],
  ];
  for (const [name, fixture] of cases) {
    if (name === "sha256" && fixture.supported === false) {
      t.diagnostic(`capability gap: system Git cannot create SHA-256 fixture (${fixture.reason})`);
      continue;
    }
    const repository = join(fixtureRoot, fixture.path);
    const oracle = await runGitOracle({
      repository,
      gitExecutable,
      headOid: fixture.headOid,
      operation: "page",
      offset: 0,
      limit: 20,
      oids: [],
    });
    const parents = new Map(oracle.objects.map(object => [object.oid, parentsFromRawCommit(object.bytes)]));
    for (const backend of ["cli", "gix"]) {
      const { result, shutdown } = await runJob({
        repository,
        job: pageJob(backend, repository, fixture.headOid, 0, 20),
      });
      assertSuccessfulExit(shutdown);
      if (result.status !== "ok") {
        t.diagnostic(JSON.stringify({ semanticGap: `${backend} cannot read ${name}`, code: result.errorCode, message: result.message }));
        if (backend === "cli") assert.fail(`CLI must read ${name}: ${result.errorCode} ${result.message}`);
        if (name !== "shallow" || result.errorCode !== "UNSUPPORTED_SHALLOW") {
          assert.fail(`Unexpected gix ${name} failure: ${result.errorCode} ${result.message}`);
        }
      } else {
        assert.equal(result.oids[0], fixture.headOid, `${backend} ${name} starts at the fixed HEAD`);
        if (!sameArray(result.oids, oracle.oids)) {
          t.diagnostic(JSON.stringify({ semanticGap: `${backend} ${name} page differs from independent Git`, expected: oracle.oids, actual: result.oids }));
          assert.deepEqual([...result.oids].sort(), [...oracle.oids].sort(), `${backend} ${name} commit set`);
          if (backend === "cli") assert.deepEqual(result.oids, oracle.oids);
        } else {
          assert.equal(result.rawBytes, oracle.rawBytes, `${backend} ${name} raw bytes`);
          assert.equal(result.objectsDigest, oracle.objectsDigest, `${backend} ${name} objects digest`);
        }
        assertTopologicalSequence(result.oids, parents, backend);
        assert.equal(result.hasMore, oracle.hasMore, `${backend} ${name} hasMore respects shallow/repository boundary`);
        if (name === "sha256") assert.equal(result.oids[0].length, 64);
      }
    }
  }

  const pollutedEnv = {
    ...process.env,
    GIT_DIR: join(tempRoot, "does-not-exist.git"),
    GIT_WORK_TREE: join(tempRoot, "wrong-worktree"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  };
  const cleanOracle = await runGitOracle({
    repository: topology,
    gitExecutable,
    headOid: manifest.fixtures.topology.headOid,
    operation: "page",
    offset: 0,
    limit: 20,
    oids: [],
  });
  const cleanByBackend = new Map();
  for (const backend of ["cli", "gix"]) {
    const baseline = await runJob({
      repository: topology,
      job: pageJob(backend, topology, manifest.fixtures.topology.headOid, 0, 20),
    });
    assertSuccessfulExit(baseline.shutdown);
    assert.equal(baseline.result.status, "ok", `${backend} clean baseline: ${baseline.result.message}`);
    cleanByBackend.set(backend, baseline.result);
    if (sameArray(baseline.result.oids, cleanOracle.oids)) {
      assert.equal(baseline.result.rawBytes, cleanOracle.rawBytes, `${backend} clean baseline raw bytes`);
      assert.equal(baseline.result.objectsDigest, cleanOracle.objectsDigest, `${backend} clean baseline object digest`);
    }
    if (backend === "cli") assert.deepEqual(baseline.result.oids, cleanOracle.oids, "CLI clean baseline matches independent Git");

    const { result, shutdown } = await runJob({
      repository: topology,
      env: pollutedEnv,
      job: pageJob(backend, topology, manifest.fixtures.topology.headOid, 0, 20),
    });
    assertSuccessfulExit(shutdown);
    assert.equal(result.status, "ok", `${backend} must ignore inherited GIT_*: ${result.message}`);
    assert.deepEqual(result.oids, baseline.result.oids, `${backend} inherited GIT_* must not change its clean OID sequence`);
    assert.equal(result.objectsDigest, baseline.result.objectsDigest, `${backend} inherited GIT_* must not change its clean object digest`);
  }

  const replaceRepository = join(tempRoot, "replace-ref-repository");
  await cloneShared(topology, replaceRepository);
  execFileSync(gitExecutable, ["-C", replaceRepository, "replace", manifest.fixtures.topology.headOid, oracleSecondOid(cleanOracle)]);
  const replaceSnapshot = await snapshotTree(replaceRepository);
  for (const backend of ["cli", "gix"]) {
    const { result, shutdown } = await runJob({
      repository: replaceRepository,
      job: pageJob(backend, replaceRepository, manifest.fixtures.topology.headOid, 0, 20),
    });
    assertSuccessfulExit(shutdown);
    assert.equal(result.status, "ok", `${backend} replace-ref page: ${result.message}`);
    assert.deepEqual(result.oids, cleanByBackend.get(backend).oids, `${backend} replace ref must not change its clean OID sequence`);
    assert.equal(result.objectsDigest, cleanByBackend.get(backend).objectsDigest, `${backend} replace ref must not change its clean object digest`);
  }
  assert.deepEqual(await snapshotTree(replaceRepository), replaceSnapshot, "reader must not modify replace refs");

  const helperDirectory = join(tempRoot, "external-helper");
  const sentinel = join(tempRoot, "external-helper-was-run");
  await mkdir(helperDirectory, { recursive: true });
  const helper = join(helperDirectory, "git-remote-sentinel");
  await writeFile(helper, `#!/bin/sh\nprintf invoked >> '${sentinel}'\nexit 1\n`, { mode: 0o700 });
  const helperEnv = {
    ...process.env,
    PATH: `${helperDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    GIT_ALLOW_PROTOCOL: "sentinel",
  };
  const missing = manifest.fixtures.missingPromisor;
  const missingRepository = join(fixtureRoot, missing.path);
  for (const backend of ["cli", "gix"]) {
    const { result, shutdown } = await runJob({
      repository: missingRepository,
      env: helperEnv,
      job: pageJob(backend, missingRepository, missing.headOid, 0, 20),
    });
    assertSuccessfulExit(shutdown);
    if (result.status !== "ok") {
      t.diagnostic(JSON.stringify({ semanticGap: `${backend} missing-object behavior`, code: result.errorCode, message: result.message }));
      assert.ok(result.errorCode, `${backend} must report a stable missing-object failure`);
      assert.equal(result.errorCode, "MISSING_OBJECT", `${backend} must classify the missing object`);
    } else {
      assert.fail(`${backend} must report missing objects instead of a partial successful page`);
    }
    await assertPathAbsent(sentinel, `${backend} must not invoke configured external remote helper`);
  }
  assert.deepEqual(await snapshotTree(fixtureRoot), before, "compatibility reads must preserve fixtures and commonDir contents");
});

test("scan cancellation is observed and both reader process trees exit normally", async () => {
  const before = await snapshotTree(largeRepository);
  for (const backend of ["cli", "gix"]) {
    const client = await ReaderBenchClient.launch(benchPath, { cwd: largeRepository, env: cleanEnv(), sampleIntervalMs: 100 });
    let hasResult = false;
    try {
      await client.sendJob({
        backend,
        operation: "scan",
        repository: largeRepository,
        gitExecutable,
        headOid: largeHead,
        offset: 0,
        limit: 200,
        oids: [],
      });
      await client.waitForStarted();
      await delay(10);
      client.sendCancel();
      const result = await client.waitForResult();
      hasResult = true;
      assert.equal(result.status, "cancelled", `${backend} scan must observe cancellation, got ${result.status}/${result.errorCode}`);
      const shutdown = await client.shutdownAfterResult();
      assertSuccessfulExit(shutdown);
      assert.ok(Number.isFinite(result.totalMs) && result.totalMs >= 0);
      assert.ok(Number.isInteger(result.completedScans) && result.completedScans >= 0, `${backend} cancelled scan must report completedScans >= 0`);
      assert.ok(Number.isInteger(result.visitedCount) && result.visitedCount >= 0, `${backend} cancelled scan must report visitedCount >= 0`);
      assert.ok(Number.isFinite(shutdown.cancelToResultMs) && shutdown.cancelToResultMs >= 0);
      assert.ok(shutdown.sampler.samples.length > 0, "the tree sampler must observe the running reader");
    } finally {
      if (!hasResult) await client.cancelAndReap();
    }
  }
  assert.deepEqual(await snapshotTree(largeRepository), before, "cancelled scans must leave the 100k fixture unchanged");
});

function pageJob(backend, repository, headOid, offset, limit) {
  return { backend, operation: "page", repository, gitExecutable, headOid, offset, limit, oids: [] };
}

async function runJob({ repository, job, env = cleanEnv() }) {
  const client = await ReaderBenchClient.launch(benchPath, { cwd: repository, env, sampleIntervalMs: 100 });
  let hasResult = false;
  try {
    await client.sendJob(job);
    await client.waitForStarted();
    const result = await client.waitForResult();
    const shutdown = await client.shutdownAfterResult();
    hasResult = true;
    return { result, shutdown };
  } finally {
    if (!hasResult) await client.cancelAndReap();
  }
}

function assertSuccessfulExit(shutdown) {
  assert.equal(shutdown.exitResult?.code, 0, `reader process exit: ${JSON.stringify(shutdown.exitResult)}`);
  assert.equal(shutdown.exitResult?.signal, null);
  assert.equal(shutdown.normalExit, true, "normal exit requires the reader and every sampled descendant to exit without forced cleanup");
  assert.equal(shutdown.forcedCleanup, false, "successful test jobs must not require forced cleanup");
  assert.equal(shutdown.processExit.allExited, true, `reader descendants still live: ${JSON.stringify(shutdown.processExit.live)}`);
}

function cloneShared(source, target) {
  execFileSync(gitExecutable, ["clone", "--quiet", "--shared", "--no-hardlinks", source, target], { timeout: 30_000 });
}

async function createBinaryCommit(repository) {
  const tree = execFileSync(gitExecutable, ["-C", repository, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const prefix = Buffer.from(`tree ${tree}\nauthor Binary Fixture <binary@example.invalid> 1700000000 +0000\ncommitter Binary Fixture <binary@example.invalid> 1700000000 +0000\n\nraw bytes: `, "utf8");
  const payload = Buffer.concat([prefix, Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x42])]);
  const oid = execFileSync(gitExecutable, ["-C", repository, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"], { input: payload, encoding: "utf8" }).trim();
  const stored = execFileSync(gitExecutable, ["-C", repository, "cat-file", "commit", oid], { encoding: "buffer" });
  assert.deepEqual(stored, payload, "Git must store the exact NUL / non-UTF-8 commit bytes");
  return { oid, payload };
}

async function createOversizedCommit(repository) {
  const tree = execFileSync(gitExecutable, ["-C", repository, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const prefix = Buffer.from(`tree ${tree}\nauthor Large Fixture <large@example.invalid> 1700000000 +0000\ncommitter Large Fixture <large@example.invalid> 1700000000 +0000\n\n`, "utf8");
  const unicodeMessage = "中".repeat(400_000);
  const payload = Buffer.concat([prefix, Buffer.from(unicodeMessage, "utf8"), Buffer.from([0xff])]);
  const oid = execFileSync(gitExecutable, ["-C", repository, "hash-object", "-t", "commit", "-w", "--stdin"], { input: payload, encoding: "utf8" }).trim();
  assert.equal(Number(execFileSync(gitExecutable, ["-C", repository, "cat-file", "-s", oid], { encoding: "utf8" }).trim()), payload.length);
  assert.ok(unicodeMessage.length < 1024 * 1024 && payload.length > 1024 * 1024, "a sub-1 MiB character count must exceed the raw object-byte limit");
  return { oid, payload };
}

function parentsFromRawCommit(bytes) {
  const headerEnd = bytes.indexOf(Buffer.from("\n\n"));
  assert.ok(headerEnd >= 0, "raw commit must contain a header/message boundary");
  return bytes.subarray(0, headerEnd).toString("ascii").split("\n")
    .filter(line => line.startsWith("parent "))
    .map(line => line.slice("parent ".length));
}

function assertTopologicalSequence(oids, parentsByOid, backend) {
  const positions = new Map(oids.map((oid, index) => [oid, index]));
  for (const oid of oids) {
    const childPosition = positions.get(oid);
    for (const parent of parentsByOid.get(oid) ?? []) {
      const parentPosition = positions.get(parent);
      if (parentPosition !== undefined) {
        assert.ok(childPosition < parentPosition, `${backend} order must place child ${oid} before parent ${parent}`);
      }
    }
  }
}

function oracleSecondOid(oracle) {
  assert.ok(oracle.oids.length > 1, "replace-ref test needs a distinct replacement commit");
  return oracle.oids[1];
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function assertPathAbsent(path, message) {
  try { await access(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  assert.fail(message);
}
