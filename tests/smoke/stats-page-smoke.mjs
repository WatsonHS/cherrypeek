#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { snapshotTree } from "../repository/snapshot.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temp = await mkdtemp(join(tmpdir(), "commitscope-stats-smoke-"));
const repo = join(temp, "repo");
const userDataDir = join(temp, "user-data");
const shots = resolve(root, "output/playwright/stats-page");

const git = (args, { author = "Alice", email = "alice@example.test", daysAgo = 0 } = {}) => {
  const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=" + author, "-c", "user.email=" + email, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: date,
      },
    },
  ).trim();
};

const errors = [];
let app;
let page;

try {
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await mkdir(shots, { recursive: true });

  git(["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "src/core.ts"), "export const a = 1;\nexport const b = 2;\n");
  await writeFile(join(repo, "src/helper.ts"), "export const h = 1;\n");
  await writeFile(join(repo, "Cargo.lock"), Array.from({ length: 120 }, (_, i) => `pkg-${i} = "1.0.0"`).join("\n") + "\n");
  git(["add", "."]);
  git(["commit", "-qm", "feat: initial modules and lockfile"], { author: "Alice", email: "alice@example.test", daysAgo: 8 });

  await writeFile(join(repo, "src/core.ts"), "export const a = 10;\nexport const b = 2;\nexport const c = 3;\n");
  await writeFile(join(repo, "src/helper.ts"), "export const h = 10;\n");
  git(["add", "."]);
  git(["commit", "-qm", "fix: tune core and helper"], { author: "Alice", email: "alice@example.test", daysAgo: 5 });

  await writeFile(join(repo, "src/core.ts"), "export const a = 20;\nexport const b = 2;\nexport const c = 3;\n");
  await writeFile(join(repo, "src/helper.ts"), "export const h = 20;\n");
  await writeFile(join(repo, "src/core.test.ts"), "import { a } from './core';\nif (a !== 20) throw new Error('fail');\n");
  git(["add", "."]);
  git(["commit", "-qm", "test: cover core update"], { author: "Bob", email: "bob@example.test", daysAgo: 3 });

  await writeFile(join(repo, "docs/guide.md"), "# Guide\n\nUsage notes.\n");
  git(["add", "."]);
  git(["commit", "-qm", "docs: write guide"], { author: "Bob", email: "bob@example.test", daysAgo: 1 });

  await writeFile(join(repo, "src/core.ts"), "export const a = 30;\nexport const b = 2;\nexport const c = 3;\n");
  git(["add", "."]);
  git(["commit", "-qm", "refactor: latest core tweak"], { author: "Alice", email: "alice@example.test", daysAgo: 0 });

  const before = await snapshotTree(repo);

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
  await page.getByTestId("commit-row").first().waitFor({ timeout: 30_000 });

  // Switch to the Statistics page (⌘4).
  await page.keyboard.press("Meta+4");
  await page.getByTestId("stats-page").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="stats-coverage"]')?.textContent?.includes("索引已覆盖 5 个提交")
      && !document.querySelector('[data-testid="stats-partial"]'),
    null,
    { timeout: 30_000 },
  );
  assert.equal(await page.locator("[data-testid='stats-page'] [data-placeholder]").count(), 0, "no placeholder cards remain");
  await page.getByTestId("stats-authors").waitFor({ state: "visible" });
  await page.screenshot({ path: join(shots, "stats-activity.png") });

  // Brush a sub-interval across the activity bar chart, zoom in, and reset.
  const bars = page.locator("[data-testid='stats-page'] [role='group'][aria-label*='柱状图']").first();
  const box = await bars.boundingBox();
  assert.ok(box && box.width > 50);
  const brushSpan = async () => {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height * 0.5, { steps: 10 });
    await page.mouse.up();
    await page.getByTestId("stats-brush-actions").waitFor({ state: "visible" });
  };
  await brushSpan();
  await page.getByTestId("stats-brush-zoom").click();
  await page.getByTestId("stats-zoom-badge").waitFor({ state: "visible" });
  await page.getByTestId("stats-zoom-reset").click();
  await page.getByTestId("stats-zoom-badge").waitFor({ state: "detached" });

  // Brush again and inspect the brushed range on the commits page, then return cleanly.
  await brushSpan();
  await page.getByTestId("stats-brush-commits").click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='page-switch'] [aria-current='page']")?.getAttribute("data-testid") === "page-commits",
    null,
    { timeout: 10_000 },
  );
  await page.getByTestId("search-clear").click();
  await page.keyboard.press("Meta+4");
  await page.getByTestId("stats-authors").waitFor({ state: "visible" });

  // Changes section: directory drill-down and exclusions editor.
  await page.getByRole("group", { name: "统计分区" }).getByRole("button", { name: "改动", exact: true }).click();
  await page.getByTestId("stats-excluded").waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await page.getByTestId("stats-excluded").textContent(), /120\s*行/u);
  await page.getByTestId("stats-directories").getByRole("button", { name: /下钻到 src/u }).click();
  await page.waitForFunction(() => document.querySelector("nav[aria-label='目录路径'] [aria-current='true']")?.textContent === "src", null, { timeout: 15_000 });
  await page.getByTestId("stats-files").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "仓库根", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("nav[aria-label='目录路径'] [aria-current='true']")?.textContent === "仓库根", null, { timeout: 15_000 });

  await page.getByTestId("stats-exclusions-edit").click();
  const exclusionBox = page.getByLabel("排除规则，每行一条");
  await exclusionBox.waitFor({ state: "visible" });
  await exclusionBox.fill("package-lock.json");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-excluded"]')?.textContent?.includes("排除 0 行"), null, { timeout: 20_000 });
  await page.screenshot({ path: join(shots, "stats-changes.png") });

  // Notable section: churn, pairs, solo directories, and commit popover jump.
  await page.getByRole("group", { name: "统计分区" }).getByRole("button", { name: "关注", exact: true }).click();
  await page.getByTestId("stats-churn").waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await page.getByTestId("stats-churn").textContent(), /src\/core\.ts/u);
  assert.match(await page.getByTestId("stats-pairs").textContent(), /src\/helper\.ts/u);
  assert.match(await page.getByTestId("stats-solo").textContent(), /docs/u);
  await page.getByTestId("stats-commits-trigger").first().click();
  await page.getByRole("dialog", { name: /的提交/u }).getByRole("button").first().click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='page-switch'] [aria-current='page']")?.getAttribute("data-testid") === "page-commits",
    null,
    { timeout: 10_000 },
  );
  await page.keyboard.press("Meta+4");

  // Evolution section: estimate and analyze `src`.
  await page.getByRole("group", { name: "统计分区" }).getByRole("button", { name: "演化", exact: true }).click();
  await page.getByTestId("evolution-path").fill("src");
  await page.getByTestId("evolution-estimate").click();
  await page.getByTestId("evolution-estimate-result").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("evolution-start").click();
  await page.getByTestId("evolution-result").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="evolution-result"]')?.textContent?.includes("分析完成"), null, { timeout: 30_000 });
  assert.match(await page.getByTestId("evolution-result").textContent(), /代码年龄/u);
  assert.match(await page.getByTestId("evolution-result").textContent(), /当前归属/u);
  assert.match(await page.getByTestId("evolution-result").textContent(), /代码存活/u);
  await page.screenshot({ path: join(shots, "stats-evolution.png") });

  await app.close();
  app = undefined;

  assert.deepEqual(await snapshotTree(repo), before, "statistics smoke never writes to the repository");
  assert.deepEqual(errors, []);
  console.log("Stats page Electron smoke passed: all 4 sections real data, brush zoom & filter, drill-down, exclusions edit, notable commit popover, evolution analysis, read-only guard.");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
