#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { snapshotTree } from "../repository/snapshot.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temp = await mkdtemp(join(tmpdir(), "commitscope-batch-review-smoke-"));
const repo = join(temp, "repo");
const emptyRepo = join(temp, "empty");
const userDataDir = join(temp, "user-data");
const shots = resolve(root, "output/playwright/batch-review");

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=Base Author", "-c", "user.email=base@example.invalid", ...args], {
    encoding: "utf8",
  }).trim();

const errors = [];
let app;
let page;

async function waitForReady() {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="preview-state"]')?.getAttribute("data-state") === "ready",
    null,
    { timeout: 30_000 },
  );
}

try {
  await mkdir(repo, { recursive: true });
  await mkdir(emptyRepo, { recursive: true });
  await mkdir(shots, { recursive: true });

  git(emptyRepo, "init", "-q", "-b", "main");
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "app.ts"), "export const version = 0;\n");
  git(repo, "add", "app.ts");
  const baseUnix = Math.floor(Date.now() / 1000) - 5 * 86_400;
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=Base Author", "-c", "user.email=base@example.invalid", "commit", "-qm", "chore: baseline before burst"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `@${baseUnix} +0000`,
        GIT_COMMITTER_DATE: `@${baseUnix} +0000`,
      },
    },
  );
  const baseTip = git(repo, "rev-parse", "HEAD");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--repository=${repo}`, `--user-data-dir=${userDataDir}`],
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.getByTestId("commit-row").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitForReady();

  // Switch away to an empty repository so the first visit snapshot is durably saved into userData.
  await page.getByRole("button", { name: /^切换仓库/ }).click();
  await page.locator("#repository-path").fill(emptyRepo);
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByText("当前 HEAD 尚无提交。", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await waitForReady();

  const lastViewedPath = join(userDataDir, "repository-state", "last-viewed-tips-v1.json");
  let recorded = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const content = JSON.parse(await readFile(lastViewedPath, "utf8"));
      if (content.entries.some(entry => entry.snapshot.tips.includes(baseTip))) {
        recorded = true;
        break;
      }
    } catch {
      // Wait for persistence flush.
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(recorded, "first visit tip must be persisted before adding batch commits");

  // Simulate 220 high-frequency commits landed over the last 2 hours from two authors.
  const nowUnix = Math.floor(Date.now() / 1000);
  let fastImport = "";
  for (let index = 1; index <= 220; index += 1) {
    const ts = nowUnix - (220 - index) * 25;
    const author = index % 2 === 0 ? "Alice <alice@example.invalid>" : "Bob <bob@example.invalid>";
    const message = `feat: high-frequency commit #${index}`;
    const body = `export const step = ${index};\n`;
    fastImport += `commit refs/heads/main\nauthor ${author} ${ts} +0000\ncommitter ${author} ${ts} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
    if (index === 1) fastImport += `from ${baseTip}\n`;
    fastImport += `M 100644 inline src/mod-${index % 5}.ts\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  fastImport += "done\n";
  const imported = spawnSync("git", ["-C", repo, "fast-import", "--quiet"], { input: fastImport, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  git(repo, "reset", "--hard", "-q", "refs/heads/main");

  const repoBeforeUi = await snapshotTree(repo);

  // Reopen the burst repository from recent repositories.
  await page.getByRole("button", { name: /^切换仓库/ }).click();
  const repoPopover = page.getByRole("dialog");
  await repoPopover.getByText("最近打开", { exact: true }).waitFor({ state: "visible" });
  await repoPopover.getByRole("button", { name: /^repo/ }).first().click();
  await page.getByTestId("commit-row").first().waitFor({ state: "visible", timeout: 30_000 });
  await waitForReady();

  // 1. Overflow unseen banner (>200 commits -> divider not on first page) shows exact count 220.
  const overflowBanner = page.getByTestId("unseen-overflow-banner");
  await overflowBanner.waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await overflowBanner.innerText(), /自上次查看新增 220 个提交/u);
  await page.screenshot({ path: join(shots, "01-unseen-overflow-banner.png") });

  // 2. One-click filter from overflow banner activates batch chip and finds exact 220 commits.
  await page.getByTestId("unseen-overflow-filter").click();
  await page.getByTestId("active-search-chips").waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("chip-batch").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="search-status"]')?.textContent ?? "";
    return /220/.test(status) && !/部分/.test(status);
  }, null, { timeout: 30_000 });
  assert.match(await page.getByTestId("search-status").innerText(), /220/u);
  await page.screenshot({ path: join(shots, "02-batch-filtered-commits.png") });

  // 3. Jump to Statistics page directly from ActiveSearchChips; batch toggle + sub-day presets active.
  await page.getByTestId("search-open-stats").click();
  await page.getByTestId("stats-page").waitFor({ state: "visible", timeout: 15_000 });
  const batchToggle = page.getByTestId("stats-batch-toggle");
  await batchToggle.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await batchToggle.getAttribute("aria-pressed"), "true");
  const rangeGroup = page.getByRole("group", { name: "时间范围" });
  await rangeGroup.getByRole("button", { name: "3 小时", exact: true }).waitFor({ state: "visible" });
  await rangeGroup.getByRole("button", { name: "12 小时", exact: true }).waitFor({ state: "visible" });
  await rangeGroup.getByRole("button", { name: "自定义…", exact: true }).click();
  await page.getByTestId("stats-custom-mode-precise").click();
  await page.getByTestId("stats-custom-datetime-from").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const coverage = document.querySelector('[data-testid="stats-coverage"]')?.textContent ?? "";
    return /索引已覆盖/.test(coverage) && !/正在统计/.test(coverage);
  }, null, { timeout: 25_000 });
  await page.screenshot({ path: join(shots, "03-stats-batch-precise.png") });

  // 4. Switch back to Commits page, clear chips, test minute-precise + relative hour filter, then clear.
  await page.keyboard.press("Meta+1");
  await page.getByTestId("search-clear-all").click();
  await page.getByTestId("commit-row").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.getByTestId("search-filter-trigger").click();
  await page.getByTestId("search-add-condition").selectOption("time");
  await page.getByTestId("search-time-preset-3h").click();
  await page.getByTestId("search-datetime-from").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByTestId("chip-time").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="search-status"]')?.textContent ?? "";
    return /220/.test(status);
  }, null, { timeout: 25_000 });
  await page.getByTestId("search-clear-all").click();
  await page.getByTestId("unseen-overflow-banner").waitFor({ state: "visible", timeout: 15_000 });

  // 5. Hand off the 220-commit unseen batch to Agent and verify exact summary + clipboard payload.
  await page.getByTestId("unseen-overflow-handoff").click();
  await page.getByTestId("handoff-dialog").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const title = document.getElementById("handoff-title")?.textContent ?? "";
    const copy = document.querySelector('[data-testid="handoff-copy"]');
    return title.includes("220 个") && copy && !copy.disabled;
  }, null, { timeout: 25_000 });
  await page.getByTestId("handoff-copy").click();
  await page.waitForFunction(() => (
    document.querySelector('[data-testid="handoff-copy-status"]')?.textContent ?? ""
  ).includes("已复制"), null, { timeout: 10_000 });
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /这批精确共 220 个提交/u);
  assert.ok(Buffer.byteLength(copied, "utf8") <= 256 * 1024);
  assert.ok(copied.includes('"totalCount": 220'), "RANGE JSON carries exact totalCount");
  await page.screenshot({ path: join(shots, "04-handoff-220-commits.png") });
  await page.getByTestId("handoff-close").click();

  assert.deepEqual(await snapshotTree(repo), repoBeforeUi, "batch review flows must leave repository completely read-only");
  assert.deepEqual(errors, [], "no uncaught page errors expected");
  process.stdout.write("batch-review-smoke passed: 220 unseen banner, filter chip, stats batch/3h/precise mode, and 220-commit handoff copy.\n");
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
