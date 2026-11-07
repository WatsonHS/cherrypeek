import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDetailsFixture, git } from "./fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "commitscope-details-preflight-"));
const suppliedFixture = process.env.COMMITSCOPE_DETAILS_FIXTURE;
try {
  const fixture = suppliedFixture
    ? JSON.parse(await readFile(suppliedFixture, "utf8"))
    : await createDetailsFixture(root);
  const parents = (await git(fixture.repository, ["show", "-s", "--format=%P", fixture.octopus])).split(" ").filter(Boolean);
  assert.deepEqual(parents, [fixture.merge, fixture.topicA, fixture.topicB], "octopus parent order is fixed and independently readable");
  assert.equal(Number(await git(fixture.repository, ["rev-list", "--count", fixture.octopus])), fixture.topicACommitCount + 6,
    "octopus reachable count equals its independently enumerated topic group plus the shared topology");
  assert.equal((await git(fixture.repository, ["cat-file", "-s", fixture.resourceLimit])).length > 0, true, "resource-limit commit object is present");

  const rawCommit = await git(fixture.repository, ["cat-file", "commit", fixture.merge], { binary: true });
  assert.ok(rawCommit.includes(Buffer.from(fixture.trailerMessage)), "full raw commit object contains the exact fixture message");
  const trailerOutput = await git(fixture.repository, ["-c", "trailer.separators=:", "-c", "trailer.reviewed-by.command=", "-c", "trailer.reviewed-by.cmd=", "interpret-trailers", "--parse", "--no-divider"], { input: Buffer.from(fixture.trailerMessage) });
  assert.deepEqual(trailerOutput.split("\n").filter(Boolean), [
    "Reviewed-by: Ada Reviewer <ada@example.invalid>",
    "Co-authored-by: Lin Author <lin@example.invalid> continuation line",
    "Reviewed-by: Ada Reviewer <ada@example.invalid>",
  ], "Git parses only the final trailer paragraph, unfolds continuation and retains duplicates");

  const parentsMerge = (await git(fixture.repository, ["show", "-s", "--format=%P", fixture.merge])).split(" ").filter(Boolean);
  assert.deepEqual(parentsMerge, [fixture.main, fixture.side]);
  const diffPrefix = [`--attr-source=${fixture.merge}`, "diff-tree", "--no-ext-diff", "--no-textconv", "-r", "--no-commit-id", "--name-status", "-z", "-M"];
  const firstParentDiff = await git(fixture.repository, [...diffPrefix, parentsMerge[0], fixture.merge], { binary: true });
  const secondParentDiff = await git(fixture.repository, [...diffPrefix, parentsMerge[1], fixture.merge], { binary: true });
  const firstTokens = firstParentDiff.toString("utf8").split("\0").filter(Boolean);
  const secondTokens = secondParentDiff.toString("utf8").split("\0").filter(Boolean);
  assert.ok(firstTokens.includes("A") && firstTokens.includes("side-only/侧面.txt"));
  assert.ok(firstTokens.includes("A") && firstTokens.includes("vendor/module"));
  assert.ok(secondTokens.includes("R100") && secondTokens.includes("rename-old.txt") && secondTokens.includes("rename-new/renamed.txt"));
  assert.ok(secondTokens.includes("D") && secondTokens.includes("delete-me.txt"));
  assert.ok(secondTokens.includes("T") && secondTokens.includes("type-change"));
  assert.ok(secondParentDiff.includes(Buffer.from(fixture.rawPathHex, "hex")), "the raw path byte sequence is present in Git's NUL-delimited result");
  assert.ok(secondParentDiff.includes(Buffer.from(fixture.rawPath2Hex, "hex")), "a second invalid UTF-8 path has distinct raw bytes");
  assert.ok(secondTokens.includes(" spaced\tpath ") && secondTokens.includes("--option-looking"), "leading/trailing spaces, tab and option-like paths are preserved literally");
  const attrFromCommit = (await git(fixture.repository, ["check-attr", `--source=${fixture.merge}`, "binary", "--", "special.txt"])).trim();
  const attrFromWorktree = (await git(fixture.repository, ["check-attr", "binary", "--", "special.txt"])).trim();
  assert.match(attrFromCommit, /special\.txt: binary: set$/);
  assert.match(attrFromWorktree, /special\.txt: binary: unspecified$/);
  const driverFromCommit = (await git(fixture.repository, ["check-attr", `--source=${fixture.merge}`, "diff", "--", "attr-probe.txt"])).trim();
  const driverFromParent = (await git(fixture.repository, ["check-attr", `--source=${fixture.side}`, "diff", "--", "attr-probe.txt"])).trim();
  const driverFromWorktree = (await git(fixture.repository, ["check-attr", "diff", "--", "attr-probe.txt"])).trim();
  assert.match(driverFromCommit, /attr-probe\.txt: diff: poison$/);
  assert.match(driverFromParent, /attr-probe\.txt: diff: unspecified$/);
  assert.match(driverFromWorktree, /attr-probe\.txt: diff: unspecified$/);
  const attrOracleCommand = await git(fixture.repository, [`--attr-source=${fixture.merge}`, "diff-tree", "-r", "--no-commit-id", "--numstat", "-z", parentsMerge[1], fixture.merge], { binary: true });
  assert.ok(attrOracleCommand.includes(Buffer.from("-\t-\tattr-probe.txt\0")), "the target commit's diff driver marks attr-probe binary in numstat");
  const parentAttrNumstat = await git(fixture.repository, [`--attr-source=${fixture.side}`, "diff-tree", "-r", "--no-commit-id", "--numstat", "-z", parentsMerge[1], fixture.merge], { binary: true });
  assert.ok(parentAttrNumstat.includes(Buffer.from("1\t1\tattr-probe.txt\0")), `the selected parent's attributes should produce text stats; got ${JSON.stringify(parentAttrNumstat.toString("utf8"))}`);
  assert.ok(!attrOracleCommand.includes(Buffer.from("1\t1\tattr-probe.txt\0")), "the target commit's attributes produce a different binary classification");

  const firstGroup = (await git(fixture.repository, ["rev-list", "--topo-order", parents[1], "--not", parents[0]])).split("\n").filter(Boolean);
  const secondGroup = (await git(fixture.repository, ["rev-list", "--topo-order", parents[2], "--not", parents[0]])).split("\n").filter(Boolean);
  assert.equal(firstGroup.length, fixture.topicACommitCount);
  assert.equal(new Set(firstGroup).size, fixture.topicACommitCount);
  assert.deepEqual(secondGroup, [fixture.topicB]);
  const firstAuthors = await authorDistribution(fixture.repository, firstGroup);
  const secondAuthors = await authorDistribution(fixture.repository, secondGroup);
  assert.deepEqual(firstAuthors, [
    { name: "Octopus Author A", email: "octo-a@example.invalid", count: 103 },
    { name: "Octopus Author Shared", email: "octo-shared@example.invalid", count: 102 },
  ]);
  assert.deepEqual(secondAuthors, [{ name: "Octopus Author B", email: "octo-b@example.invalid", count: 1 }]);

  const boundaryRefs = (await git(fixture.repository, ["branch", "--contains", fixture.root])).split("\n").map(line => line.replace(/^\*?\s*/, "")).filter(Boolean).sort();
  assert.deepEqual(boundaryRefs, ["main", "resource-limit", "side", "topic/a", "topic/b"].sort());
  assert.equal(await git(fixture.repository, ["rev-parse", "--show-object-format"]), "sha1");
  if (fixture.sha256) assert.equal((await git(fixture.sha256.repository, ["rev-parse", "--show-object-format"])), "sha256");
  assert.equal(await exists(fixture.trailerSentinel), false, "fixture generation itself never executes the configured trailer command");
  assert.equal(await exists(fixture.externalSentinel), false, "fixture oracle calls never execute configured external diff/textconv commands");
  process.stdout.write(JSON.stringify({ fixture: "commit-details", root: fixture.root, merge: fixture.merge, octopus: fixture.octopus, sha256: Boolean(fixture.sha256), rawPathHex: fixture.rawPathHex, rawPath2Hex: fixture.rawPath2Hex }, null, 2) + "\n");
} finally {
  if (!suppliedFixture) await rm(root, { recursive: true, force: true });
}

async function authorDistribution(repository, oids) {
  const counts = new Map();
  for (const oid of oids) {
    const [name, email] = (await git(repository, ["show", "-s", "--format=%an%x00%ae", oid])).split("\0");
    const key = `${name}\0${email}`;
    const entry = counts.get(key) ?? { name, email, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

async function exists(path) {
  try { await (await import("node:fs/promises")).access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
