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
await writeFile(join(repository, "src/long.ts"), `${lines(400).join("\n")}\n`);
await writeFile(join(repository, "src/huge.ts"), `${lines(5_100).join("\n")}\n`);
await writeFile(join(repository, "README.md"), "# Smoke\n\nFirst version.\n");
await writeFile(join(repository, "docs/a.md"), "alpha\n");
await writeFile(join(repository, "docs/inject.html"), "<img src=x onerror=\"window.__injected=1\">\n<script>window.__injected=2</script>\n<b>not bold</b>\n");
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
await writeFile(join(repository, "notes.txt"), `an untracked note\n${Array.from({ length: 299 }, (_, index) => `note line ${index + 2}`).join("\n")}\n`);
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

    // Clicking a folder only browses: the tree changes, the open file stays on the right.
    const showsAppContent = async label => {
      assert.equal(await page.getByTestId("change-panel").count(), 0, `${label}: no change covers the file`);
      assert.match(await page.locator("nav[aria-label='路径'] [aria-current='page']").textContent() ?? "", /^app\.ts$/u, `${label}: still on app.ts`);
      assert.equal(await page.locator("[data-testid='file-content'] [data-line]").count(), 30, `${label}: the content is still shown`);
    };
    await tree("docs").click();
    await tree("a.md").waitFor();
    await showsAppContent("expanding a folder in the tree");
    await tree("docs").click();
    await tree("src").click();
    assert.equal(await tree("src").getAttribute("aria-expanded"), "false");
    await page.getByTestId("crumb-directory").filter({ hasText: /^src$/u }).click();
    await tree("app.ts").waitFor();
    assert.equal(await tree("src").getAttribute("aria-expanded"), "true", "the path's folder is shown in the tree");
    await showsAppContent("clicking a folder in the path");
    // Directory history is its own explicit action; a picked commit lists the files it changed there, each with its diff.
    await page.locator("[data-testid='tree-row'][data-path-hex='" + Buffer.from("src").toString("hex") + "'] + [data-testid='directory-history']").click();
    await page.getByTestId("history-column").waitFor();
    assert.match(await page.locator("nav[aria-label='路径'] [aria-current='page']").textContent() ?? "", /^src$/u);
    await page.getByTestId("path-change-row").first().waitFor({ timeout: 15_000 });
    assert.match(await page.getByTestId("path-changes").textContent() ?? "", /src 下 1 个文件/u, "the newest commit under src changed app.ts only");
    await page.getByTestId("path-change-row").first().click();
    await page.getByTestId("path-change-diff").waitFor({ timeout: 15_000 });
    await page.getByTestId("history-toggle").click();
    await tree("app.ts").click();
    await page.locator("[data-testid='file-content'] [data-line='30']").waitFor({ timeout: 15_000 });

    await page.keyboard.press("Meta+f");
    await page.keyboard.type("value2");
    await delay(200);
    assert.match(await page.getByTestId("find-count").textContent() ?? "", /^1 \/ 11$/u, "value2 and value20 to value29");
    await page.getByLabel("在文件内容中查找").fill("");

    if (has("blame")) {
      await page.getByTestId("blame-toggle").click();
      await page.locator("[data-line='1'] [data-testid='blame-cell']").waitFor({ timeout: 20_000 });
      await page.waitForFunction(() => document.querySelectorAll("[data-testid='file-content'] [data-testid='blame-cell']").length === 30, null, { timeout: 20_000 });
      // Like JetBrains' annotations: every line has its own date and author, in one gutter sized to the text.
      const gutter = await page.evaluate(() => [...document.querySelectorAll("[data-testid='file-content'] [data-testid='blame-cell']")]
        .map(cell => ({ text: cell.textContent ?? "", width: Math.round(cell.getBoundingClientRect().width) })));
      assert.ok(gutter.every(cell => cell.text.includes("Smoke")), "every line names its author");
      assert.equal(new Set(gutter.map(cell => cell.width)).size, 1, "all lines share one gutter width");
      assert.ok(gutter[0].width < 212, `the gutter is sized to its text (${gutter[0].width}px)`);
      // Hovering any line opens its commit card; moving away closes it.
      await page.locator("[data-line='5'] [data-testid='blame-cell']").hover();
      await page.getByTestId("blame-card").waitFor({ timeout: 5_000 });
      assert.match(await page.getByTestId("blame-card").textContent() ?? "", /refactor: rename the module/u);
      await page.mouse.move(5, 5);
      await page.getByTestId("blame-card").waitFor({ state: "detached", timeout: 5_000 });
      await page.screenshot({ path: join(screenshotDir, "pages-blame.png") });
      // A blame click opens that commit's change over the file, with the history column, and says where the way back is.
      await page.locator("[data-line='1'] [data-testid='blame-cell']").click();
      const back = page.getByTestId("back-to-file");
      await back.waitFor({ timeout: 15_000 });
      assert.equal((await back.textContent())?.trim(), "app.ts 第 1 行");
      await page.getByTestId("history-column").waitFor();
      await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
      await page.locator("[data-marked='true']").first().waitFor({ timeout: 15_000 });
      // The clicked line is only highlighted; its explanation is a tooltip, not text in the code.
      assert.equal(await page.locator("[data-marked='true']").first().getAttribute("title"), "你在内容页点的第 1 行");
      assert.doesNotMatch(await page.getByTestId("diff-lines").textContent() ?? "", /你点的|你在内容页/u);
      assert.equal(await back.evaluate(element => element.closest(".overflow-auto") === null), true, "the way back is in the header, outside the scrolling diff");
      // Line 1 comes from before the rename: the column offers the old path's history, where that commit is.
      await page.getByTestId("renamed-history").click();
      await page.waitForFunction(() => document.querySelector("nav[aria-label='路径']")?.textContent?.includes("old-name.ts"), null, { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelector("[data-testid='file-history-row'][aria-pressed='true']") !== null, null, { timeout: 15_000 });
      await page.screenshot({ path: join(screenshotDir, "pages-blame-located.png") });
      await back.click();
      await page.getByTestId("change-panel").waitFor({ state: "detached" });
      assert.match(await page.locator("nav[aria-label='路径'] [aria-current='page']").textContent() ?? "", /^app\.ts$/u, "back returns to the file the blame was on");
      await page.locator("[data-testid='file-content'] [data-line='1'][data-marked='true']").waitFor({ timeout: 5_000 });
    }

    // The history column: the literal path's history; ↑ / ↓ step through it, showing each change over the file.
    if (!await page.getByTestId("history-column").isVisible().catch(() => false)) await page.getByTestId("history-toggle").click();
    await page.getByTestId("file-history-row").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId("file-history-row").count(), 2, "literal path history: the rename and the later change");
    await page.getByTestId("file-history-row").first().click();
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='file-history-row']")[1]?.getAttribute("aria-pressed") === "true", null, { timeout: 5_000 });
    assert.match(await page.getByTestId("change-panel").textContent() ?? "", /refactor: rename the module/u, "↓ shows the next commit's change");
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='file-history-row']")[0]?.getAttribute("aria-pressed") === "true", null, { timeout: 5_000 });
    // The file as it was in that commit, without comparing.
    await page.getByTestId("change-view-file").click();
    await page.locator("[data-testid='revision-content'] [data-revision-line='30']").waitFor({ timeout: 15_000 });
    assert.match(await page.locator("[data-testid='revision-content'] [data-revision-line='20']").textContent() ?? "", /value20 = 200;/u, "the newest commit's version");
    assert.equal(await page.locator("[data-testid='revision-content'] [data-revision-line]").count(), 30);
    await page.getByTestId("change-view-diff").click();
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    // A narrower window keeps the change header's commit buttons whole.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1200, 900));
    await page.waitForFunction(() => window.innerWidth === 1200);
    await delay(150);
    const header = await page.getByTestId("open-full-commit").evaluate(button => {
      const panel = button.closest("[data-testid='change-panel']").getBoundingClientRect();
      const box = button.getBoundingClientRect();
      return { inside: box.right <= panel.right + 0.5, whole: button.scrollWidth <= button.clientWidth + 1 };
    });
    assert.deepEqual(header, { inside: true, whole: true }, "查看完整提交 is not cut at 1200px");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
    await page.waitForFunction(() => window.innerWidth === 1440);
    // Side by side, the history column stays a column (no floating list).
    await page.keyboard.press("Alt+d");
    await page.locator("[data-testid='diff-view'][data-layout='split']").waitFor({ timeout: 5_000 });
    assert.ok(await page.getByTestId("history-column").isVisible());
    await page.screenshot({ path: join(screenshotDir, "pages-history-split.png") });
    await page.keyboard.press("Alt+d");
    await page.keyboard.press("Escape");
    await page.getByTestId("change-panel").waitFor({ state: "detached" });

    // From a commit's changed file to the file itself on the files page, with the way back to that commit.
    await page.keyboard.press("Meta+1");
    await page.keyboard.press("Alt+Meta+2");
    await page.getByTestId("open-in-files").first().click();
    assert.equal(await current(), "page-files");
    // Right after the jump, the top bar's back button names the commit it came from.
    const backHint = page.locator("[data-hint='true']");
    await backHint.waitFor();
    assert.match(await backHint.textContent() ?? "", /提交 [0-9a-f]{7,}/u);
    assert.equal(await page.getByTestId("change-panel").count(), 0, "it opened the file, not a change in its history");
    await page.locator("[data-testid='file-view'] [data-testid='file-content'] [data-line='30']").waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId("change-panel").count(), 0, "the file itself is shown, not a change");
    // Back / forward: ⌘[ returns to the commit the jump came from, ⌘] comes back to the file.
    const onPage = id => page.waitForFunction(expected => document.querySelector("[data-testid='page-switch'] [aria-current='page']")?.getAttribute("data-testid") === expected, id, { timeout: 10_000 });
    assert.match(await page.getByTestId("nav-back").getAttribute("title") ?? "", /^后退到 提交 [0-9a-f]{7,}/u);
    await page.keyboard.press("Meta+BracketLeft");
    await onPage("page-commits");
    assert.match(await page.getByTestId("nav-forward").getAttribute("title") ?? "", /^前进到 app\.ts/u);
    await page.keyboard.press("Meta+BracketRight");
    await onPage("page-files");
    await page.locator("[data-testid='file-view'] [data-testid='file-content'] [data-line='30']").waitFor({ timeout: 15_000 });
    await page.getByTestId("nav-back").click();
    await onPage("page-commits");
    await page.getByTestId("nav-forward").click();
    await onPage("page-files");
    if (!await page.getByTestId("history-column").isVisible().catch(() => false)) await page.getByTestId("history-toggle").click();
    await page.getByTestId("file-history-row").first().waitFor({ timeout: 15_000 });

    // Round trip: 查看完整提交 → back. The history filter, the chosen entry and the open change survive.
    await page.getByTestId("history-filter").fill("adjust");
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='file-history-row']").length === 1, null, { timeout: 15_000 });
    await page.getByTestId("file-history-row").first().click();
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    await page.getByTestId("open-full-commit").click();
    assert.equal(await current(), "page-commits");
    await page.waitForFunction(() => document.querySelector("[role='option'][aria-selected='true']")?.textContent?.includes("adjust two values"), null, { timeout: 15_000 });
    await backHint.waitFor();
    assert.equal((await backHint.textContent() ?? "").trim(), "app.ts", "the back button names the file it came from");
    await page.getByTestId("nav-back").click();
    assert.equal(await current(), "page-files");
    assert.equal(await backHint.count(), 0, "the named way back is gone once back");
    assert.equal(await page.getByTestId("history-filter").inputValue(), "adjust", "the history filter is kept");
    assert.equal(await page.getByTestId("file-history-row").count(), 1);
    assert.equal(await page.getByTestId("file-history-row").first().getAttribute("aria-pressed"), "true", "the chosen history entry is kept");
    assert.ok(await page.getByTestId("change-panel").isVisible(), "the open change is kept");
    await page.getByTestId("history-filter").fill("");
    await page.getByTestId("back-to-file").click();

    // Shortcuts keep one meaning on every page: ⌥H shows or hides the history column (a display toggle like ⌥B), ⌥⌘2
    // opens the file's change (the newest in its history) and ⌥⌘1 returns to the file, like 概览 / 文件改动 on the commits page.
    await page.keyboard.press("Alt+h");
    await page.getByTestId("history-column").waitFor({ state: "hidden" });
    await page.keyboard.press("Alt+h");
    await page.getByTestId("history-column").waitFor();
    await page.keyboard.press("Alt+Meta+2");
    await page.getByTestId("change-panel").waitFor({ timeout: 15_000 });
    assert.equal(await page.getByTestId("file-history-row").first().getAttribute("aria-pressed"), "true", "⌥⌘2 opens the newest change");
    await page.keyboard.press("Alt+Meta+1");
    await page.getByTestId("change-panel").waitFor({ state: "detached" });

    // The change view's commit bar: details folded until opened, and a switcher through every file of the commit (a root
    // commit here, no parent); another file opens in place with the same commit picked, and ⌘[ returns file by file.
    const crumbIs = name => page.waitForFunction(expected => document.querySelector("nav[aria-label='路径'] [aria-current='page']")?.textContent === expected, name, { timeout: 15_000 });
    await tree("long.ts").click();
    await page.getByTestId("file-history-row").filter({ hasText: "add the first files" }).click();
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    // The switcher lists the root commit's 6 files (README.md, docs/a.md, docs/inject.html, src/huge.ts, src/long.ts,
    // src/old-name.ts) with long.ts current; the details open above the diff.
    const fileMenu = page.getByTestId("commit-file-menu");
    const menuShows = text => page.waitForFunction(expected => (document.querySelector("[data-testid='commit-file-menu']")?.textContent ?? "").replace(/\s+/gu, "").startsWith(expected),
      text, { timeout: 15_000 });
    await menuShows("5/6");
    const infoToggle = page.getByTestId("commit-info-toggle");
    await infoToggle.click();
    await page.getByTestId("commit-info-panel").getByText("无（根提交）").waitFor({ timeout: 15_000 });
    await infoToggle.click();
    // ‹ steps to the previous file of the commit, the same commit still picked; ⌘[ returns.
    await page.getByTestId("commit-file-previous").click();
    await crumbIs("huge.ts");
    await menuShows("4/6");
    assert.match(await page.locator("[data-testid='file-history-row'][aria-pressed='true']").textContent() ?? "", /add the first files/u, "the same commit stays picked");
    await page.keyboard.press("Meta+BracketLeft");
    await crumbIs("long.ts");
    // Or pick any file from the list.
    await menuShows("5/6");
    await fileMenu.click();
    await page.getByTestId("commit-file-list").waitFor();
    assert.equal(await page.getByTestId("commit-info-file").count(), 6);
    assert.match(await page.locator("[data-testid='commit-info-file'][aria-current='true']").textContent() ?? "", /src\/long\.ts/u);
    await page.getByTestId("commit-info-file").filter({ hasText: "README.md" }).click();
    await crumbIs("README.md");
    await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
    await menuShows("1/6");
    assert.equal(await page.getByTestId("commit-file-previous").isDisabled(), true, "README.md is the first file");
    await page.keyboard.press("Meta+BracketLeft");
    await crumbIs("long.ts");
    await page.getByTestId("change-panel").waitFor();
    await page.getByTestId("back-to-file").click();

    // Switching pages keeps the files page's file and scroll position.
    await tree("long.ts").click();
    await page.locator("[data-testid='file-content'] [data-line='400']").waitFor({ timeout: 15_000 });
    const fileScroll = await page.locator("[data-testid='file-view'] [data-testid='file-content']").evaluate(element => { element.scrollTop = 1500; return element.scrollTop; });
    assert.ok(fileScroll > 1000, "the long file scrolls");
    await page.keyboard.press("Meta+1");
    await page.keyboard.press("Meta+2");
    assert.equal(await tree("long.ts").getAttribute("aria-current"), "true");
    assert.equal(await page.locator("[data-testid='file-view'] [data-testid='file-content']").evaluate(element => element.scrollTop), fileScroll, "the files page keeps its scroll position");

    // Markup in a file is shown as text, before and after syntax highlighting, and never runs.
    await tree("docs").click();
    assert.equal(await tree("long.ts").getAttribute("aria-current"), "true", "expanding a folder preserves the selected file");
    await page.getByTestId("file-content").waitFor();
    await tree("inject.html").click();
    await page.locator("[data-testid='file-content'] [data-line='3']").waitFor({ timeout: 15_000 });
    const injected = async () => page.evaluate(() => {
      const content = document.querySelector("[data-testid='file-content']");
      // The code of each line is its last span; line numbers are not selectable and the blame gutter is separate.
      const text = [...content.querySelectorAll("[data-line] > span:last-child")].map(span => span.textContent).join("\n");
      return { text, elements: content.querySelectorAll("img, script, b").length, ran: window.__injected ?? null };
    });
    const plain = await injected();
    await page.waitForFunction(() => document.querySelectorAll("[data-testid='file-content'] [class*='text-syn-']").length > 3, null, { timeout: 15_000 });
    const highlighted = await injected();
    assert.equal(highlighted.text, plain.text, "highlighting does not change the text a copy would take");
    for (const [label, state] of [["before highlighting", plain], ["after highlighting", highlighted]]) {
      assert.ok(state.text.includes("<img src=x onerror=\"window.__injected=1\">") && state.text.includes("<script>window.__injected=2</script>"), `${label}: the markup is shown literally`);
      assert.equal(state.elements, 0, `${label}: no element is created from file text`);
      assert.equal(state.ran, null, `${label}: nothing from the file ran`);
    }

    if (!standIn && has("diffFullContext")) {
      // "完整文件" on a file over its limit shows the changes, with a note saying why.
      await tree("huge.ts").click();
      if (!await page.getByTestId("history-column").isVisible().catch(() => false)) await page.getByTestId("history-toggle").click();
      await page.getByTestId("file-history-row").first().click();
      await page.getByTestId("file-change").waitFor({ timeout: 15_000 });
      assert.equal(await page.getByTestId("diff-full-limited").count(), 0, "no note in the changes-only mode");
      await page.keyboard.press("Alt+f");
      await page.getByTestId("diff-full-limited").waitFor({ timeout: 15_000 });
      assert.match(await page.getByTestId("diff-full-limited").textContent() ?? "", /5,000 行/u);
      await page.screenshot({ path: join(screenshotDir, "pages-full-file-limited.png") });
      await page.keyboard.press("Alt+f");
      await page.getByTestId("diff-full-limited").waitFor({ state: "detached", timeout: 15_000 });
      await page.getByTestId("back-to-file").click();
    }

    // A file renamed after the commit is not in the tree version: it is shown as it was in that commit,
    // and the files page's tree version is left alone.
    await page.keyboard.press("Meta+1");
    await page.getByTestId("commit-row").last().click();
    await page.keyboard.press("Alt+Meta+2");
    await page.getByTestId("changed-file-row").filter({ hasText: "old-name.ts" }).getByTestId("open-in-files").click();
    await onPage("page-files");
    await page.locator("[data-testid='revision-content'] [data-revision-line='5']").waitFor({ timeout: 15_000 });
    assert.match(await page.locator("[data-testid='revision-content'] [data-revision-line='5']").textContent() ?? "", /value5 = 5;/u, "the first commit's version");
    await page.getByTestId("revision-gone").waitFor();
    assert.match(await page.getByTestId("tree-version").textContent() ?? "", /main/u, "the tree version stays on the branch");
    assert.equal(await page.locator("[data-testid='nav-back'][data-hint='true']").count(), 1, "one step back is the commit: the back button names it");
    await page.getByTestId("back-to-file").click();
    // Steps taken on the files page do not lose the way back: ← goes one step, "↩ 提交 …" beside it returns to the commit.
    const returnButton = page.getByTestId("nav-return");
    await returnButton.waitFor();
    assert.match(await returnButton.textContent() ?? "", /提交 [0-9a-f]{7,}/u);
    assert.equal(await page.locator("[data-testid='nav-back'][data-hint='true']").count(), 0, "← is a plain step back again");
    await returnButton.click();
    await onPage("page-commits");
    assert.equal(await page.locator("[data-hint='true']").count(), 0, "back on the commits page, the way back is gone");
    await page.keyboard.press("Meta+2");
  }

  if (has("workspaceStatus")) {
    // Switching pages keeps the workspace page's selection and the preview's scroll position.
    await page.keyboard.press("Meta+3");
    const note = page.getByTestId("workspace-file").filter({ hasText: "notes.txt" });
    await note.click();
    await page.getByTestId("workspace-file-text").waitFor({ timeout: 15_000 });
    const scrollPreview = position => page.getByTestId("workspace-file-text").evaluate((element, top) => {
      let box = element;
      while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/u.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      if (!box) return -1;
      if (top !== null) box.scrollTop = top;
      return box.scrollTop;
    }, position);
    const previewScroll = await scrollPreview(800);
    assert.ok(previewScroll > 400, "the 200-line preview scrolls");
    await page.keyboard.press("Meta+1");
    await page.keyboard.press("Meta+3");
    await delay(500);
    assert.equal(await note.getAttribute("aria-pressed"), "true", "the selected workspace file is kept");
    assert.equal(await scrollPreview(null), previewScroll, "the workspace page keeps its scroll position");

    // "在文件页打开": an untracked file has nothing committed to open; a modified one opens on the files page, and the
    // top bar names the way back to the workspace.
    assert.equal(await page.getByTestId("workspace-open-file").count(), 0, "an untracked file has no committed version");
    await page.getByTestId("workspace-file").filter({ hasText: "README.md" }).click();
    await page.getByTestId("workspace-open-file").click();
    assert.equal(await current(), "page-files");
    await page.waitForFunction(() => document.querySelector("nav[aria-label='路径'] [aria-current='page']")?.textContent === "README.md", null, { timeout: 15_000 });
    await page.locator("[data-testid='file-view'] [data-testid='file-content'] [data-line='3']").waitFor({ timeout: 15_000 });
    assert.match(await page.locator("[data-testid='file-view'] [data-testid='file-content'] [data-line='3']").textContent() ?? "", /First version\./u, "the committed version, not the working tree");
    assert.match(await page.getByTestId("tree-version").textContent() ?? "", /main/u, "opened at this window's HEAD, where the workspace's changes start");
    const toWorkspace = page.locator("[data-hint='true']");
    assert.equal((await toWorkspace.textContent() ?? "").trim(), "工作区");
    await toWorkspace.click();
    assert.equal(await current(), "page-workspace");
  }

  // The top bar narrows in the documented order and never overflows (docs/DESIGN.md section 11).
  await page.keyboard.press("Meta+1");
  const toolbarAt = async width => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 900), width);
    await page.waitForFunction(size => window.innerWidth === size, width);
    await delay(150);
    return page.evaluate(() => {
      const header = document.querySelector("header.window-toolbar");
      const box = header.getBoundingClientRect();
      const shown = selector => {
        const element = header.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return getComputedStyle(element).display !== "none" && rect.width > 0 && rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5;
      };
      return {
        overflow: header.scrollWidth - header.clientWidth,
        always: Object.fromEntries([".topbar-repository", "[data-testid='page-switch']", ".topbar-scope-picker", ".topbar-refresh"].map(selector => [selector, shown(selector)])),
        pageLabels: shown(".page-switch-label"),
        actionLabel: shown(".topbar-action-label"),
        activityCount: shown(".topbar-activity-count"),
        searchBody: shown(".topbar-search-body"),
        searchToggle: shown(".topbar-search-toggle"),
      };
    });
  };
  const bars = {};
  for (const width of [1440, 1200, 1000]) {
    const bar = bars[width] = await toolbarAt(width);
    assert.ok(bar.overflow <= 0, `${width}px: the top bar does not overflow (${bar.overflow}px)`);
    assert.ok(Object.values(bar.always).every(Boolean), `${width}px: repository, page switch, scope and refresh stay visible: ${JSON.stringify(bar.always)}`);
    await page.screenshot({ path: join(screenshotDir, `pages-topbar-${width}.png`) });
  }
  assert.equal(bars[1440].pageLabels, true);
  assert.equal(bars[1440].searchBody, true);
  assert.notEqual(bars[1440].actionLabel, false, "1440px keeps the refresh label");
  assert.notEqual(bars[1440].activityCount, false, "1440px keeps the activity numbers");
  assert.notEqual(bars[1200].actionLabel, true, "1200px drops the refresh label");
  assert.notEqual(bars[1200].activityCount, true, "1200px drops the activity numbers");
  assert.equal(bars[1200].pageLabels, true, "1200px still names the pages");
  assert.equal(bars[1200].searchBody, true);
  assert.equal(bars[1000].pageLabels, false, "1000px keeps only the page icons");
  assert.equal(bars[1000].searchBody, false, "1000px folds search into a button");
  assert.equal(bars[1000].searchToggle, true);
  await toolbarAt(1440);

  if (!standIn) {
    // A bare repository has no working tree: the workspace item says so, cannot be opened and is never "clean".
    const bare = join(temporaryRoot, "bare.git");
    await git(temporaryRoot, ["clone", "-q", "--bare", repository, bare]);
    const bareApp = await electron.launch({ executablePath: require("electron"), args: [appEntry, `--repository=${bare}`, `--user-data-dir=${join(temporaryRoot, "bare-user-data")}`], env, chromiumSandbox: true });
    try {
      const bareWindow = await bareApp.firstWindow();
      await bareWindow.getByTestId("commit-row").first().waitFor({ timeout: 40_000 });
      const item = bareWindow.getByTestId("page-workspace");
      assert.equal(await item.isDisabled(), true, "the workspace item cannot be opened");
      assert.equal(await item.getAttribute("title"), "无工作区（bare 仓库）");
      assert.equal((await item.getAttribute("aria-label"))?.includes("无工作区"), true);
      await bareWindow.keyboard.press("Meta+3");
      assert.equal(await bareWindow.getByTestId("page-switch").locator("[aria-current='page']").getAttribute("data-testid"), "page-commits", "⌘3 does not open a workspace page");
      assert.equal(await bareWindow.getByTestId("workspace-clean").count(), 0);
      await bareWindow.screenshot({ path: join(screenshotDir, "pages-bare.png") });
    } finally {
      await bareApp.close().catch(() => undefined);
    }
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
