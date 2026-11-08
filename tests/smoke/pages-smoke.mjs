// Electron smoke for the v4 pages (P4-09 to P4-12): page switching, scoped search, workspace and files pages.
//
//   node tests/smoke/pages-smoke.mjs             real core: pages switch, and pages whose capability the core
//                                                does not declare show their labelled placeholder
//   node tests/smoke/pages-smoke.mjs --stand-in  test stand-in core (tests/smoke/support/stand-in-core.mjs)
//                                                answering the new methods from git, to drive the full flows
//
// The stand-in only exercises the renderer; it is not acceptance evidence for the daemon methods.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { git } from "../navigation/fixture.mjs";
import { snapshotTree } from "../repository/snapshot.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
const standIn = process.argv.includes("--stand-in");
const temporaryRoot = await mkdtemp(join(tmpdir(), "commitscope-pages-smoke-"));
const repository = join(temporaryRoot, "repository");
const screenshotDir = resolve(root, "output/playwright");
await mkdir(screenshotDir, { recursive: true });

// A small repository: a file renamed in the second commit and changed in the third, plus one change of each workspace kind.
await mkdir(join(repository, "src"), { recursive: true });
await mkdir(join(repository, "docs"), { recursive: true });
await git(repository, ["init", "-q", "-b", "main"]);
const commit = async (message, day) => git(repository, ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.com", "commit", "-q", "-m", message],
  { env: { GIT_AUTHOR_DATE: `2026-11-0${day}T10:00:00+08:00`, GIT_COMMITTER_DATE: `2026-11-0${day}T10:00:00+08:00` } });
const lines = count => Array.from({ length: count }, (_, index) => `export const value${index + 1} = ${index + 1};`);
await writeFile(join(repository, "src/old-name.ts"), `${lines(30).join("\n")}\n`);
await writeFile(join(repository, "README.md"), "# Smoke\n\nFirst version.\n");
await writeFile(join(repository, "docs/a.md"), "alpha\n");
await git(repository, ["add", "."]);
await commit("feat: add the first files", 1);
await git(repository, ["mv", "src/old-name.ts", "src/app.ts"]);
const renamed = lines(30);
renamed[4] = "export const value5 = 50;";
await writeFile(join(repository, "src/app.ts"), `${renamed.join("\n")}\n`);
await git(repository, ["add", "."]);
await commit("refactor: rename the module", 2);
renamed[19] = "export const value20 = 200;";
renamed[20] = "export const value21 = 210;";
await writeFile(join(repository, "src/app.ts"), `${renamed.join("\n")}\n`);
await git(repository, ["add", "."]);
await commit("fix: adjust two values", 3);
await writeFile(join(repository, "README.md"), "# Smoke\n\nSecond version.\n");
await writeFile(join(repository, "docs/a.md"), "alpha\nbeta\n");
await git(repository, ["add", "docs/a.md"]);
await writeFile(join(repository, "notes.txt"), "an untracked note\n");
const before = await snapshotTree(repository);

// The stand-in runs from a copy of the build whose core executable is a wrapper around it.
let appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (standIn) {
  const dist = join(temporaryRoot, "dist");
  await cp(resolve(root, "apps/desktop/dist"), dist, { recursive: true });
  await writeFile(join(dist, "resources/commitscope-daemon"), `#!/bin/sh\nexec "${process.execPath}" "${resolve(root, "tests/smoke/support/stand-in-core.mjs")}" "$@"\n`);
  await chmod(join(dist, "resources/commitscope-daemon"), 0o755);
  appEntry = join(dist, "main/index.cjs");
  env.COMMITSCOPE_STAND_IN_REAL_CORE = resolve(root, "apps/desktop/dist/resources/commitscope-daemon");
  env.COMMITSCOPE_STAND_IN_REPOSITORY = repository;
}
const profile = join(temporaryRoot, "electron-user-data");
const app = await electron.launch({ executablePath: require("electron"), args: [appEntry, `--repository=${repository}`, `--user-data-dir=${profile}`], env, chromiumSandbox: true });
const diagnostics = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", error => diagnostics.push(`pageerror: ${error.stack}`));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.getByTestId("commit-row").first().waitFor({ timeout: 40_000 });
  const capabilities = (await page.evaluate(() => window.commitScope.getCoreStatus())).core.capabilities;
  const has = name => capabilities.includes(name);
  assert.ok(["workspaceStatus", "fileBrowsing", "diffFullContext", "blame"].every(has), "the core declares the P4-09 to P4-12 capabilities");
  assert.equal(new Set(capabilities).size, capabilities.length, "capabilities are not repeated");
  const current = async () => page.getByTestId("page-switch").locator("[aria-current='page']").getAttribute("data-testid");
  const scope = async () => (await page.getByTestId("search-scope").first().textContent())?.trim();

  // Page switching, shortcuts and the search scope written in the box.
  assert.equal(await current(), "page-commits");
  assert.equal(await scope(), "提交消息");
  await page.keyboard.press("Meta+3");
  assert.equal(await current(), "page-workspace");
  assert.equal(await scope(), "改动的文件");
  await page.keyboard.press("Meta+2");
  assert.equal(await current(), "page-files");
  assert.equal(await scope(), "文件页");
  await page.getByTestId("page-commits").click();
  assert.equal(await current(), "page-commits");
  await page.getByTestId("commit-row").first().waitFor();

  // Workspace page.
  await page.keyboard.press("Meta+3");
  if (!has("workspaceStatus")) {
    assert.equal(await page.locator("[data-testid='workspace-page'] [data-placeholder='P4-09']").count() > 0, true, "the workspace page is a labelled placeholder");
  } else {
    await page.getByTestId("workspace-file").first().waitFor({ timeout: 20_000 });
    const files = await page.getByTestId("workspace-file").evaluateAll(rows => rows.map(row => row.getAttribute("aria-label")));
    assert.deepEqual(files.sort(), ["已暂存：docs/a.md", "未暂存：README.md", "未跟踪：notes.txt"]);
    assert.equal((await page.getByTestId("workspace-badge").textContent())?.trim(), "3", "the badge counts files by path");
    await page.getByTestId("workspace-file").filter({ hasText: "notes.txt" }).click();
    await page.getByTestId("workspace-file-text").waitFor();
    assert.match(await page.getByTestId("workspace-file-text").textContent() ?? "", /an untracked note/);
    await page.screenshot({ path: join(screenshotDir, "pages-workspace.png") });
  }

  // Files page.
  await page.keyboard.press("Meta+2");
  if (!has("fileBrowsing")) {
    assert.equal(await page.locator("[data-testid='files-page'][data-placeholder='P4-10'], [data-testid='files-page'] [data-placeholder='P4-10']").count() > 0, true, "the files page is a labelled placeholder");
  } else {
    const tree = name => page.getByTestId("tree-row").filter({ hasText: new RegExp(`^${name.replace(/[.]/g, "\\.")}$`) }).first();
    await tree("src").waitFor({ timeout: 15_000 });
    assert.deepEqual(await page.getByTestId("tree-row").evaluateAll(rows => rows.map(row => row.textContent?.trim())), ["docs", "src", "README.md"], "directories first");
    await tree("src").click();
    await tree("app.ts").click();
    await page.getByTestId("file-content").waitFor();
    assert.equal(await page.locator("[data-testid='file-content'] [data-line]").count(), 30);
    await page.keyboard.press("Meta+f");
    await page.keyboard.type("value2");
    await delay(200);
    assert.match(await page.getByTestId("find-count").textContent() ?? "", /^1 \/ 11$/u, "value2 and value20 to value29");
    await page.getByLabel("在文件内容中查找").fill("");

    if (has("blame")) {
      await page.getByTestId("blame-toggle").click();
      await page.locator("[data-line='1'] [data-testid='blame-cell']").waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(screenshotDir, "pages-blame.png") });
      // Line 1 comes from before the rename: its history is the old path's.
      await page.locator("[data-line='1'] [data-testid='blame-cell']").click();
      await page.getByTestId("return-to-line").waitFor({ timeout: 15_000 });
      assert.match(await page.locator("nav[aria-label='路径']").textContent() ?? "", /old-name\.ts/u);
      await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
      await page.screenshot({ path: join(screenshotDir, "pages-blame-located.png") });
      await page.getByTestId("return-to-line").click();
      await page.getByTestId("file-content").waitFor();
      assert.match(await page.locator("nav[aria-label='路径']").textContent() ?? "", /app\.ts/u);
    }

    await page.getByTestId("files-tab-history").click();
    await page.getByTestId("file-history-row").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId("file-history-row").count(), 2, "literal path history: the rename and the later change");
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    await page.keyboard.press("Alt+d");
    await page.getByTestId("history-float-toggle").waitFor();
    await page.screenshot({ path: join(screenshotDir, "pages-history-split.png") });
    await page.keyboard.press("Alt+d");

    // Entry from the commit details.
    await page.keyboard.press("Meta+1");
    await page.keyboard.press("Alt+Meta+2");
    await page.getByTestId("open-file-history").first().click();
    assert.equal(await current(), "page-files");
    await page.getByTestId("file-history-row").first().waitFor({ timeout: 15_000 });
  }

  assert.deepEqual(await snapshotTree(repository), before, "reading the repository and its working tree changed nothing");
  assert.deepEqual(diagnostics, []);
  process.stdout.write(`Electron pages smoke passed (${standIn ? "stand-in core: workspace, files, blame and history flows" : `real core: switching and pages for ${["workspaceStatus", "fileBrowsing", "blame"].filter(has).join(", ") || "no new capabilities (placeholders)"}`}).\n`);
} catch (error) {
  if (page) await page.screenshot({ path: join(screenshotDir, "pages-smoke-failure.png") }).catch(() => undefined);
  process.stderr.write(`${diagnostics.join("\n")}\n`);
  throw error;
} finally {
  await app.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}
