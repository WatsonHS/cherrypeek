import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { DiffDisplayStore, DEFAULT_DIFF_DISPLAY } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "diff-display.mjs")));

const memory = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data };
};

test("the choice is shared, persisted and read back on the next launch", () => {
  const storage = memory();
  const first = new DiffDisplayStore(storage);
  let notified = 0;
  first.subscribe(() => { notified += 1; });
  first.toggleLayout();
  first.toggleWrap();
  assert.deepEqual(first.getView(), { layout: "split", scope: "changes", wrap: true });
  assert.equal(notified, 2);
  assert.deepEqual(new DiffDisplayStore(storage).getView(), { layout: "split", scope: "changes", wrap: true });
});

test("unreadable or unknown stored values fall back to the defaults", () => {
  assert.deepEqual(new DiffDisplayStore(memory({ "commitscope.diffDisplay.v1": "{not json" })).getView(), DEFAULT_DIFF_DISPLAY);
  assert.deepEqual(new DiffDisplayStore(memory({ "commitscope.diffDisplay.v1": JSON.stringify({ layout: "grid", wrap: "yes" }) })).getView(), DEFAULT_DIFF_DISPLAY);
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const store = new DiffDisplayStore(throwing);
  assert.deepEqual(store.getView(), DEFAULT_DIFF_DISPLAY);
  store.toggleLayout();
  assert.equal(store.getView().layout, "split", "a failing write keeps the choice for this session");
});

test("updates that change nothing do not notify", () => {
  const store = new DiffDisplayStore(memory());
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  store.update({ layout: "unified" });
  assert.equal(notified, 0);
});
