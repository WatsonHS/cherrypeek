import assert from "node:assert/strict";
import test from "node:test";
import { loadBuilt } from "./test-utils.mjs";

const { ViewContextGate } = await loadBuilt("view-context-gate");

test("observing a newer generation preserves the pending view; switching it cancels the request", () => {
  const gate = new ViewContextGate();
  const current = { repoId: "repo-a", generation: "generation-10" };
  const newer = { repoId: "repo-a", generation: "generation-11" };
  gate.switchCurrent(current);
  const cancelled = [];
  gate.register("request-old-view", current, id => cancelled.push(id));

  gate.observeLatest(newer);
  assert.deepEqual(gate.getCurrent(), current);
  assert.deepEqual(gate.getLatestObserved(), newer);
  assert.equal(gate.accepts("request-old-view", current), true);
  assert.deepEqual(cancelled, []);

  gate.switchCurrent(newer);
  assert.deepEqual(cancelled, ["request-old-view"]);
  assert.equal(gate.accepts("request-old-view", current), false);
});
