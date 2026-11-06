import assert from "node:assert/strict";
import test from "node:test";
import { classifyProcess, mergeProcessObservation } from "../../scripts/process-tree-observation.mjs";

test("short macOS process names retain known Rust and Git classifications", () => {
  assert.equal(classifyProcess("(commitscope-daem)"), "rust-daemon");
  assert.equal(classifyProcess("(git)"), "git");

  const fullRust = { pid: 95359, started: "Fri Nov  7 09:39:00 2026", command: "/Applications/CommitScope.app/Contents/MacOS/commitscope-daemon" };
  const shortRust = { ...fullRust, command: "(commitscope-daem)" };
  const fullGit = { pid: 95378, started: fullRust.started, command: "/usr/bin/git rev-list --topo-order HEAD" };
  const shortGit = { ...fullGit, command: "(git)" };

  const mergedRust = mergeProcessObservation(fullRust, shortRust);
  const mergedGit = mergeProcessObservation(fullGit, shortGit);
  assert.equal(mergedRust.classification, "rust-daemon");
  assert.equal(mergedRust.command, fullRust.command);
  assert.equal(mergedGit.classification, "git");
  assert.equal(mergedGit.command, fullGit.command);
});

test("a reused PID with a different process start identity begins a new observation", () => {
  const previous = { pid: 42, started: "first", command: "/usr/bin/git rev-list" };
  const next = { pid: 42, started: "second", command: "(commitscope-daem)" };
  const merged = mergeProcessObservation(previous, next);
  assert.equal(merged.started, "second");
  assert.equal(merged.classification, "rust-daemon");
});
