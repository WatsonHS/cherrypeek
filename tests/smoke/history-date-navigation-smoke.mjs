#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const screenshotDirectory = resolve(root, "output/playwright/history-date-navigation");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-history-date-navigation-"));
const repository = join(temporaryRoot, "repository");
const profile = join(temporaryRoot, "user-data");
let app;
let page;

try {
  const fixture = await createDateFixture(repository);
  const before = await snapshotTree(repository);
  await mkdir(screenshotDirectory, { recursive: true });
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_OPTIONAL_LOCKS" && key !== "GIT_TERMINAL_PROMPT") delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${repository}`, `--user-data-dir=${profile}`],
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
    return element && Number(element.dataset.loadedCount) === 200 && element.querySelector('[data-testid="commit-row"]');
  }, null, { timeout: 20_000 });
  const initial = await readWindow(list);
  assert.equal(initial.offset, 0);
  assert.equal(initial.count, 200);

  // The pinned date opens a calendar; Esc and outside clicks close it.
  const slider = page.getByTestId("history-time-slider-track");
  await slider.waitFor({ state: "visible" });
  const trigger = page.getByTestId("history-date-trigger");
  const popover = page.getByTestId("history-date-popover");
  assert.equal(await trigger.getAttribute("data-day"), localDay(fixture.rows[0].timestamp), "the pinned date names the newest day");
  assert.equal(await page.getByTestId("history-newest").count(), 0, "at the newest commit there is nothing to go back to");
  await page.screenshot({ path: join(screenshotDirectory, "collapsed.png") });
  await trigger.click();
  await popover.waitFor({ state: "visible" });
  await page.getByTestId("history-calendar").waitFor({ state: "visible" });
  await page.screenshot({ path: join(screenshotDirectory, "calendar.png") });
  await page.locator('[aria-label="提交详情"]').click({ position: { x: 12, y: 12 } });
  await popover.waitFor({ state: "hidden" });
  await trigger.click();
  await popover.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "hidden" });

  // Pick the month in the month view, then the day.
  await trigger.click();
  await popover.waitFor({ state: "visible" });
  const [targetYear, targetMonth] = fixture.selectedDate.split("-").map(Number);
  await page.getByTestId("history-calendar-title").click();
  for (let guard = 0; guard < 5 && !(await page.getByTestId("history-calendar-title").innerText()).startsWith(`${targetYear} 年`); guard += 1) {
    await page.getByTestId("history-calendar-prev").click();
  }
  const monthCell = page.locator(`[data-testid="history-calendar-month"][data-month="${fixture.selectedDate.slice(0, 7)}"]`);
  assert.match(await monthCell.innerText(), /\d/, "the month view counts the month's commits");
  await monthCell.click();
  assert.equal(await page.getByTestId("history-calendar-title").innerText(), `${targetYear} 年 ${targetMonth} 月`);
  await page.locator(`[data-testid="history-calendar-day"][data-day="${fixture.selectedDate}"]`).click();
  const targetSelector = `[data-testid="commit-row"][data-oid="${fixture.expectedOid}"]`;
  await page.waitForFunction(oid => {
    const row = document.querySelector(`[data-testid="commit-row"][data-oid="${CSS.escape(oid)}"]`);
    return row?.getAttribute("aria-selected") === "true";
  }, fixture.expectedOid, { timeout: 20_000 });
  await page.locator(targetSelector).waitFor({ state: "visible", timeout: 10_000 });
  await popover.waitFor({ state: "hidden" });
  const located = await readWindow(list);
  assert.ok(fixture.expectedRank >= located.offset && fixture.expectedRank < located.offset + located.count,
    `the date result window contains independent Git target rank ${fixture.expectedRank}: ${JSON.stringify(located)}`);
  assert.ok(located.offset > 0, "the date jump loads beyond the initial newest 200 commits");
  assert.equal(await page.locator(`${targetSelector}[aria-selected="true"]`).getAttribute("data-oid"), fixture.expectedOid,
    "the selected date jumps to the max matching Committer timestamp in Git topo order");
  await page.screenshot({ path: join(screenshotDirectory, "located.png") });
  await page.waitForFunction(day => document.querySelector('[data-testid="history-date-trigger"]')?.dataset.day === day,
    localDay(fixture.rows[fixture.expectedRank].timestamp), { timeout: 5_000 });

  const previousEnd = located.offset + located.count;
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(previous => {
    const element = document.querySelector('[aria-label="提交"]');
    return element && element.dataset.pageLoading === "false" && Number(element.dataset.loadedOffset) + Number(element.dataset.loadedCount) > previous;
  }, previousEnd, { timeout: 20_000 });
  const continued = await readWindow(list);
  assert.ok(continued.offset + continued.count > previousEnd, "scrolling continues through the adjacent frozen history page");

  // Back to the newest commit: its page was dropped, so it is read again.
  await page.getByTestId("history-newest").click();
  await page.waitForFunction(oid => {
    const element = document.querySelector('[aria-label="提交"]');
    return element && element.dataset.pageLoading === "false" && Number(element.dataset.loadedOffset) === 0
      && element.querySelector('[data-testid="commit-row"]')?.getAttribute("data-oid") === oid;
  }, fixture.rows[0].oid, { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="history-newest"]'), null, { timeout: 5_000 });
  assert.equal(await trigger.getAttribute("data-day"), localDay(fixture.rows[0].timestamp));

  // The slider: hovering names a moment; dragging and releasing jumps to the latest commit before it.
  const sliderBox = await slider.boundingBox();
  const x = sliderBox.x + sliderBox.width / 2;
  await page.mouse.move(x, sliderBox.y + sliderBox.height * 0.5);
  const bubble = page.getByTestId("history-time-bubble");
  await bubble.waitFor({ state: "visible" });
  assert.match(await bubble.innerText(), /前后/);
  await page.screenshot({ path: join(screenshotDirectory, "slider-hover.png") });
  await page.mouse.down();
  await page.mouse.move(x, sliderBox.y + sliderBox.height * 0.62, { steps: 8 });
  await page.mouse.up();
  const released = Number(await bubble.getAttribute("data-seconds"));
  const expectedSlider = latestBefore(fixture.rows, Math.floor(released) + 1);
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute("data-oid") === oid
    && document.querySelector('[aria-label="提交"]')?.dataset.pageLoading === "false", expectedSlider.oid, { timeout: 20_000 });
  await page.screenshot({ path: join(screenshotDirectory, "slider-dragged.png") });
  await page.mouse.move(sliderBox.x - 300, sliderBox.y + 40);

  // Keyboard on the slider: two days older, Enter jumps.
  await slider.focus();
  await page.keyboard.press("PageDown");
  await page.keyboard.press("PageDown");
  await page.keyboard.press("Enter");
  const keyboardTarget = latestBefore(fixture.rows, expectedSlider.timestamp - 2 * 86_400 + 1);
  await page.waitForFunction(oid => document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute("data-oid") === oid,
    keyboardTarget.oid, { timeout: 20_000 });

  // Home in the list goes back to the newest commit.
  await list.focus();
  await page.keyboard.press("Home");
  await page.waitForFunction(oid => {
    const element = document.querySelector('[aria-label="提交"]');
    return element && Number(element.dataset.loadedOffset) === 0
      && document.querySelector('[data-testid="commit-row"][aria-selected="true"]')?.getAttribute("data-oid") === oid;
  }, fixture.rows[0].oid, { timeout: 20_000 });
  assert.deepEqual(await snapshotTree(repository), before, "date navigation, the slider and continued scrolling are read-only");

  await app.close();
  app = undefined;
  process.stdout.write(`History date navigation smoke passed: ${fixture.rows.length} commits across ${fixture.yearCount} calendar years; target rank ${fixture.expectedRank}; read-only snapshot. Screenshots: ${screenshotDirectory}\n`);
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

async function createDateFixture(path) {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", path], { env: cleanGitEnvironment() });
  git(path, "config", "user.name", "History Date Smoke");
  git(path, "config", "user.email", "history-date@example.invalid");
  git(path, "config", "gc.auto", "0");
  git(path, "config", "maintenance.auto", "false");

  const count = 450;
  const newestNoonUtc = Date.UTC(2027, 0, 1, 4, 0, 0) / 1000;
  const timestamps = Array.from({ length: count }, (_, index) => newestNoonUtc - index * 86_400);
  const chosenRank = 320;
  timestamps[350] = timestamps[chosenRank] + 3_600;
  const input = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const message = `Date navigation ${String(index).padStart(3, "0")}`;
    input.push(`commit refs/heads/main\nmark :${index + 1}\nauthor History Date Smoke <history-date@example.invalid> ${timestamps[index]} +0800\ncommitter History Date Smoke <history-date@example.invalid> ${timestamps[index]} +0800\ndata ${Buffer.byteLength(message)}\n${message}\n${index < count - 1 ? `from :${index + 2}\n` : ""}\n`);
  }
  input.push("done\n");
  await runFastImport(path, input.join(""));

  const rows = git(path, "log", "--topo-order", "--format=%H%x09%ct", "HEAD").split("\n").filter(Boolean).map(line => {
    const [oid, timestamp] = line.split("\t");
    return { oid, timestamp: Number(timestamp) };
  });
  assert.equal(rows.length, count, "the fast-import fixture contains the expected real Git commits");
  const chosenTimestamp = timestamps[chosenRank];
  const chosenDate = new Date(chosenTimestamp * 1000);
  const selectedDate = `${chosenDate.getFullYear()}-${String(chosenDate.getMonth() + 1).padStart(2, "0")}-${String(chosenDate.getDate()).padStart(2, "0")}`;
  const [year, month, day] = selectedDate.split("-").map(Number);
  const beforeTimestamp = Math.floor(new Date(year, month - 1, day + 1).getTime() / 1000);
  let expectedIndex = -1;
  let maximumTimestamp = Number.NEGATIVE_INFINITY;
  for (const [index, row] of rows.entries()) {
    if (row.timestamp < beforeTimestamp && row.timestamp > maximumTimestamp) {
      expectedIndex = index;
      maximumTimestamp = row.timestamp;
    }
  }
  assert.ok(expectedIndex >= 200, "the expected date target is outside the initial history page");
  assert.equal(rows[expectedIndex].timestamp, timestamps[350], "the later-topology timestamp inversion is the maximum match for the selected day");
  const years = new Set(rows.map(row => {
    const date = new Date(row.timestamp * 1000);
    return `${date.getFullYear()}`;
  }));
  assert.ok(years.size >= 2, "fixture spans a year boundary");
  return { rows, selectedDate, expectedOid: rows[expectedIndex].oid, expectedRank: expectedIndex, yearCount: years.size };
}

function localDay(timestamp) {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The commit a jump before `beforeSeconds` should select: the max committer time before it. */
function latestBefore(rows, beforeSeconds) {
  let best = null;
  for (const row of rows) if (row.timestamp < beforeSeconds && (!best || row.timestamp > best.timestamp)) best = row;
  return best;
}

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", env: cleanGitEnvironment(), timeout: 15_000 }).trim();
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

function runFastImport(repository, input) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", ["-C", repository, "-c", "core.fsmonitor=false", "fast-import", "--quiet"], {
      cwd: root, env: cleanGitEnvironment(), stdio: ["pipe", "ignore", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.stdin.on("error", () => {});
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", error => { clearTimeout(timeout); rejectRun(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return rejectRun(new Error(`fast-import exited ${code ?? signal}: ${stderr}`));
      resolveRun();
    });
    child.stdin.end(input);
  });
}

async function readWindow(list) {
  return list.evaluate(element => ({
    offset: Number(element.dataset.loadedOffset),
    count: Number(element.dataset.loadedCount),
    pageLoading: element.dataset.pageLoading,
  }));
}
