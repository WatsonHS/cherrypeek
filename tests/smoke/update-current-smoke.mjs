#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), "commitscope-update-current-"));
const upstream = join(temp, "upstream");
const local = join(temp, "local");
const shots = resolve(root, "output/playwright/update-current");
const git = (dir, ...args) => execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();
const oid = (dir, ref = "HEAD") => git(dir, "rev-parse", ref);
const errors = [];
let app, page;
let profile = 0;

async function idle() {
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="update-fetch-menu"]');
    return menu && !menu.disabled;
  }, null, { timeout: 25_000 });
}
async function launch(repository) {
  if (app) await app.close();
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ executablePath: require("electron"), args: [resolve(root, "apps/desktop/dist/main/index.cjs"), `--repository=${repository}`, `--user-data-dir=${join(temp, `profile-${profile++}`)}`], env, chromiumSandbox: true });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.getByTestId("commit-row").first().waitFor({ timeout: 30_000 });
  await idle();
}
async function update() {
  await page.getByTestId("update-current-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="operation-notice"], [data-testid="refusal-dialog"], [data-testid="fetch-failure"]'), null, { timeout: 25_000 });
  await idle();
}
async function refresh() {
  await page.getByRole("button", { name: "刷新仓库历史", exact: true }).click();
  await idle();
}
async function commitFile(content, title) {
  await writeFile(join(upstream, "shared.txt"), content);
  git(upstream, "add", "shared.txt");
  git(upstream, "commit", "-qm", title);
  return oid(upstream);
}

try {
  await mkdir(upstream);
  await mkdir(shots, { recursive: true });
  git(upstream, "init", "-q", "-b", "main");
  await commitFile("base\n", "initial");
  git(upstream, "branch", "other");
  git(upstream, "branch", "obsolete");
  git(temp, "clone", "-q", upstream, local);
  git(local, "branch", "--track", "other", "origin/other");
  const original = oid(local);
  const remoteTip = await commitFile("remote one\n", "main update");
  git(upstream, "branch", "-f", "other", remoteTip);
  await launch(local);

  // A snapshot that appears up to date must still allow updating; the browsing scope is independent.
  await page.getByTestId("scope-picker").click();
  await page.getByTestId("scope-option-ref-refs/heads/other").click();
  await idle();
  assert.equal(await page.getByTestId("update-current-button").textContent(), "更新 main");
  await update();
  assert.equal(oid(local), remoteTip);
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "remote one\n");
  assert.equal(oid(local, "other"), original, "the browsed branch stays untouched");
  assert.match(await page.getByTestId("scope-picker").getAttribute("aria-label"), /other/u);
  assert.match(await page.getByTestId("operation-notice").textContent(), /main 已快进/u);
  await update();
  assert.match(await page.getByTestId("operation-notice").textContent(), /main 已是最新/u);

  const fetchedTip = await commitFile("remote two\n", "fetch only");
  git(upstream, "branch", "-d", "obsolete");
  await page.getByTestId("update-fetch-menu").click();
  await page.screenshot({ path: join(shots, "fetch-menu-wide.png") });
  await page.getByTestId("fetch-prune-button").click();
  await idle();
  assert.equal(oid(local), remoteTip);
  assert.equal(oid(local, "origin/main"), fetchedTip);
  assert.equal(git(local, "for-each-ref", "refs/remotes/origin/obsolete"), "");
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "remote one\n");

  // Rejections distinguish completed fetch from refused local updates and preserve file/index contents.
  await writeFile(join(local, "shared.txt"), "my unfinished edit\n");
  const indexBefore = await readFile(join(local, ".git/index"));
  await update();
  assert.match(await page.getByTestId("refusal-dialog").textContent(), /未提交改动会被覆盖/u);
  assert.equal(await page.getByTestId("refusal-safe").textContent(), "Fetch 已完成；本地分支和工作区未更新");
  assert.equal(oid(local), remoteTip);
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "my unfinished edit\n");
  assert.deepEqual(await readFile(join(local, ".git/index")), indexBefore);
  assert.equal(await page.getByTestId("refusal-handoff").count(), 1);
  assert.equal(await page.getByTestId("refusal-discard").count(), 0);
  await page.screenshot({ path: join(shots, "dirty-refusal.png") });
  await page.getByTestId("refusal-close").click();
  await writeFile(join(local, "shared.txt"), "remote one\n");
  await update();
  assert.equal(oid(local), fetchedTip);

  // An ignored directory may contain both an identical file and a local draft.
  for (const dir of [local, upstream]) {
    await mkdir(join(dir, "drafts"));
    await writeFile(join(dir, "drafts/same.txt"), "already here\n");
  }
  await writeFile(join(local, ".git/info/exclude"), "drafts/\n");
  await writeFile(join(local, "drafts/note.txt"), "my note\n");
  await writeFile(join(upstream, "drafts/note.txt"), "published note\n");
  git(upstream, "add", "drafts");
  git(upstream, "commit", "-qm", "publish drafts");
  await update();
  const alternative = page.getByTestId("refusal-alternative");
  await alternative.waitFor();
  assert.match(await alternative.textContent(), /备份并更新/u);
  assert.equal(await page.getByTestId("refusal-handoff").isVisible(), true);
  assert.match(await page.getByTestId("refusal-list").textContent(), /drafts\/note.txt/u);
  assert.equal(oid(local), fetchedTip);
  await alternative.click();
  await page.getByTestId("operation-notice").filter({ hasText: "已备份 1 个文件" }).waitFor();
  await idle();
  const notice = page.getByTestId("operation-notice");
  assert.equal(await notice.getByRole("status").textContent(), "main 已快进到上游 · 已备份 1 个文件");
  await notice.getByRole("button", { name: "更新详情" }).click();
  assert.ok(await page.getByText("1 个同名文件与上游相同，已纳入跟踪。").isVisible());
  const backupDir = await page.getByTestId("update-backup-dir").textContent();
  await page.keyboard.press("Escape");
  assert.ok(backupDir);
  assert.equal(await readFile(join(backupDir, "drafts/note.txt"), "utf8"), "my note\n");
  assert.equal(await readFile(join(local, "drafts/note.txt"), "utf8"), "published note\n");
  assert.equal(oid(local), oid(upstream));

  const previousBackups = await readdir(dirname(backupDir));
  await writeFile(join(local, "drafts/second.txt"), "discard me");
  await writeFile(join(local, "drafts/unrelated.txt"), "keep me");
  await writeFile(join(upstream, "drafts/second.txt"), "upstream version");
  git(upstream, "add", "drafts/second.txt");
  git(upstream, "commit", "-qm", "publish second draft");
  await update();
  await page.getByRole("button", { name: "丢弃并更新…" }).click();
  assert.ok(await page.getByRole("heading", { name: "丢弃 1 个本地副本？" }).isVisible());
  assert.equal(await page.getByRole("button", { name: "返回", exact: true }).evaluate(button => button === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await readFile(join(local, "drafts/second.txt"), "utf8"), "discard me");
  assert.equal(await page.getByTestId("refusal-handoff").isVisible(), true);
  await page.getByRole("button", { name: "丢弃并更新…" }).click();
  await page.getByRole("button", { name: "确认丢弃并更新" }).click();
  await notice.filter({ hasText: "已丢弃 1 个本地副本" }).waitFor();
  await idle();
  assert.equal(oid(local), oid(upstream));
  assert.equal(await readFile(join(local, "drafts/second.txt"), "utf8"), "upstream version");
  assert.equal(await readFile(join(local, "drafts/unrelated.txt"), "utf8"), "keep me");
  assert.equal(await readFile(join(backupDir, "drafts/note.txt"), "utf8"), "my note\n");
  assert.deepEqual(await readdir(dirname(backupDir)), previousBackups);

  git(local, "commit", "-q", "--allow-empty", "-m", "local only");
  await refresh();
  await update();
  assert.match(await page.getByTestId("operation-notice").textContent(), /领先上游 1 个提交/u);
  const aheadTip = oid(local);
  const divergedTip = await commitFile("remote three\n", "diverged upstream");
  await update();
  assert.match(await page.getByTestId("refusal-dialog").textContent(), /已分叉/u);
  assert.equal(oid(local), aheadTip);
  assert.equal(oid(local, "origin/main"), divergedTip);
  assert.equal(await page.getByTestId("refusal-safe").textContent(), "Fetch 已完成；本地分支和工作区未更新");
  await page.getByTestId("refusal-close").click();

  git(local, "branch", "--unset-upstream", "main");
  await refresh();
  await update();
  assert.match(await page.getByTestId("refusal-dialog").textContent(), /main 没有上游分支/u);
  assert.equal(await page.getByTestId("refusal-handoff").count(), 1);
  assert.equal(oid(local), aheadTip);
  await page.getByTestId("refusal-close").click();
  git(local, "branch", "--set-upstream-to=origin/main", "main");

  // Cancellation of fetch stops the composite update before a local fast-forward.
  const delayedUploadPack = join(temp, "slow-upload-pack");
  await writeFile(delayedUploadPack, '#!/bin/sh\nsleep 15\nexec git-upload-pack "$@"\n');
  await chmod(delayedUploadPack, 0o755);
  git(local, "config", "remote.origin.uploadpack", delayedUploadPack);
  await page.getByTestId("update-current-button").click();
  await page.getByRole("button", { name: "取消 Fetch", exact: true }).waitFor();
  assert.equal(await page.getByText("正在 Fetch", { exact: true }).isVisible(), true);
  await page.getByRole("timer", { name: "Fetch 已用时间" }).filter({ hasText: /0:0[1-9]/u }).waitFor();
  assert.equal(await page.getByTestId("update-fetch-menu").count(), 0);
  await page.getByRole("button", { name: "取消 Fetch", exact: true }).click();
  await idle();
  assert.equal(oid(local), aheadTip);
  assert.equal(await page.getByTestId("refusal-dialog").count(), 0);
  git(local, "config", "--unset", "remote.origin.uploadpack");

  // An external checkout during fetch must not turn an update of the current worktree into a ref-only update.
  await writeFile(delayedUploadPack, '#!/bin/sh\nsleep 2\nexec git-upload-pack "$@"\n');
  git(local, "config", "remote.origin.uploadpack", delayedUploadPack);
  await page.getByTestId("update-current-button").click();
  await page.getByRole("button", { name: "取消 Fetch", exact: true }).waitFor();
  git(local, "switch", "-q", "other");
  await idle();
  assert.match(await page.getByTestId("operation-notice").textContent(), /工作区或分支已经变化/u);
  assert.equal(oid(local, "main"), aheadTip);
  assert.equal(oid(local), original);
  git(local, "config", "--unset", "remote.origin.uploadpack");
  git(local, "switch", "-q", "main");
  await refresh();

  git(local, "remote", "set-url", "origin", join(temp, "missing-remote"));
  await update();
  assert.match(await page.getByTestId("fetch-failure-output").textContent(), /missing-remote/u);
  assert.equal(oid(local), aheadTip);
  git(local, "remote", "set-url", "origin", upstream);
  git(local, "switch", "-q", "--detach");
  await refresh();
  assert.equal(await page.getByTestId("update-current-button").isDisabled(), true);
  assert.match(await page.getByTestId("update-current-button").getAttribute("title"), /detached HEAD/u);
  await page.getByTestId("update-fetch-menu").click();
  await page.getByTestId("fetch-button").click();
  await idle();
  assert.equal(oid(local), aheadTip);

  const linked = join(temp, "linked");
  git(local, "worktree", "add", "-q", "-b", "linked-main", linked, "origin/main");
  await launch(linked);
  const linkedTip = await commitFile("linked update\n", "update linked worktree");
  await update();
  assert.equal(oid(linked), linkedTip);
  assert.equal(oid(local), aheadTip);
  assert.equal(oid(local, "main"), aheadTip);
  assert.equal(await readFile(join(linked, "shared.txt"), "utf8"), "linked update\n");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 760));
  await page.getByTestId("update-fetch-menu").click();
  const mainBounds = await page.getByTestId("update-current-button").boundingBox();
  const menuBounds = await page.getByTestId("update-fetch-menu").boundingBox();
  assert.ok(mainBounds.x >= 0 && menuBounds.x + menuBounds.width <= 900, "the split button fits a narrow window");
  await page.screenshot({ path: join(shots, "fetch-menu-narrow.png") });

  const bare = join(temp, "bare.git");
  git(temp, "clone", "-q", "--bare", upstream, bare);
  await launch(bare);
  assert.equal(await page.getByTestId("update-current-button").isDisabled(), true);
  assert.match(await page.getByTestId("update-current-button").getAttribute("title"), /裸仓库/u);
  await page.getByTestId("update-fetch-menu").click();
  assert.equal(await page.getByTestId("fetch-button").isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log("Update current branch Electron smoke passed: scope independence, fast-forward, no-op/ahead, fetch/prune, ignored-file backup, receipt details, confirmed discard and Fetch timer, dirty/diverged/no-upstream, cancel/failure, detached/bare, linked worktree and narrow layout.");
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.locator('[data-testid="operation-notice"], [data-testid="refusal-dialog"], [data-testid="operation-failure"], [data-testid="fetch-failure"]').allTextContents());
    await page.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  await rm(temp, { recursive: true, force: true });
}
