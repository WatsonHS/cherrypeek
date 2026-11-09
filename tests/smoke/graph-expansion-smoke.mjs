#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { createGraphFixture, gitText } from "../graph/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDirectory = resolve(root, "output/playwright/graph-expansion");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-graph-expansion-"));
const fixture = await createGraphFixture(join(temporaryRoot, "fixture"), { mainCommitCount: 420, includeBoundaries: false });
const repository = fixture.repository;
const existingRefs = (await gitText(repository, ["for-each-ref", "--format=%(refname)"])).trim().split("\n").length;
const headOid = await gitText(repository, ["rev-parse", "HEAD"]);
execFileSync("git", ["-C", repository, "update-ref", "--stdin"], {
  input: Array.from({ length: 1000 - existingRefs }, (_, index) => `create refs/heads/graph-test-${index} ${headOid.trim()}\n`).join(""),
});
const profile = join(temporaryRoot, "user-data");
let app;
let page;

try {
  const before = await snapshotTree(repository);
  await mkdir(screenshotDirectory, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: process.env.COMMITSCOPE_PACKAGED_APP || require("electron"),
    args: [...(process.env.COMMITSCOPE_PACKAGED_APP ? [] : [appEntry]), `--repository=${repository}`, `--user-data-dir=${profile}`],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-state"][data-state="ready"]'), null, { timeout: 30_000 });
  const list = page.getByRole("listbox", { name: "提交" });
  await page.waitForFunction(() => {
    const element = document.querySelector('[aria-label="提交"]');
    return element && Number(element.dataset.loadedCount) === 200 && element.querySelector('[data-testid="graph-expand"]');
  }, null, { timeout: 20_000 });

  const targetButton = list.getByTestId("graph-expand").first();
  const targetRow = targetButton.locator("xpath=ancestor::*[@data-testid='commit-row']");
  const targetOid = await targetRow.getAttribute("data-oid");
  assert.ok(targetOid);
  await targetRow.click();
  const selectedBefore = await list.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid");
  const compactSignature = await targetRow.getByTestId("commit-graph").getAttribute("data-graph-signature");
  // The +N buttons go away once expanded, so follow the row by its OID.
  const stableTargetRow = list.locator(`[data-testid="commit-row"][data-oid="${targetOid}"]`);
  const anchorBefore = await readScreenTop(stableTargetRow);
  assert.equal(selectedBefore, targetOid, "the expanded row is selected before toggling its graph");
  assert.ok(anchorBefore);
  await page.screenshot({ path: join(screenshotDirectory, "compact.png") });

  const hoverRow = list.locator('[data-testid="commit-row"]').filter({ has: page.locator('[data-testid="commit-graph"][data-graph-lane="6"]') }).first();
  const hoverOid = await hoverRow.getAttribute("data-oid");
  await hoverRow.hover();
  await page.waitForFunction(oid => document.querySelector('[aria-label="提交"]')?.dataset.graphHighlightOid === oid, hoverOid);
  assert.equal(await list.locator('[aria-selected="true"]').getAttribute('data-oid'), selectedBefore, 'hover never changes commit selection');
  const opacities = await list.locator('[data-testid="commit-graph"] path').evaluateAll(paths => paths.map(path => Number(getComputedStyle(path).opacity)));
  assert.ok(opacities.includes(0.4) && opacities.includes(1), 'unrelated edges dim while the selected line stays fully coloured');
  assert.ok(await list.getByTestId('graph-highlight-through').count() === 0, 'hidden lane is clipped before dragging');
  await page.mouse.move(1100, 20);
  await page.waitForFunction(oid => document.querySelector('[aria-label="提交"]')?.dataset.graphHighlightOid === oid, selectedBefore);

  const handle = page.getByTestId('graph-resize-handle');
  const box = await handle.boundingBox();
  const originalWidth = Number(await stableTargetRow.getByTestId('commit-graph').getAttribute('data-graph-width'));
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 54, box.y + 40, { steps: 6 });
  await page.mouse.up();
  assert.equal(await handle.getAttribute('aria-valuenow'), '12');
  assert.ok(Number(await stableTargetRow.getByTestId('commit-graph').getAttribute('data-graph-width')) > originalWidth);
  assert.equal(await stableTargetRow.getByTestId('commit-graph').getAttribute('data-graph-signature'), compactSignature);
  assert.ok(Math.abs(await readScreenTop(stableTargetRow) - anchorBefore) <= 4, 'dragging preserves the vertical anchor');
  await hoverRow.hover();
  await page.waitForFunction(oid => document.querySelector('[aria-label="提交"]')?.dataset.graphHighlightOid === oid, hoverOid, { timeout: 5_000 });
  assert.ok(await list.getByTestId('graph-highlight-through').count() > 0, 'resized graph highlights the hidden straight-through lane');
  await page.screenshot({ path: join(screenshotDirectory, 'resized-highlight.png') });
  await handle.focus();
  await page.keyboard.press('Home');
  assert.equal(await handle.getAttribute('aria-valuenow'), '4');
  assert.ok(Number(await stableTargetRow.getByTestId('commit-graph').getAttribute('data-graph-hidden-count')) > 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await handle.getAttribute('aria-valuenow'), '7');

  await targetButton.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="提交"]')?.dataset.graphExpanded === "true", null, { timeout: 5_000 });
  await page.waitForFunction(oid => {
    const row = document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`);
    return row?.querySelector('[data-testid="commit-graph"][data-graph-expanded="true"]');
  }, targetOid, { timeout: 5_000 });

  const expandedState = await list.evaluate(element => ({
    expanded: element.dataset.graphExpanded,
    lanes: Number(element.dataset.visibleGraphLanes),
    scrollLeft: element.scrollLeft,
    clientWidth: element.clientWidth,
    listScrollWidth: element.scrollWidth,
  }));
  assert.equal(expandedState.expanded, "true");
  assert.ok(expandedState.lanes > 6, `wide octopus exposes its full lane count: ${expandedState.lanes}`);
  assert.equal(await list.locator('[data-testid="commit-graph"][data-graph-expanded="true"][data-graph-hidden-count="0"]').count() > 0, true,
    "expanded commit rows no longer report hidden graph lanes");
  assert.equal(await list.locator(`[data-testid="commit-row"][data-oid="${targetOid}"] [data-testid="commit-graph"]`).getAttribute("data-graph-signature"), compactSignature,
    "expansion preserves the immutable backend graph signature");
  assert.equal(await list.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid"), selectedBefore,
    "expansion does not change commit selection");
  const anchorAfter = await readScreenTop(stableTargetRow);
  assert.ok(Math.abs(anchorAfter - anchorBefore) <= 4,
    `expansion keeps the row where it was on screen: before=${anchorBefore}, after=${anchorAfter}`);
  // The graph status and collapse control share the pinned date strip at the top of the list,
  // instead of floating over rows.
  const bar = page.getByTestId("graph-mode-bar");
  assert.match(await bar.innerText(), new RegExp(`全部图线 · ${expandedState.lanes} 列`));
  const [barBox, stripBox, listBox] = await Promise.all([bar.boundingBox(), page.getByTestId("history-day-strip").boundingBox(), list.boundingBox()]);
  assert.ok(barBox && stripBox && listBox && Math.abs(stripBox.y - listBox.y) < 1 && barBox.y >= stripBox.y - 0.5 && barBox.y + barBox.height <= stripBox.y + stripBox.height + 0.5,
    `the full-graph status sits inside the pinned date strip: ${JSON.stringify({ barBox, stripBox, listBox })}`);
  assert.equal(await bar.getByTestId("graph-collapse").count(), 1, "the collapse button sits next to the graph status");

  const expandedLanes = await list.locator('[data-testid="commit-graph"][data-graph-expanded="true"]').evaluateAll(graphs => ({
    hiddenThroughDrawn: graphs.some(graph => {
      const encoded = graph.getAttribute("data-graph-hidden-through-ranges") ?? "";
      const svg = [...graph.children].find(child => child.tagName.toLowerCase() === "svg");
      return encoded.length > 0 && Boolean(svg?.querySelector('[data-testid="graph-hidden-through"]'));
    }),
    hiddenDayBridge: [...document.querySelectorAll('[data-testid="graph-day-bridge"][data-graph-expanded="true"]')]
      .some(graph => (graph.getAttribute("data-graph-above-lanes") ?? "").split(",").some(lane => Number(lane) > 5)),
    maxWidth: Math.max(0, ...graphs.map(graph => Number(graph.getAttribute("data-graph-width")) || 0)),
  }));
  assert.ok(expandedLanes.hiddenThroughDrawn, "expanded mode draws hidden through ranges");
  assert.ok(expandedLanes.hiddenDayBridge, "date bridges carry hidden lane lines in expanded mode");
  assert.ok(expandedLanes.maxWidth > 59, `expanded graph width covers hidden lanes: ${expandedLanes.maxWidth}`);
  const hiddenNodeDrawn = await list.locator('[data-testid="commit-graph"][data-graph-expanded="true"]').evaluateAll(graphs => graphs.some(graph =>
    Number(graph.getAttribute("data-graph-lane")) >= 6 &&
    [...graph.children].some(child => child.tagName.toLowerCase() === "svg" && child.querySelector(":scope > circle"))));
  assert.ok(hiddenNodeDrawn, "expanded mode draws a real commit node in a lane beyond the compact six");
  const documentWidth = await page.evaluate(() => ({ inner: window.innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  assert.ok(documentWidth.document <= documentWidth.inner + 1 && documentWidth.body <= documentWidth.inner + 1,
    `expanded graph does not widen the outer window: ${JSON.stringify(documentWidth)}`);
  await page.screenshot({ path: join(screenshotDirectory, "expanded.png") });

  const expectedCount = Number(await gitText(repository, ["rev-list", "--count", "HEAD"]));
  assert.ok(expectedCount > 400, "fixture crosses the first 200-commit history page");
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => {
    const element = document.querySelector('[aria-label="提交"]');
    return element && element.dataset.pageLoading === "false" && Number(element.dataset.loadedCount) === 400;
  }, null, { timeout: 20_000 });
  assert.equal(await list.getAttribute("data-graph-expanded"), "true", "the full graph view survives a history page append");
  assert.ok(Number(await list.getAttribute("data-visible-graph-lanes")) > 6);
  await page.screenshot({ path: join(screenshotDirectory, "expanded-next-page.png") });

  await list.evaluate(element => { element.scrollLeft = Math.min(80, Math.max(0, element.scrollWidth - element.clientWidth)); });
  await page.getByTestId("graph-collapse").click();
  await page.waitForFunction(() => document.querySelector('[aria-label="提交"]')?.dataset.graphExpanded === "false", null, { timeout: 5_000 });
  assert.equal(await list.getAttribute("data-graph-expanded"), "false");
  assert.equal(await list.getAttribute("data-visible-graph-lanes"), "7", "collapse restores the custom width");
  assert.equal(await list.evaluate(element => element.scrollLeft), 0, "collapse resets the list's horizontal offset");
  assert.ok(await list.locator('[data-testid="graph-expand"]').count() > 0, "compact mode restores the +N expansion controls");
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`), targetOid, { timeout: 10_000 });
  const restoredRow = list.locator(`[data-testid="commit-row"][data-oid="${targetOid}"]`);
  assert.equal(await restoredRow.getByTestId("commit-graph").getAttribute("data-graph-signature"), compactSignature,
    "collapsing after page traversal restores the original compact graph signature");
  assert.equal(await list.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid"), selectedBefore);
  await page.screenshot({ path: join(screenshotDirectory, "collapsed.png") });

  // Esc on the list also collapses, and the rows stay put when the bar goes away.
  const escapeButton = list.getByTestId("graph-expand").first();
  const escapeOid = await escapeButton.locator("xpath=ancestor::*[@data-testid='commit-row']").getAttribute("data-oid");
  const escapeRow = list.locator(`[data-testid="commit-row"][data-oid="${escapeOid}"]`);
  await escapeButton.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="提交"]')?.dataset.graphExpanded === "true", null, { timeout: 5_000 });
  const escapeTop = await readScreenTop(escapeRow);
  await list.focus();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector('[aria-label="提交"]')?.dataset.graphExpanded === "false", null, { timeout: 5_000 });
  assert.equal(await page.getByTestId("graph-mode-bar").count(), 0, "collapsing removes the full-graph bar");
  const escapeTopAfter = await readScreenTop(escapeRow);
  assert.ok(Math.abs(escapeTopAfter - escapeTop) <= 4, `collapse keeps the row where it was on screen: before=${escapeTop}, after=${escapeTopAfter}`);
  await page.getByTestId('graph-resize-handle').dblclick();
  assert.equal(await list.getAttribute('data-visible-graph-lanes'), '6', 'double-click restores the default width');

  assert.deepEqual(await snapshotTree(repository), before, "expanding and browsing the graph never writes to the repository");

  await app.close();
  app = undefined;
  process.stdout.write(`Graph interactions Electron smoke passed: ${expectedCount} commits / 1000 refs, drag and keyboard resize, hover/selection highlighting, expansion/collapse across pages, unchanged selection/signature and read-only snapshot. Screenshots: ${screenshotDirectory}\n`);
} catch (error) {
  if (page) {
    await mkdir(screenshotDirectory, { recursive: true });
    await page.screenshot({ path: join(screenshotDirectory, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

/** A row's top edge in window coordinates, i.e. where the reader sees it. */
async function readScreenTop(row) {
  return row.evaluate(element => element.getBoundingClientRect().top);
}
