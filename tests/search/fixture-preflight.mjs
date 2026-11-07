import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchFixture, snapshotTree } from "./fixture.mjs";

const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-search-preflight-"));
try {
  const fixture = await createSearchFixture(join(temporaryRoot, "fixtures"));
  assert.ok(fixture.oids.length >= 2_500);
  assert.ok(fixture.ambiguousOids.length >= 2, "real Git OIDs contain a colliding four-hex prefix");
  assert.equal(fixture.commits.size, fixture.oids.length);
  assert.equal(fixture.commits.get(fixture.rootOid).committer.timestamp, 2_000_000_000);
  assert.equal(fixture.oids.at(-1), fixture.rootOid, "topological traversal reaches the root last");
  assert.ok(fixture.commits.get(fixture.oids[0]).committer.timestamp < fixture.commits.get(fixture.rootOid).committer.timestamp,
    "the root sorts ahead by time despite appearing last in topology");
  assert.deepEqual(await snapshotTree(fixture.repository), fixture.snapshot);
  assert.ok(fixture.framePageBytes > 512 * 1024, "the first 500 summaries exceed the 512 KiB framing target");
  process.stdout.write(`Search fixture preflight passed: ${fixture.oids.length} reachable commits; ambiguous prefix ${fixture.ambiguousPrefix} has ${fixture.ambiguousOids.length} candidates; page payload ${fixture.framePageBytes} bytes; raw Git objects parsed; repository unchanged.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
