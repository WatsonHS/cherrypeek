import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { NavigationHistory } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "navigation-history.mjs")));

const place = name => ({ key: name, label: name });

test("back returns to where each jump left from, and forward retraces it", () => {
  const history = new NavigationHistory();
  assert.deepEqual(history.getView(), { canBack: false, canForward: false, backLabel: null, forwardLabel: null });
  history.record(place("commit A"));       // commits page → files page
  history.record(place("app.ts"));         // files page → a change
  assert.deepEqual([history.getView().canBack, history.getView().backLabel], [true, "app.ts"]);
  assert.equal(history.back(place("app.ts @ c1")).key, "app.ts");
  assert.equal(history.back(place("app.ts")).key, "commit A");
  assert.equal(history.back(place("commit A")), null, "nothing further back");
  assert.deepEqual([history.getView().canForward, history.getView().forwardLabel], [true, "app.ts"]);
  assert.equal(history.forward(place("commit A")).key, "app.ts");
  assert.equal(history.forward(place("app.ts")).key, "app.ts @ c1");
  assert.equal(history.getView().canForward, false);
});

test("a new jump after going back drops the forward steps", () => {
  const history = new NavigationHistory();
  history.record(place("a"));
  history.record(place("b"));
  history.back(place("c"));
  assert.equal(history.getView().canForward, true);
  history.record(place("b"));
  assert.equal(history.getView().canForward, false);
});

test("the same place is not recorded twice in a row, and steps equal to where you are are skipped", () => {
  const history = new NavigationHistory();
  history.record(place("a"));
  history.record(place("a"));
  history.record(place("b"));
  assert.equal(history.back(place("b")).key, "a", "going back from b skips the b step and lands on a");
  assert.equal(history.getView().canBack, false, "a was recorded once");
});

test("only the most recent steps are kept", () => {
  const history = new NavigationHistory(3);
  for (const name of ["a", "b", "c", "d", "e"]) history.record(place(name));
  const visited = [];
  let current = place("now");
  for (let target = history.back(current); target; target = history.back(current)) { visited.push(target.key); current = target; }
  assert.deepEqual(visited, ["e", "d", "c"]);
});

test("listeners hear every change and clearing forgets everything", () => {
  const history = new NavigationHistory();
  let calls = 0;
  const unsubscribe = history.subscribe(() => { calls += 1; });
  history.record(place("a"));
  history.back(place("b"));
  history.clear();
  assert.equal(calls, 3);
  assert.deepEqual(history.getView(), { canBack: false, canForward: false, backLabel: null, forwardLabel: null });
  unsubscribe();
  history.record(place("c"));
  assert.equal(calls, 3);
});

test("peekBack shows where back would go without going", () => {
  const history = new NavigationHistory();
  assert.equal(history.peekBack(), null);
  history.record({ key: "a", label: "A" });
  history.record({ key: "b", label: "B" });
  assert.equal(history.peekBack().key, "b");
  assert.equal(history.peekBack().key, "b", "peeking does not move");
  history.back({ key: "c", label: "C" });
  assert.equal(history.peekBack().key, "a");
});
