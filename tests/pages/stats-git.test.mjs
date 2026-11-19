import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  PagesDaemonClient,
  createDaemonEnvironment,
  projectSession,
} from "./daemon-client.mjs";
import { git } from "./fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";
export const query = {
  message: "",
  caseSensitive: false,
  authors: [],
  committers: [],
  oidPrefix: "",
  timeField: "author",
  fromTimestamp: null,
  toTimestamp: null,
  timeZone: "America/New_York",
  path: null,
};
export async function indexed(t, label, setup) {
  const base = join(
      dirname(process.env.COMMITSCOPE_PAGES_DATA_ROOT),
      "stats",
      label,
    ),
    repo = join(base, "repo");
  await mkdir(base, { recursive: true });
  await git(base, ["init", "-q", "-b", "main", repo]);
  await setup(repo);
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: repo,
    env: createDaemonEnvironment(join(base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
    }),
  });
  await client.start();
  client.session = projectSession(await client.open(repo));
  await client.readPage(client.session);
  t.after(() => client.stop());
  for (let n = 0; n < 1200; n++) {
    const s = (await client.call("getMetadataIndexStatus", {})).chunks[0].data
      .status;
    if (s.state === "complete") break;
    if (["failed", "quotaLimited", "unavailable"].includes(s.state))
      throw Error(JSON.stringify(s));
    if (n === 1199) throw Error("index timed out");
    await delay(50);
  }
  return { base, repo, client };
}
export async function commit(
  repo,
  name,
  text,
  time,
  message,
  author = "Alice",
) {
  await writeFile(join(repo, name), text);
  await git(repo, ["add", "--", name]);
  await git(repo, ["commit", "-qm", message], {
    env: {
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author}@example.test`,
      GIT_AUTHOR_DATE: `@${time} +0000`,
      GIT_COMMITTER_NAME: "Integrator",
      GIT_COMMITTER_EMAIL: "ci@example.test",
      GIT_COMMITTER_DATE: `@${time + 60} +0000`,
    },
  });
  return git(repo, ["rev-parse", "HEAD"]);
}
test("P6-01 activity matches independent Git across DST, unordered times and shared branches", async (t) => {
  const start = Date.parse("2024-03-10T05:00:00Z") / 1000,
    end = Date.parse("2024-03-11T04:00:00Z") / 1000;
  const f = await indexed(t, "activity", async (repo) => {
    await commit(repo, "a", "one\n", start - 300, "docs: previous");
    await commit(repo, "a", "two\n", start + 7200, "feat(core): after DST");
    await commit(repo, "b", "three\n", start + 3600, "fix: before DST", "Bob");
    await commit(
      repo,
      "b",
      "four\n",
      start + 3700,
      "fixup! fix: before DST",
      "Bob",
    );
    await git(repo, ["branch", "shared"]);
  });
  const before = await snapshotTree(f.repo);
  const params = {
    query,
    range: { startUnix: start, endUnix: end },
    bucket: "hour",
  };
  const stats = (await f.client.call("getActivityOverview", params)).chunks[0]
    .data.stats;
  const log = (
    await git(f.repo, ["log", "--format=%H%x09%at%x09%an%x09%ae%x09%s"])
  )
    .split("\n")
    .map((l) => l.split("\t"));
  const selected = log.filter((r) => +r[1] >= start && +r[1] < end);
  assert.equal(stats.coverage.complete, true);
  assert.equal(stats.totals.commits, selected.length);
  assert.equal(stats.previousTotals.commits, 1);
  assert.equal(stats.buckets.length, 23);
  assert.equal(stats.weekHour[6][1], 2);
  assert.equal(stats.weekHour[6][2], 0);
  assert.equal(stats.weekHour[6][3], 1);
  assert.equal(stats.authors.find((a) => a.name === "Bob").count, 2);
  assert.equal(stats.fixupCount, 1);
  assert.equal(stats.types.find((t) => t.prefix === "feat").count, 1);
  assert.equal(
    stats.branches.find((b) => b.refName === "refs/heads/shared").count,
    3,
  );
  assert.equal(
    stats.branches.find((b) => b.refName === "refs/heads/shared").complete,
    true,
  );
  assert.deepEqual(
    stats.sessions.map((s) => s.count),
    [2, 1],
  );
  const committer = (
    await f.client.call("getActivityOverview", {
      ...params,
      query: {
        ...query,
        timeField: "committer",
        authors: [{ name: "Bob", email: "Bob@example.test" }],
      },
    })
  ).chunks[0].data.stats;
  assert.equal(committer.totals.commits, 2);
  assert.deepEqual(await snapshotTree(f.repo), before);
});

import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
async function database(path) {
  for (const e of await readdir(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.name === "index.sqlite3") return p;
    if (e.isDirectory()) {
      const found = await database(p);
      if (found) return found;
    }
  }
}
function numstats(bytes) {
  const fields = bytes.toString("latin1").split("\0");
  const result = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const a = fields[i].indexOf("\t"),
      b = fields[i].indexOf("\t", a + 1);
    assert.ok(a > 0 && b > a);
    const add = fields[i].slice(0, a),
      del = fields[i].slice(a + 1, b);
    let path = fields[i].slice(b + 1),
      old = null;
    if (!path) {
      old = fields[++i];
      path = fields[++i];
    }
    result.push({
      path: Buffer.from(path, "latin1").toString("hex"),
      old: old === null ? null : Buffer.from(old, "latin1").toString("hex"),
      add: add === "-" ? null : +add,
      del: del === "-" ? null : +del,
      binary: add === "-",
    });
  }
  return result;
}
test("P6-02 indexed file changes match independent first-parent Git including root, merge, rename, binary and raw paths; schema 1 resumes", async (t) => {
  const f = await indexed(t, "changes", async (repo) => {
    await commit(repo, "old.txt", "first\nsecond\n", 1700000000, "feat: root");
    await git(repo, ["mv", "old.txt", "new.txt"]);
    await commit(
      repo,
      "binary.bin",
      Buffer.from([0, 1, 2]),
      1700000200,
      "feat: rename and binary",
    );
    await git(repo, ["switch", "-qc", "side"]);
    await commit(repo, "side.txt", "side\n", 1700000300, "feat: side");
    await git(repo, ["switch", "-q", "main"]);
    await commit(repo, "main.txt", "main\n", 1700000400, "feat: main");
    await git(repo, [
      "-c",
      "user.name=Merge",
      "-c",
      "user.email=m@m",
      "merge",
      "--no-ff",
      "--no-edit",
      "side",
    ]);
    const blob = await git(repo, ["hash-object", "-w", "--stdin"], {
      input: Buffer.from("raw\n"),
    });
    const raw = Buffer.from([0x72, 0x61, 0x77, 0xff]);
    await git(repo, ["update-index", "-z", "--index-info"], {
      input: Buffer.concat([
        Buffer.from(`100644 ${blob}\t`),
        raw,
        Buffer.from([0]),
      ]),
    });
    await git(repo, [
      "-c",
      "user.name=X",
      "-c",
      "user.email=x@x",
      "commit",
      "-qm",
      "raw",
    ]);
  });
  const path = await database(join(f.base, "data"));
  let db = new DatabaseSync(path, { readOnly: true });
  let metadata;
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    metadata = db
      .prepare("SELECT oid,message,parents_json FROM commits ORDER BY oid")
      .all();
    for (const c of metadata) {
      const parents = JSON.parse(c.parents_json);
      const args = [
        "diff-tree",
        "--no-commit-id",
        "--numstat",
        "-z",
        "-r",
        "-M",
        ...(parents.length ? [parents[0], c.oid] : ["--root", c.oid]),
        "--",
      ];
      const expected = numstats(await git(f.repo, args, { binary: true }));
      const rows = db
        .prepare(
          "SELECT path,old_path,additions,deletions,binary FROM commit_changes WHERE oid=? ORDER BY ordinal",
        )
        .all(c.oid)
        .map((r) => ({
          path: Buffer.from(r.path).toString("hex"),
          old:
            r.old_path === null
              ? null
              : Buffer.from(r.old_path).toString("hex"),
          add: r.additions,
          del: r.deletions,
          binary: !!r.binary,
        }));
      assert.deepEqual(rows, expected, c.oid);
    }
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM commits WHERE changes_complete=0")
        .get().n,
      0,
    );
    const all = (
      await f.client.call("getChangeStats", {
        query: { ...query, timeZone: "UTC" },
        range: {
          startUnix: 1700000000,
          endUnix: Math.floor(Date.now() / 1000) + 60,
        },
        bucket: "month",
        directoryPrefix: "",
      })
    ).chunks[0].data.stats;
    const nonMerges = metadata.filter(
      (c) => JSON.parse(c.parents_json).length < 2,
    );
    let added = 0,
      deleted = 0,
      fileCount = 0;
    for (const c of nonMerges) {
      const parents = JSON.parse(c.parents_json);
      for (const row of numstats(
        await git(
          f.repo,
          [
            "diff-tree",
            "--no-commit-id",
            "--numstat",
            "-z",
            "-r",
            "-M",
            ...(parents.length ? [parents[0], c.oid] : ["--root", c.oid]),
            "--",
          ],
          { binary: true },
        ),
      )) {
        added += row.add ?? 0;
        deleted += row.del ?? 0;
        fileCount++;
      }
    }
    assert.deepEqual(
      [all.totals.additions, all.totals.deletions, all.totals.filesChanged],
      [added, deleted, fileCount],
    );
    assert.equal(all.excluded.mergeCommits, metadata.length - nonMerges.length);
  } finally {
    db.close();
  }
  await f.client.stop();
  db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE commit_path_changes; DROP TABLE commit_changes; ALTER TABLE commits DROP COLUMN changes_complete; PRAGMA user_version=1;",
  );
  db.close();
  const before = await snapshotTree(f.repo);
  const next = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(join(f.base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
    }),
  });
  await next.start();
  t.after(() => next.stop());
  next.session = projectSession(await next.open(f.repo));
  await next.readPage(next.session);
  let status;
  for (let n = 0; n < 500; n++) {
    status = (await next.call("getMetadataIndexStatus", {})).chunks[0].data
      .status;
    if (status.state === "complete") break;
    if (status.state === "failed") throw Error(JSON.stringify(status));
    await delay(30);
  }
  assert.equal(status.state, "complete");
  db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare("SELECT oid,message,parents_json FROM commits ORDER BY oid")
        .all(),
      metadata,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM commits WHERE changes_complete=0")
        .get().n,
      0,
    );
    assert.ok(
      db.prepare("SELECT count(*) AS n FROM commit_changes").get().n > 0,
    );
  } finally {
    db.close();
  }
  assert.deepEqual(await snapshotTree(f.repo), before);
});

test("P6-03 P6-04 change totals, exclusions, hotspots and notable commit lists match independent Git", async (t) => {
  const f = await indexed(t, "aggregates", async (repo) => {
    await mkdir(join(repo, "src"));
    await mkdir(join(repo, "tests"));
    await mkdir(join(repo, "docs"));
    await commit(repo, "src/a.rs", "one\ntwo\n", 1700000000, "feat: code");
    await writeFile(join(repo, "src/b.rs"), "other\n");
    await writeFile(join(repo, "src/a.rs"), "one\nchanged\n");
    await git(repo, ["add", "."]);
    await commit(
      repo,
      "tests/a.test.rs",
      "test\n",
      1700000100,
      "test: add test",
    );
    await writeFile(join(repo, "src/a.rs"), "one\nchanged\nthree\n");
    await writeFile(join(repo, "src/b.rs"), "other\nmore\n");
    await git(repo, ["add", "."]);
    await commit(
      repo,
      "Cargo.lock",
      "lock\n".repeat(100),
      1700000200,
      "chore: lock",
      "Bob",
    );
    await commit(repo, "docs/readme.md", "docs\n", 1700000300, "docs: readme");
  });
  const before = await snapshotTree(f.repo);
  const params = {
    query: { ...query, timeZone: "UTC" },
    range: { startUnix: 1699999900, endUnix: 1700001000 },
    bucket: "tenMinutes",
    directoryPrefix: "",
  };
  const stats = (await f.client.call("getChangeStats", params)).chunks[0].data
    .stats;
  const oids = (await git(f.repo, ["rev-list", "HEAD"])).split("\n");
  let additions = 0,
    deletions = 0,
    files = 0,
    excluded = 0;
  for (const oid of oids) {
    const ps = (await git(f.repo, ["rev-list", "--parents", "-1", oid]))
      .split(" ")
      .slice(1);
    for (const c of numstats(
      await git(
        f.repo,
        [
          "diff-tree",
          "--no-commit-id",
          "--numstat",
          "-z",
          "-r",
          "-M",
          ...(ps.length ? [ps[0], oid] : ["--root", oid]),
        ],
        { binary: true },
      ),
    )) {
      files++;
      if (Buffer.from(c.path, "hex").toString() === "Cargo.lock")
        excluded += (c.add ?? 0) + (c.del ?? 0);
      else {
        additions += c.add ?? 0;
        deletions += c.del ?? 0;
      }
    }
  }
  assert.deepEqual(
    [
      stats.totals.additions,
      stats.totals.deletions,
      stats.totals.filesChanged,
      stats.excluded.lines,
    ],
    [additions, deletions, files, excluded],
  );
  assert.equal(stats.coverage.complete, true);
  assert.equal(stats.kinds.test, 1);
  assert.equal(stats.kinds.docs, 1);
  assert.equal(stats.buckets.at(-1).netGrowth, additions - deletions);
  assert.equal(stats.files[0].path.display, "src/a.rs");
  const notable = (
    await f.client.call("getNotableStats", {
      query: params.query,
      range: params.range,
      bucket: params.bucket,
    })
  ).chunks[0].data.stats;
  const pair = notable.pairs.find(
    (p) => p.a.display === "src/a.rs" && p.b.display === "src/b.rs",
  );
  assert.equal(pair.together, 2);
  assert.equal(
    notable.churnFiles.find((p) => p.path.display === "src/a.rs").commits,
    3,
  );
  assert.equal(notable.untested.count, 2);
  assert.equal(notable.untested.total, 3);
  const page = (
    await f.client.call("getStatsCommits", {
      query: params.query,
      range: params.range,
      selection: { kind: "pair", aHex: pair.a.rawHex, bHex: pair.b.rawHex },
      offset: 0,
      limit: 1,
    })
  ).chunks[0].data.page;
  assert.equal(page.total, 2);
  assert.equal(page.commits.length, 1);
  assert.equal(page.nextOffset, 1);
  const pathFiltered = (
    await f.client.call("getActivityOverview", {
      query: {
        ...params.query,
        path: {
          rawHex: Buffer.from("src/a.rs").toString("hex"),
          kind: "file",
          includeDescendants: false,
        },
      },
      range: params.range,
      bucket: params.bucket,
    })
  ).chunks[0].data.stats;
  assert.equal(pathFiltered.totals.commits, 3);
  const defaults = (await f.client.call("getStatsExclusions", {})).chunks[0]
    .data.result;
  assert.ok(defaults.patterns.includes("Cargo.lock"));
  await f.client.call("setStatsExclusions", { patterns: [] });
  assert.deepEqual(
    (await f.client.call("getStatsExclusions", {})).chunks[0].data.result
      .patterns,
    [],
  );
  const included = (await f.client.call("getChangeStats", params)).chunks[0]
    .data.stats;
  assert.equal(included.totals.additions, additions + 100);
  assert.equal(included.excluded.lines, 0);
  assert.deepEqual(await snapshotTree(f.repo), before);
});

import { access, rm } from "node:fs/promises";
function porcelainLines(text) {
  const lines = [];
  let oid, author, email, time;
  for (const line of text.split("\n")) {
    const header = line.match(/^([0-9a-f]+) \d+ \d+(?: \d+)?$/);
    if (header) {
      oid = header[1];
    } else if (line.startsWith("author ")) {
      author = line.slice(7);
    } else if (line.startsWith("author-mail ")) {
      email = line.slice(13).replace(/^<|>$/g, "");
    } else if (line.startsWith("author-time ")) {
      time = +line.slice(12);
    } else if (line.startsWith("\t")) {
      lines.push({ oid, author, email, time });
    }
  }
  return lines;
}
test("P6-05 evolution agrees with independent blame, reports skipped files and reuses cached files", async (t) => {
  const f = await indexed(t, "evolution", async (repo) => {
    await commit(repo, "old.txt", "one\ntwo\n", 1700000000, "feat: original");
    await commit(
      repo,
      "old.txt",
      "changed\ntwo\nthree\n",
      1700000100,
      "fix: edit",
      "Bob",
    );
    await git(repo, ["mv", "old.txt", "new.txt"]);
    await commit(repo, "empty.txt", "", 1700000200, "refactor: rename");
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1]));
    await writeFile(join(repo, "large.txt"), "x\n".repeat(20001));
    await writeFile(join(repo, "Cargo.lock"), "lock\n");
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=X",
      "-c",
      "user.email=x@x",
      "commit",
      "-qm",
      "skips",
    ]);
  });
  const oid = await git(f.repo, ["rev-parse", "HEAD"]);
  const p = {
    commit: oid,
    pathHex: "",
    range: { startUnix: 1699999999, endUnix: 1700000300 },
  };
  const before = await snapshotTree(f.repo);
  const estimate = (await f.client.call("estimateEvolution", p)).chunks[0].data
    .estimate;
  assert.equal(estimate.files, 2);
  assert.equal(estimate.lines, 3);
  assert.deepEqual(estimate.skipped.map((s) => s.reason).sort(), [
    "binary",
    "excluded",
    "lineLimit",
  ]);
  const response = await f.client.call("analyzeEvolution", p);
  const result = response.chunks.at(-1).data.chunk.result;
  assert.equal(result.complete, true);
  assert.deepEqual(result.covered, { files: 2, lines: 3 });
  assert.equal(response.chunks.filter((c) => c.done).length, 1);
  const oracle = porcelainLines(
    await git(f.repo, [
      "blame",
      "--line-porcelain",
      "--no-textconv",
      oid,
      "--",
      "new.txt",
    ]),
  );
  const ownership = new Map();
  const age = {
    within7d: 0,
    within30d: 0,
    within90d: 0,
    within1y: 0,
    older: 0,
  };
  for (const line of oracle) {
    const key = `${line.author}<${line.email}>`;
    ownership.set(key, (ownership.get(key) ?? 0) + 1);
    const days = (result.asOfUnix - line.time) / 86400;
    age[
      days < 7
        ? "within7d"
        : days < 30
          ? "within30d"
          : days < 90
            ? "within90d"
            : days < 365
              ? "within1y"
              : "older"
    ]++;
  }
  assert.deepEqual(
    new Map(
      result.ownership.map((o) => [
        `${o.author.name}<${o.author.email}>`,
        o.lines,
      ]),
    ),
    ownership,
  );
  assert.deepEqual(result.age, age);
  assert.equal(
    result.survival.weeks.reduce((s, w) => s + w.kept, 0),
    oracle.filter(
      (l) => l.time >= p.range.startUnix && l.time < p.range.endUnix,
    ).length,
  );
  assert.equal(
    result.survival.weeks.reduce((s, w) => s + w.added, 0),
    4,
  );
  assert.equal(result.survival.coverage.complete, true);
  await f.client.stop();
  const gate = process.env.COMMITSCOPE_PAGES_GATE_FILE,
    started = process.env.COMMITSCOPE_PAGES_GATE_STARTED;
  await rm(started, { force: true });
  await writeFile(gate, "blame");
  const cached = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(join(f.base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
      PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
      COMMITSCOPE_PAGES_GATE_FILE: gate,
      COMMITSCOPE_PAGES_GATE_STARTED: started,
    }),
  });
  t.after(async () => {
    await rm(gate, { force: true });
    await cached.stop();
  });
  await cached.start();
  cached.session = projectSession(await cached.open(f.repo));
  const again = (await cached.call("analyzeEvolution", p, 10000)).chunks.at(-1)
    .data.chunk.result;
  assert.deepEqual(again.ownership, result.ownership);
  assert.deepEqual(again.survival, result.survival);
  await assert.rejects(access(started));
  await rm(gate, { force: true });
  assert.deepEqual(await snapshotTree(f.repo), before);
});

test("P6-05 cancellation and generation replacement reap blame while retaining completed-file progress", async (t) => {
  const f = await indexed(t, "evolution-cancel", async (repo) => {
    await commit(repo, "a.txt", "a\n", 1700000000, "feat: a");
    await commit(repo, "b.txt", "b\n", 1700000100, "feat: b");
  });
  const oid = await git(f.repo, ["rev-parse", "HEAD"]);
  await f.client.blame(oid, Buffer.from("a.txt").toString("hex"));
  await f.client.stop();
  const gate = process.env.COMMITSCOPE_PAGES_GATE_FILE,
    started = process.env.COMMITSCOPE_PAGES_GATE_STARTED;
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(join(f.base, "data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
      PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
      COMMITSCOPE_PAGES_GATE_FILE: gate,
      COMMITSCOPE_PAGES_GATE_STARTED: started,
    }),
  });
  t.after(async () => {
    await rm(gate, { force: true });
    await client.stop();
  });
  await client.start();
  client.session = projectSession(await client.open(f.repo));
  for (const preempt of [false, true]) {
    await rm(started, { force: true });
    await writeFile(gate, "blame");
    const seen = [];
    const job = client.begin(
      "analyzeEvolution",
      { commit: oid, pathHex: "", range: null },
      30000,
      (m) => {
        seen.push(m);
      },
    );
    const failed = assert.rejects(job.result, (e) => e.code === "CANCELLED");
    let pid;
    for (let n = 0; n < 500; n++) {
      try {
        pid = +(await readFile(started, "utf8"));
        break;
      } catch {}
      await delay(10);
    }
    assert.ok(pid, "second uncached blame started");
    const at = Date.now();
    if (preempt) {
      client.session = projectSession(await client.refresh(client.session));
    } else {
      client.cancel(job.requestId);
    }
    await failed;
    assert.ok(seen.some((m) => m.data.chunk.result.covered.files === 1));
    for (let n = 0; n < 200; n++) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") break;
        throw e;
      }
      await delay(10);
    }
    assert.throws(
      () => process.kill(pid, 0),
      (e) => e.code === "ESRCH",
    );
    assert.ok(Date.now() - at < 5000);
    await rm(gate, { force: true });
  }
});

test("P6-01 repeated DST hour is counted in separate buckets and partial coverage remains explicit", async (t) => {
  const start = Date.parse("2024-11-03T04:00:00Z") / 1000,
    end = Date.parse("2024-11-04T05:00:00Z") / 1000;
  const f = await indexed(t, "fall-back", async (repo) => {
    await commit(repo, "a", "a\n", start + 3600, "feat: first hour");
    await commit(repo, "a", "b\n", start + 7200, "feat: second hour");
  });
  const p = {
    query,
    range: { startUnix: start, endUnix: end },
    bucket: "hour",
  };
  const stats = (await f.client.call("getActivityOverview", p)).chunks[0].data
    .stats;
  assert.equal(stats.buckets.length, 25);
  assert.equal(stats.weekHour[6][1], 2);
  assert.deepEqual(
    stats.buckets.filter((b) => b.count).map((b) => b.startUnix),
    [start + 3600, start + 7200],
  );
  await f.client.stop();
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: f.repo,
    env: createDaemonEnvironment(join(f.base, "empty-data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
    }),
  });
  t.after(() => client.stop());
  await client.start();
  client.session = projectSession(await client.open(f.repo));
  const partial = (await client.call("getActivityOverview", p)).chunks[0].data
    .stats;
  assert.deepEqual(partial.coverage, { processed: 0, complete: false });
  assert.equal(partial.totals.commits, 0);
  assert.equal("total" in partial.coverage, false);
});

test("P6-02 shallow file coverage completes after deepening and refreshing the same cache", async (t) => {
  const f = await indexed(t, "shallow-changes", async (repo) => {
    for (let i = 0; i < 3; i++)
      await commit(repo, "a.txt", `${i}\n`, 1700000000 + i, `change ${i}`);
  });
  const repo = join(f.base, "shallow");
  await git(f.base, [
    "clone",
    "-q",
    "--depth",
    "2",
    pathToFileURL(f.repo).href,
    repo,
  ]);
  const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
    cwd: repo,
    env: createDaemonEnvironment(join(f.base, "shallow-data"), {
      HOME: process.env.COMMITSCOPE_PAGES_HOME,
    }),
  });
  t.after(() => client.stop());
  await client.start();
  client.session = projectSession(await client.open(repo));
  const params = {
    query: { ...query, timeZone: "UTC" },
    range: { startUnix: 1699999900, endUnix: 1700000100 },
    bucket: "day",
    directoryPrefix: "",
  };
  async function completeIndex() {
    await client.readPage(client.session);
    for (let n = 0; n < 500; n++) {
      const status = (await client.call("getMetadataIndexStatus", {})).chunks[0]
        .data.status;
      if (status.state === "complete") return;
      assert.ok(
        !["failed", "quotaLimited", "unavailable"].includes(status.state),
        JSON.stringify(status),
      );
      await delay(30);
    }
    assert.fail("Index did not complete");
  }
  await completeIndex();
  const partial = (await client.call("getChangeStats", params)).chunks[0].data
    .stats;
  assert.deepEqual(partial.coverage, { processed: 1, complete: false });
  await git(repo, ["fetch", "-q", "--unshallow"]);
  client.session = projectSession(await client.refresh(client.session));
  await completeIndex();
  const complete = (await client.call("getChangeStats", params)).chunks[0].data
    .stats;
  assert.deepEqual(complete.coverage, { processed: 3, complete: true });
  assert.equal(complete.totals.additions, 3);
  assert.equal(complete.totals.deletions, 2);
});

test("P6-02 file backfill pause, cancel and process-group crash preserve completed rows and resume", async (t) => {
  const f = await indexed(t, "file-recovery", async (repo) => {
    for (let i = 0; i < 4; i++)
      await commit(repo, "a.txt", `${i}\n`, 1700000000 + i, `change ${i}`);
  });
  await f.client.stop();
  const dbPath = await database(join(f.base, "data"));
  const db = new DatabaseSync(dbPath);
  const completeRows = db
    .prepare(
      "SELECT oid, ordinal, hex(path) AS path, additions, deletions FROM commit_changes ORDER BY oid,ordinal",
    )
    .all();
  const retained = db
    .prepare("SELECT oid FROM commits ORDER BY oid LIMIT 1")
    .get().oid;
  db.prepare("DELETE FROM commit_changes WHERE oid<>?").run(retained);
  db.prepare("DELETE FROM commit_path_changes WHERE oid<>?").run(retained);
  db.prepare("UPDATE commits SET changes_complete=0 WHERE oid<>?").run(
    retained,
  );
  db.exec("UPDATE snapshots SET complete=0,state='running'");
  db.close();
  const before = await snapshotTree(f.repo);
  const gate = process.env.COMMITSCOPE_PAGES_GATE_FILE,
    started = process.env.COMMITSCOPE_PAGES_GATE_STARTED;
  const clients = [];
  t.after(async () => {
    await rm(gate, { force: true });
    for (const c of clients) await c.stop();
  });
  async function start() {
    const client = new PagesDaemonClient(process.env.COMMITSCOPE_DAEMON_PATH, {
      cwd: f.repo,
      env: createDaemonEnvironment(join(f.base, "data"), {
        HOME: process.env.COMMITSCOPE_PAGES_HOME,
        PATH: `${process.env.COMMITSCOPE_PAGES_GIT_WRAPPER}:${process.env.PATH}`,
        COMMITSCOPE_PAGES_GATE_FILE: gate,
        COMMITSCOPE_PAGES_GATE_STARTED: started,
      }),
    });
    clients.push(client);
    await client.start();
    client.session = projectSession(await client.open(f.repo));
    await client.readPage(client.session);
    return client;
  }
  async function held() {
    for (let n = 0; n < 500; n++) {
      try {
        return Number(await readFile(started, "utf8"));
      } catch {}
      await delay(10);
    }
    assert.fail("File backfill did not reach the Git gate");
  }
  async function gone(pid) {
    for (let n = 0; n < 500; n++) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") return;
        throw e;
      }
      await delay(10);
    }
    assert.fail("File backfill child was not reaped");
  }
  await rm(started, { force: true });
  await writeFile(gate, "diff-tree");
  let client = await start();
  for (const action of ["pause", "cancel"]) {
    const pid = await held();
    const result = (await client.call("controlMetadataIndex", { action }))
      .chunks[0].data.status;
    assert.equal(result.state, action === "pause" ? "paused" : "cancelled");
    assert.equal(result.coverage.complete, false);
    await gone(pid);
    const state = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        state
          .prepare("SELECT count(*) AS n FROM commits WHERE changes_complete=1")
          .get().n,
        1,
      );
    } finally {
      state.close();
    }
    await rm(started, { force: true });
    await client.call("controlMetadataIndex", { action: "resume" });
  }
  const pid = await held();
  process.kill(-client.child.pid, "SIGKILL");
  assert.equal((await client.closed).signal, "SIGKILL");
  await gone(pid);
  await rm(gate, { force: true });
  client = await start();
  for (let n = 0; n < 500; n++) {
    const s = (await client.call("getMetadataIndexStatus", {})).chunks[0].data
      .status;
    if (s.state === "complete") break;
    if (n === 499) assert.fail("Resume did not complete");
    await delay(20);
  }
  const final = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepEqual(
      final
        .prepare(
          "SELECT oid, ordinal, hex(path) AS path, additions, deletions FROM commit_changes ORDER BY oid,ordinal",
        )
        .all(),
      completeRows,
    );
    assert.equal(
      final
        .prepare("SELECT count(*) AS n FROM commits WHERE changes_complete=1")
        .get().n,
      4,
    );
  } finally {
    final.close();
  }
  assert.deepEqual(await snapshotTree(f.repo), before);
});

test("P6-04 refuses a file-pair computation above its budget instead of returning a partial ranking", async (t) => {
  const f = await indexed(t, "pair-budget", async (repo) => {
    let stream = "";
    for (let i = 1; i <= 410; i++) {
      stream += `commit refs/heads/main\nmark :${i}\ncommitter A <a@example.test> ${1700000000 + i} +0000\ndata 1\nx\n${i > 1 ? `from :${i - 1}\n` : ""}`;
      for (let j = 0; j < 50; j++) {
        const content = `${i}\n`;
        stream += `M 100644 inline src/file${j}.rs\ndata ${Buffer.byteLength(content)}\n${content}\n`;
      }
    }
    await git(repo, ["fast-import", "--quiet"], {
      input: Buffer.from(stream + "done\n"),
    });
  });
  await assert.rejects(
    f.client.call("getNotableStats", {
      query: { ...query, timeZone: "UTC" },
      range: { startUnix: 1700000000, endUnix: 1700001000 },
      bucket: "day",
    }),
    (e) => e.code === "RESOURCE_LIMIT",
  );
});

test("P6-05 estimate lists the file, byte and non-regular-file limits explicitly", async (t) => {
  const f = await indexed(t, "evolution-limits", async (repo) => {
    for (let i = 0; i < 201; i++)
      await writeFile(join(repo, `file-${String(i).padStart(3, "0")}.txt`), "");
    await writeFile(
      join(repo, "large-byte.txt"),
      Buffer.alloc(1024 * 1024 + 1, 97),
    );
    const { symlink } = await import("node:fs/promises");
    await symlink("file-000.txt", join(repo, "symlink.txt"));
    await git(repo, ["add", "."]);
    await git(repo, [
      "-c",
      "user.name=A",
      "-c",
      "user.email=a@a",
      "commit",
      "-qm",
      "limits",
    ]);
  });
  const estimate = (
    await f.client.call("estimateEvolution", {
      commit: await git(f.repo, ["rev-parse", "HEAD"]),
      pathHex: "",
      range: null,
    })
  ).chunks[0].data.estimate;
  assert.equal(estimate.files, 200);
  assert.equal(estimate.totalFiles, 203);
  assert.equal(estimate.lines, 0);
  assert.deepEqual(estimate.skipped.map((s) => s.reason).sort(), [
    "byteLimit",
    "fileLimit",
    "notRegularFile",
  ]);
});

test("SearchQuery.excludeTips filters searchCommits and statistics to the batch topology range", async (t) => {
  const tips = {};
  const f = await indexed(t, "exclude-tips-batch", async (repo) => {
    await commit(repo, "old.txt", "v1\n", 1700000100, "chore: baseline one");
    tips.oldTip = await commit(repo, "old.txt", "v2\n", 1700000200, "chore: baseline two");
    await commit(repo, "feat.ts", "export const x = 1;\n", 1700000300, "feat: added after update", "Alice");
    await commit(repo, "feat.ts", "export const x = 2;\n", 1700000400, "fix: follow up in batch", "Bob");
  });

  const searchRes = await f.client.call("searchCommits", {
    query: { ...query, timeZone: "UTC", excludeTips: [tips.oldTip] },
    pageSize: 50,
    cursor: null,
    anchorOid: null,
  });
  const searchTitles = searchRes.chunks.flatMap((c) => c.data.page.commits.map((item) => item.summary));
  assert.deepEqual(searchTitles, ["fix: follow up in batch", "feat: added after update"]);

  const overview = (await f.client.call("getActivityOverview", {
    query: { ...query, timeZone: "UTC", excludeTips: [tips.oldTip] },
    range: { startUnix: 1700000000, endUnix: 1700001000 },
    bucket: "hour",
  })).chunks[0].data.stats;
  assert.equal(overview.totals.commits, 2);
  assert.equal(overview.totals.authors, 2);

  const changes = (await f.client.call("getChangeStats", {
    query: { ...query, timeZone: "UTC", excludeTips: [tips.oldTip] },
    range: { startUnix: 1700000000, endUnix: 1700001000 },
    bucket: "hour",
    directoryPrefix: "",
  })).chunks[0].data.stats;
  assert.equal(changes.totals.additions, 2);
  assert.equal(changes.totals.deletions, 1);
  assert.equal(changes.files.length, 1);
  assert.equal(changes.files[0].path.display, "feat.ts");
  assert.equal(changes.files[0].commits, 2);
});
