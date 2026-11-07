import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SelectionIntent, applySelectionIfCurrent } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "selection-intent.mjs")));

function session(repoId, generation) { return { repoId, generation }; }

test("a delayed boundary navigation cannot replace a newer user selection", async () => {
  const intent = new SelectionIntent();
  const current = session("repo-a", "generation-a");
  let selected = "middle-row";
  const token = intent.capture(current);
  let resolve;
  const navigation = new Promise(done => { resolve = done; });

  // A row or detail selection invalidates the request synchronously, before React renders.
  intent.invalidate();
  selected = "user-picked-row";
  resolve("old-edge-row");
  const oid = await navigation;
  const applied = applySelectionIfCurrent(intent, token, current, oid, value => { selected = value; });

  assert.equal(applied, false);
  assert.equal(selected, "user-picked-row");
});

test("a delayed navigation cannot select into a different repository session", () => {
  const intent = new SelectionIntent();
  const token = intent.capture(session("repo-a", "generation-a"));
  let selected;
  const applied = applySelectionIfCurrent(intent, token, session("repo-b", "generation-b"), "old-edge-row", oid => { selected = oid; });
  assert.equal(applied, false);
  assert.equal(selected, undefined);
});
