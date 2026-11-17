#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { snapshotTree } from "../repository/snapshot.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temp = await mkdtemp(join(tmpdir(), "commitscope-m5-ops-smoke-"));
const originRemote = join(temp, "origin-remote");
const upstreamRemote = join(temp, "upstream-remote");
const local = join(temp, "local");
const otherRepo = join(temp, "other-repo");
const userDataDir = join(temp, "user-data");
const shots = resolve(root, "output/playwright/m5-operations");

const git = (dir, ...args) => execFileSync(
  "git",
  ["-C", dir, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", ...args],
  { encoding: "utf8" },
).trim();
const oid = (dir, ref = "HEAD") => git(dir, "rev-parse", ref);

const errors = [];
let app;
let page;

async function idle() {
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="update-fetch-menu"]');
    return menu && !menu.disabled;
  }, null, { timeout: 25_000 });
}

async function launch(args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const launched = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--user-data-dir=${userDataDir}`, ...args],
    env,
    chromiumSandbox: true,
  });
  const win = await launched.firstWindow();
  win.on("pageerror", error => errors.push(String(error)));
  return { launched, win };
}

try {
  await mkdir(originRemote, { recursive: true });
  await mkdir(otherRepo, { recursive: true });
  await mkdir(shots, { recursive: true });

  // Build originRemote with main, side, and remote-only branches.
  git(originRemote, "init", "-q", "-b", "main");
  await writeFile(join(originRemote, "shared.txt"), "base\n");
  git(originRemote, "add", "shared.txt");
  git(originRemote, "commit", "-qm", "initial base");
  const baseOid = oid(originRemote);
  git(originRemote, "branch", "side");
  git(originRemote, "branch", "remote-only");

  // Clone into local and upstreamRemote (at the shared base commit), then advance each independently.
  git(temp, "clone", "-q", originRemote, local);
  git(temp, "clone", "-q", originRemote, upstreamRemote);
  git(local, "branch", "--track", "topic", "origin/side");
  git(local, "remote", "add", "upstream", upstreamRemote);

  git(originRemote, "switch", "-q", "side");
  await writeFile(join(originRemote, "shared.txt"), "side update\n");
  git(originRemote, "add", "shared.txt");
  git(originRemote, "commit", "-qm", "advance side");
  const sideOid = oid(originRemote);

  // Local already knows origin/side is ahead of topic, so topic shows a fast-forward action in scope-picker.
  git(local, "fetch", "-q", "origin");

  git(originRemote, "switch", "-q", "main");
  await writeFile(join(originRemote, "origin-only.txt"), "origin advance\n");
  git(originRemote, "add", "origin-only.txt");
  git(originRemote, "commit", "-qm", "advance origin main");

  await writeFile(join(upstreamRemote, "upstream-only.txt"), "upstream advance\n");
  git(upstreamRemote, "add", "upstream-only.txt");
  git(upstreamRemote, "commit", "-qm", "advance upstream main");
  const upstreamMainOid = oid(upstreamRemote, "main");

  // Second repository used to test open-file / IPC open request and read-only guard.
  git(otherRepo, "init", "-q", "-b", "main");
  await writeFile(join(otherRepo, "hello.txt"), "other repo\n");
  git(otherRepo, "add", "hello.txt");
  git(otherRepo, "commit", "-qm", "other initial");
  const otherBefore = await snapshotTree(otherRepo);

  ({ launched: app, win: page } = await launch([`--repository=${local}`]));
  await page.getByTestId("commit-row").first().waitFor({ timeout: 30_000 });
  await idle();

  // 1. Multi-remote dropdown lets the user fetch a single named remote without fetching origin.
  await page.getByTestId("update-fetch-menu").click();
  await page.getByTestId("fetch-remote-upstream").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("fetch-remote-origin").isVisible(), true);
  await page.screenshot({ path: join(shots, "multi-remote-menu.png") });
  await page.getByTestId("fetch-remote-upstream").click();
  await page.getByTestId("fetch-notice").waitFor({ state: "visible", timeout: 20_000 });
  await idle();
  assert.equal(oid(local, "refs/remotes/upstream/main"), upstreamMainOid);
  assert.equal(oid(local, "refs/remotes/origin/main"), baseOid, "origin was not fetched");
  assert.equal(oid(local), baseOid, "local HEAD stayed unchanged");

  // 2. Fast-forward a non-current local branch (`topic`) from scope-picker without checking it out.
  await page.getByTestId("scope-picker").click();
  const topicRow = page.locator("[data-scope-ref-kind='localBranch'][data-ref-name='refs/heads/topic']");
  await topicRow.locator("[data-testid='branch-update']").waitFor({ state: "visible", timeout: 15_000 });
  await topicRow.locator("[data-testid='branch-update']").click();
  await page.getByTestId("operation-notice").filter({ hasText: /topic 已快进/u }).waitFor({ timeout: 20_000 });
  await idle();
  assert.equal(oid(local, "refs/heads/topic"), sideOid);
  assert.equal(oid(local, "HEAD"), baseOid, "HEAD stays on main");
  // Fast-forwarding a branch keeps scope-popover open; close it before reopening for step 3.
  await page.keyboard.press("Escape");
  await page.getByTestId("scope-popover").waitFor({ state: "detached" });

  // 3. Create branch dialog: validate invalid name, then create and switch.
  await page.getByTestId("scope-picker").click();
  const mainRow = page.locator("[data-scope-ref-kind='localBranch'][data-ref-name='refs/heads/main']");
  await mainRow.hover();
  await mainRow.getByTestId("branch-more").click();
  await page.getByTestId("branch-more-create").click();
  await page.getByTestId("create-branch-dialog").waitFor({ state: "visible" });
  await page.getByTestId("create-branch-name").fill("bad..name");
  assert.equal(await page.getByTestId("create-branch-error").isVisible(), true);
  assert.equal(await page.getByTestId("create-branch-confirm").isDisabled(), true);
  await page.getByTestId("create-branch-name").fill("feat/smoke-created");
  assert.equal(await page.getByTestId("create-branch-confirm").isEnabled(), true);
  await page.getByTestId("create-branch-confirm").click();
  await page.getByTestId("create-branch-dialog").waitFor({ state: "detached", timeout: 20_000 });
  await page.getByTestId("update-current-button").filter({ hasText: "更新 feat/smoke-created" }).waitFor({ timeout: 20_000 });
  await idle();
  assert.equal(git(local, "symbolic-ref", "HEAD"), "refs/heads/feat/smoke-created");

  // 4. Switch to a remote tracking branch: creates local tracking branch and checks it out.
  await page.getByTestId("scope-picker").click();
  const remoteRow = page.locator("[data-scope-ref-kind='remoteBranch']").filter({ hasText: "origin/remote-only" });
  await remoteRow.hover();
  await remoteRow.getByTestId("branch-switch").click();
  await page.getByTestId("update-current-button").filter({ hasText: "更新 remote-only" }).waitFor({ timeout: 20_000 });
  await idle();
  assert.equal(git(local, "symbolic-ref", "HEAD"), "refs/heads/remote-only");
  assert.equal(git(local, "rev-parse", "--abbrev-ref", "remote-only@{upstream}"), "origin/remote-only");

  // 5. Dirty tracked edit blocks switching to `topic` without touching working tree/index, and offers Agent handoff.
  await writeFile(join(local, "shared.txt"), "local dirty edit\n");
  const indexBefore = await readFile(join(local, ".git/index"));
  await page.getByTestId("scope-picker").click();
  await topicRow.hover();
  await topicRow.getByTestId("branch-switch").click();
  await page.getByTestId("refusal-dialog").waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(await page.getByTestId("refusal-safe").textContent(), "没有执行任何操作，仓库未被改动");
  assert.match(await page.getByTestId("refusal-list").textContent(), /shared\.txt/u);
  assert.equal(git(local, "symbolic-ref", "HEAD"), "refs/heads/remote-only");
  assert.equal(await readFile(join(local, "shared.txt"), "utf8"), "local dirty edit\n");
  assert.deepEqual(await readFile(join(local, ".git/index")), indexBefore);
  await page.getByTestId("refusal-handoff").click();
  await page.getByTestId("handoff-dialog").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByTestId("handoff-dialog").getAttribute("data-scenario"), "operation-blocked");
  await page.getByTestId("handoff-toggle-prompt").click();
  const promptText = await page.getByTestId("handoff-preview").inputValue();
  assert.match(promptText, /topic/u);
  assert.match(promptText, /shared\.txt/u);
  await page.getByTestId("handoff-copy").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="handoff-copy-status"]')?.textContent?.includes("已复制"), null, { timeout: 5_000 });
  await page.getByTestId("handoff-close").click();
  await page.getByTestId("handoff-dialog").waitFor({ state: "detached" });
  await page.getByTestId("refusal-dialog").waitFor({ state: "detached" });

  // 6. Drag-and-drop overlay feedback and open-file IPC switching repository cleanly.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "dummy.txt"));
    const target = document.querySelector("#root > div");
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.getByTestId("drop-overlay").waitFor({ state: "visible", timeout: 5_000 });
  await page.evaluate(() => {
    const target = document.querySelector("#root > div");
    target.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: null }));
  });
  await page.getByTestId("drop-overlay").waitFor({ state: "detached", timeout: 5_000 });

  await app.evaluate(({ app: electronApp }, dir) => {
    electronApp.emit("open-file", { preventDefault() {} }, dir);
  }, otherRepo);
  await page.getByRole("heading", { name: "other initial", exact: true }).waitFor({ timeout: 20_000 });
  assert.deepEqual(await snapshotTree(otherRepo), otherBefore, "switching via open-file kept target repo untouched");

  // 7. Window bounds persistence across restart.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 90, y: 90, width: 1020, height: 680 });
  });
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await app.close().catch(() => {});
  app = undefined;

  const saved = JSON.parse(await readFile(join(userDataDir, "window-state.json"), "utf8"));
  assert.equal(saved.width, 1020);
  assert.equal(saved.height, 680);

  ({ launched: app, win: page } = await launch([`--repository=${otherRepo}`]));
  await page.getByTestId("commit-row").first().waitFor({ timeout: 20_000 });
  const restoredBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.equal(restoredBounds.width, 1020);
  assert.equal(restoredBounds.height, 680);

  assert.deepEqual(errors, []);
  console.log("M5 operations Electron smoke passed: single-remote fetch, non-HEAD fast-forward, branch create/switch, dirty refusal + handoff, open-file + drag overlay, window bounds restore.");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
