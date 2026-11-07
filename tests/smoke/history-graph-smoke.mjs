#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { createGraphFixture, gitText } from "../graph/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const output = resolve(root, "output/playwright");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-graph-smoke-"));
const fixture = await createGraphFixture(join(temporaryRoot, "fixture"), { mainCommitCount: 2_205 });
const repository = fixture.repository;
const profile = join(temporaryRoot, "user-data");
let app;
let page;

try {
  const repositoryBefore = await snapshotTree(repository);
  await launch(repository, profile);
  await waitForHistory(page);
  const initialHead = await gitText(repository, ["rev-parse", "HEAD"]);
  await assertGraphRows(page, initialHead);
  const list = () => page.getByRole("listbox", { name: "提交" });
  await list().locator(`[data-testid="commit-row"][data-oid="${initialHead}"]`).click();
  const initialGraphMetrics = await graphMetrics(page);
  assert.ok(initialGraphMetrics.hiddenRows > 0, "the initial wide graph window renders hidden node lanes");
  await assertHiddenNodeColor(page);
  await assert.ok((await graphMetrics(page)).overflowRows > 0, "visible rows should expose the +n hidden-lane indicator");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, "p2-01-history-graph.png") });
  await assertZoomAndTheme(page);
  assert.deepEqual(await snapshotTree(repository), repositoryBefore, "first-launch history and graph reads do not modify the fixture");
  await closeAndAssertProcessesExit();

  const oldTip = initialHead;
  const tree = await gitText(repository, ["rev-parse", `${oldTip}^{tree}`]);
  const newest = await gitText(repository, ["-c", "user.name=Graph Smoke", "-c", "user.email=graph-smoke@example.invalid", "commit-tree", tree, "-p", oldTip, "-m", "new commit after last viewed graph"]);
  await gitText(repository, ["update-ref", "refs/heads/main", newest]);
  const repositoryAfterExternalCommit = await snapshotTree(repository);
  await launch(repository, profile);
  await waitForHistory(page);
  await assert.ok(await list().locator(`[data-testid="commit-row"][data-oid="${newest}"]`).count(), "the relaunch renders the externally added commit");
  await page.getByTestId("history-divider").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("graph-last-seen-bridge").waitFor({ state: "attached", timeout: 10_000 });
  await assertBridgeAlignment(page, "graph-day-bridge");
  await assertBridgeAlignment(page, "graph-last-seen-bridge");
  await page.screenshot({ path: join(output, "p2-01-history-graph-last-seen.png") });
  const newHeadSignature = await readGraphSignature(page, newest);
  const oldTipSignature = await readGraphSignature(page, oldTip);

  const historyList = list();
  const oldTipRow = historyList.locator(`[data-testid="commit-row"][data-oid="${oldTip}"]`);
  await oldTipRow.click();
  await historyList.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`), oldTip, { timeout: 5_000 });
  const historyAnchor = await readViewportAnchor(page);
  const historySelection = await historyList.locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid");
  const historyAnchorSignature = await readGraphSignature(page, historyAnchor.oid);
  assert.equal(historySelection, oldTip, "the selected history commit is recorded before entering search");
  const searchInput = page.getByTestId("search-input");
  await searchInput.fill("new commit after last viewed graph");
  await page.locator(`[data-testid="search-result-${newest}"]`).waitFor({ state: "visible", timeout: 60_000 });
  await page.screenshot({ path: join(output, "p2-01-history-graph-search.png") });
  await page.getByTestId("search-clear").click();
  await page.getByRole("listbox", { name: "提交" }).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"] [data-testid="commit-graph"]`), historyAnchor.oid, { timeout: 15_000 });
  assert.equal(await list().locator('[data-testid="commit-row"][aria-selected="true"]').getAttribute("data-oid"), historySelection,
    "clearing search restores the selected history OID");
  assert.equal(await readGraphSignature(page, historyAnchor.oid), historyAnchorSignature,
    "history restored after search uses the original Rust graph row");
  const restoredAnchor = await readViewportAnchor(page);
  assert.equal(restoredAnchor.oid, historyAnchor.oid, "clearing search restores the history viewport OID");
  assert.ok(Math.abs(restoredAnchor.offset - historyAnchor.offset) <= 4,
    `clearing search restores the history pixel anchor: before=${historyAnchor.offset}, after=${restoredAnchor.offset}`);
  await page.screenshot({ path: join(output, "p2-01-history-graph-search-return.png") });

  const historyCount = Number(await gitText(repository, ["rev-list", "--count", newest]));
  let metrics = await readWindowMetrics(page);
  let previousEnd = metrics.offset + metrics.count;
  for (let request = 0; request < 20 && previousEnd < historyCount; request += 1) {
    const bottom = await list().evaluate(async element => {
      const value = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = value;
      await new Promise(requestAnimationFrame);
      return value;
    });
    const anchorAtBottom = await readViewportAnchor(page);
    await list().evaluate((element, target) => { element.scrollTop = target; }, bottom);
    await page.waitForFunction(previous => {
      const element = document.querySelector('[aria-label="提交"]');
      if (!element) return false;
      const end = Number(element.dataset.loadedOffset) + Number(element.dataset.loadedCount);
      return end > previous || document.querySelector('[role="alert"]') !== null;
    }, previousEnd, { timeout: 10_000 });
    metrics = await readWindowMetrics(page);
    assert.ok(metrics.count <= 2_000, `graph summaries exceed the bounded renderer window: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.domRows <= 60, `graph DOM exceeds virtual viewport plus overscan: ${metrics.domRows}`);
    if (anchorAtBottom) await assertAnchorNear(page, anchorAtBottom, "forward history window append/eviction");
    previousEnd = metrics.offset + metrics.count;
  }
  assert.equal(previousEnd, historyCount, `virtual graph should traverse all ${historyCount} commits`);
  assert.ok(metrics.offset > 0, "the renderer should evict the oldest graph pages");
  const bottomGraphMetrics = await graphMetrics(page);
  assert.ok(bottomGraphMetrics.overflowRows > 0, "hidden graph lanes remain counted after forward traversal");

  let reverseOffset = metrics.offset;
  let reverseAnchor;
  for (let request = 0; request < 20 && reverseOffset > 0; request += 1) {
    reverseAnchor = await list().evaluate(async element => {
      element.scrollTop = 0;
      await new Promise(requestAnimationFrame);
      const top = element.getBoundingClientRect().top;
      const bottom = element.getBoundingClientRect().bottom;
      const row = [...element.querySelectorAll('[data-testid="commit-row"]')].find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.bottom > top && rect.top < bottom;
      });
      if (!row) return null;
      return { oid: row.getAttribute("data-oid"), offset: row.getBoundingClientRect().top - top };
    });
    await page.waitForFunction(previous => {
      const element = document.querySelector('[aria-label="提交"]');
      return element && Number(element.dataset.loadedOffset) < previous;
    }, reverseOffset, { timeout: 10_000 });
    metrics = await readWindowMetrics(page);
    assert.ok(metrics.count <= 2_000, `reverse graph window exceeds the renderer budget: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.domRows <= 60, `reverse graph DOM exceeds virtual viewport plus overscan: ${metrics.domRows}`);
    if (reverseAnchor) await assertAnchorNear(page, reverseAnchor, "reverse history window prepend/eviction");
    reverseOffset = metrics.offset;
  }
  assert.equal(reverseOffset, 0, "reverse traversal reloads evicted graph pages back to offset zero");
  await list().evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(oid => document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`), newest, { timeout: 10_000 });
  assert.equal(await readGraphSignature(page, newest), newHeadSignature, "returning after page eviction preserves the head graph signature");
  const selected = list().locator('[data-testid="commit-row"][aria-selected="true"]');
  if (await selected.count()) assert.equal(await selected.getAttribute("data-oid"), historySelection, "history selection remains stable after virtual eviction");
  assert.equal(await readGraphSignature(page, oldTip), oldTipSignature, "the graph row keeps its signature after same-snapshot virtual eviction");
  await page.screenshot({ path: join(output, "p2-01-history-graph-eviction-return.png") });
  assert.deepEqual(await snapshotTree(repository), repositoryAfterExternalCommit, "graph navigation and search never modify the viewed repository");
  await closeAndAssertProcessesExit();

  const boundaryProfile = join(temporaryRoot, "boundary-user-data");
  const shallowBefore = await snapshotTree(fixture.shallowRepository);
  await launch(fixture.shallowRepository, boundaryProfile);
  await waitForHistory(page);
  const boundaryGraph = page.locator('[data-testid="commit-graph"][data-graph-boundary="true"]');
  await boundaryGraph.first().waitFor({ state: "attached", timeout: 10_000 });
  await page.screenshot({ path: join(output, "p2-01-history-graph-boundary.png") });
  assert.deepEqual(await snapshotTree(fixture.shallowRepository), shallowBefore, "shallow-boundary graph reads are read-only");
  await closeAndAssertProcessesExit();
  process.stdout.write(`History graph Electron smoke passed: ${historyCount} commits, six-lane clip/overflow, date and last-view pixel bridges, search/history restoration, renderer eviction and replay, zoom/theme, shallow boundary, read-only snapshots and process cleanup. Screenshots: ${output}\n`);
} catch (error) {
  if (page) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, "p2-01-history-graph-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app) {
    try { await app.close(); } catch { app.process().kill("SIGKILL"); }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function launch(path, userDataPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${path}`, `--user-data-dir=${userDataPath}`],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  });
  page = await app.firstWindow();
  await page.bringToFront();
}

async function closeAndAssertProcessesExit() {
  const status = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(status.state, "ready", "the core remains ready through graph validation");
  const corePid = status.core.pid;
  const appPid = app.process().pid;
  await app.close();
  app = undefined;
  page = undefined;
  await waitForPidExit(corePid, "daemon");
  await waitForPidExit(appPid, "Electron");
}

async function waitForPidExit(pid, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let processAlive = false;
    let groupAlive = false;
    try { process.kill(pid, 0); processAlive = true; }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    if (process.platform !== "win32") {
      try { process.kill(-pid, 0); groupAlive = true; }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (!processAlive && !groupAlive) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} process/group ${pid} did not exit after Electron closed`);
}

async function waitForHistory(targetPage) {
  await targetPage.waitForFunction(() => document.querySelector('[data-testid="preview-state"][data-state="ready"]'), null, { timeout: 30_000 });
  await targetPage.waitForFunction(() => {
    const list = document.querySelector('[aria-label="提交"]');
    return list && Number(list.dataset.loadedCount) > 0 && list.querySelector('[data-testid="commit-row"] [data-testid="commit-graph"]');
  }, null, { timeout: 30_000 });
}

async function assertGraphRows(targetPage, expectedHead) {
  const list = targetPage.getByRole("listbox", { name: "提交" });
  assert.equal(await list.getAttribute("data-visible-graph-lanes"), "6", "renderer fixes six visible graph lanes");
  const row = list.locator(`[data-testid="commit-row"][data-oid="${expectedHead}"]`);
  const graph = row.getByTestId("commit-graph");
  await graph.waitFor({ state: "attached" });
  const signature = await graph.getAttribute("data-graph-signature");
  assert.match(signature ?? "", /^\d+\/\d+\/\d+\/\d+\/\d+\/[01]\//, "each real history row renders the Rust graph payload");
  const metrics = await graph.evaluate(element => {
    const clip = [...element.children].find(child => child.tagName.toLowerCase() === "svg");
    return {
      clipWidth: clip?.getAttribute("width"),
      clipOverflow: clip ? getComputedStyle(clip).overflow : null,
      visibleNodeCount: clip?.querySelectorAll("circle").length ?? 0,
      overflowCount: element.querySelector("text")?.textContent ?? null,
    };
  });
  assert.equal(metrics.clipWidth, "59", "the segment viewport clips after six lane columns");
  assert.equal(metrics.clipOverflow, "hidden", "hidden lane paths cannot paint into the +n gutter");
  const hiddenOid = await targetPage.locator('[aria-label="提交"] [data-testid="commit-graph"]').evaluateAll(graphs =>
    graphs.find(graph => Number(graph.getAttribute("data-graph-lane")) >= 6)?.closest('[data-testid="commit-row"]')?.getAttribute("data-oid") ?? null);
  if (hiddenOid) {
    const hidden = await targetPage.locator(`[data-testid="commit-row"][data-oid="${hiddenOid}"] [data-testid="commit-graph"]`).evaluate(element => {
      const clip = [...element.children].find(child => child.tagName.toLowerCase() === "svg");
      return { clipNodes: clip?.querySelectorAll("circle").length ?? -1, overflowNodes: element.querySelectorAll(":scope > circle").length,
        label: element.querySelector(":scope > text")?.textContent ?? null };
    });
    assert.equal(hidden.clipNodes, 0, "a hidden node is not drawn as lane six");
    assert.equal(hidden.overflowNodes, 1, "a hidden node uses a neutral marker in the overflow gutter");
    assert.match(hidden.label ?? "", /^\+\d+$/, "hidden node row reports its hidden-lane count");
  }
}

async function assertHiddenNodeColor(targetPage) {
  const result = await targetPage.locator('[data-testid="commit-graph"][data-graph-lane]').evaluateAll(graphs => {
    const graph = graphs.find(candidate => Number(candidate.getAttribute("data-graph-lane")) >= 6);
    if (!graph) return null;
    const marker = graph.querySelector(":scope > circle");
    const label = graph.querySelector(":scope > text");
    return {
      markerFill: marker ? getComputedStyle(marker).fill : null,
      labelFill: label ? getComputedStyle(label).fill : null,
    };
  });
  assert.ok(result, "the initial visible graph window contains a node beyond the six visible lanes");
  assert.ok(result.markerFill && result.markerFill !== "rgba(0, 0, 0, 0)", `hidden node marker has a visible theme color: ${JSON.stringify(result)}`);
  assert.equal(result.markerFill, result.labelFill, "hidden node marker matches the +n label in light and dark themes");
}

async function readGraphSignature(targetPage, oid) {
  return targetPage.locator(`[data-testid="commit-row"][data-oid="${oid}"] [data-testid="commit-graph"]`).getAttribute("data-graph-signature");
}

async function graphMetrics(targetPage) {
  return targetPage.locator('[aria-label="提交"]').evaluate(element => {
    const graphs = [...element.querySelectorAll('[data-testid="commit-row"] [data-testid="commit-graph"]')];
    return {
      hiddenRows: graphs.filter(graph => Number(graph.getAttribute("data-graph-lane")) >= 6).length,
      overflowRows: graphs.filter(graph => Number(graph.getAttribute("data-graph-hidden-count")) > 0 && graph.querySelector("text")?.textContent?.startsWith("+")).length,
      graphRows: graphs.length,
    };
  });
}

async function readWindowMetrics(targetPage) {
  return targetPage.locator('[aria-label="提交"]').evaluate(element => ({
    offset: Number(element.dataset.loadedOffset),
    count: Number(element.dataset.loadedCount),
    domRows: element.querySelectorAll('[data-testid="commit-row"]').length,
  }));
}

async function readViewportAnchor(targetPage = page) {
  return targetPage.locator('[aria-label="提交"]').evaluate(element => {
    const listRect = element.getBoundingClientRect();
    const row = [...element.querySelectorAll('[data-testid="commit-row"]')].find(candidate => {
      const rect = candidate.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom;
    });
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { oid: row.getAttribute("data-oid"), offset: rect.top - listRect.top };
  });
}

async function assertAnchorNear(targetPage, anchor, action) {
  const row = targetPage.locator(`[data-testid="commit-row"][data-oid="${anchor.oid}"]`);
  await row.waitFor({ state: "attached", timeout: 5_000 });
  const listTop = await targetPage.locator('[aria-label="提交"]').evaluate(element => element.getBoundingClientRect().top);
  const rowTop = await row.evaluate(element => element.getBoundingClientRect().top);
  const actualOffset = rowTop - listTop;
  assert.ok(Math.abs(actualOffset - anchor.offset) <= 4,
    `${action} preserves OID ${anchor.oid} at its prior pixel offset: before=${anchor.offset}, after=${actualOffset}`);
}

async function assertBridgeAlignment(targetPage, testId) {
  const result = await targetPage.locator(`[data-testid="${testId}"]`).evaluateAll(elements => {
    let checked = 0;
    for (const bridge of elements) {
      const mask = Number(bridge.getAttribute("data-graph-above-mask"));
      if (!mask) continue;
      const container = bridge.closest('[role="presentation"], [role="separator"]');
      const next = container?.nextElementSibling;
      const initialBottom = bridge.getBoundingClientRect().bottom;
      for (let lane = 0; lane < 6; lane += 1) {
        if ((mask & (1 << lane)) === 0) continue;
        const expectedX = 7 + lane * 9;
        let previousBottom = initialBottom;
        let previousX = null;
        const findPathPoint = (graph, expectedStart, verticalOnly = false) => {
          const clip = [...graph.children].find(child => child.tagName.toLowerCase() === "svg");
          const path = [...(clip?.querySelectorAll(":scope > path") ?? [])].find(candidate => {
            const d = candidate.getAttribute("d") ?? "";
            return d.startsWith(`M${expectedStart} 0`) && (!verticalOnly || d.startsWith(`M${expectedStart} 0V`));
          });
          if (!path) return null;
          const point = path.getPointAtLength(0);
          return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
        };
        let start = findPathPoint(bridge, expectedX, true);
        if (!start) continue;
        if (previousX !== null && Math.abs(previousX - start.x) > 1) {
          return { checked, mismatch: { testId, lane, reason: "adjacent bridge x differs", previousX, startX: start.x } };
        }
        previousX = start.x;
        let cursor = next;
        while (cursor) {
          const bridgeContinuation = cursor.matches('[role="separator"]')
            ? cursor.querySelector('[data-testid="graph-day-bridge"], [data-testid="graph-last-seen-bridge"]') : null;
          if (bridgeContinuation) {
            start = findPathPoint(bridgeContinuation, expectedX, true);
            if (!start) break;
            if (Math.abs(start.y - previousBottom) > 1 || previousX !== null && Math.abs(previousX - start.x) > 1) {
              return { checked, mismatch: { testId, lane, reason: "separator bridge is discontinuous", expectedY: previousBottom, start: { x: start.x, y: start.y }, previousX } };
            }
            previousBottom = bridgeContinuation.getBoundingClientRect().bottom;
            cursor = cursor.nextElementSibling;
            continue;
          }
          if (cursor.matches('[data-testid="commit-row"]')) {
            const rowGraph = cursor.querySelector('[data-testid="commit-graph"]');
            const rowStart = rowGraph ? findPathPoint(rowGraph, expectedX) : null;
            if (!rowStart) break;
            if (Math.abs(previousBottom - rowStart.y) > 1 || previousX !== null && Math.abs(previousX - rowStart.x) > 1) {
              return { checked, mismatch: { testId, lane, reason: "bridge does not meet commit graph", expectedY: previousBottom, rowStart: { x: rowStart.x, y: rowStart.y }, previousX } };
            }
            checked += 1;
            break;
          }
          cursor = cursor.nextElementSibling;
        }
      }
    }
    return { checked };
  });
  assert.ok(!result.mismatch, `${testId} graph bridge aligns at lane x and row-boundary y: ${JSON.stringify(result.mismatch)}`);
  assert.ok(result.checked > 0, `${testId} has at least one visible graph connection to verify`);
}

async function assertZoomAndTheme(targetPage) {
  const target = await targetPage.locator('[data-testid="commit-graph"]').first().evaluate(element => element.closest('[data-testid="commit-row"]')?.getAttribute("data-oid"));
  assert.ok(target, "a visible commit graph has a containing history row");
  const row = targetPage.locator(`[data-testid="commit-row"][data-oid="${target}"]`);
  const signature = await readGraphSignature(targetPage, target);
  for (const zoom of [0.8, 1.25]) {
    await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), zoom);
    for (const theme of ["light", "dark"]) {
      await targetPage.emulateMedia({ colorScheme: theme });
      await targetPage.waitForFunction(value => document.documentElement.dataset.theme === value, theme, { timeout: 5_000 });
      await assertHiddenNodeColor(targetPage);
      const geometry = await row.evaluate(element => {
        const graph = element.querySelector('[data-testid="commit-graph"]');
        return { rowHeight: element.getBoundingClientRect().height, graphHeight: graph.getBoundingClientRect().height,
          rowTop: element.getBoundingClientRect().top, graphTop: graph.getBoundingClientRect().top,
          signature: graph.getAttribute("data-graph-signature"), theme: document.documentElement.dataset.theme };
      });
      assert.ok(Math.abs(geometry.rowHeight - geometry.graphHeight) <= 1,
        `graph SVG follows the commit row height at ${zoom}x/${theme}: ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.rowTop - geometry.graphTop) <= 1,
        `graph SVG starts at the commit row top at ${zoom}x/${theme}: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.signature, signature, "zoom and color theme do not change backend lane assignment");
      assert.equal(geometry.theme, theme);
      await targetPage.screenshot({ path: join(output, `p2-01-history-graph-${zoom}-${theme}.png`) });
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await targetPage.emulateMedia({ colorScheme: "light" });
  await targetPage.waitForFunction(() => document.documentElement.dataset.theme === "light", null, { timeout: 5_000 });
}
