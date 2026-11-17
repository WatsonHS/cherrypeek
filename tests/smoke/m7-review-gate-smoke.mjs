#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temp = await mkdtemp(join(tmpdir(), "commitscope-m7-smoke-"));
const originBare = join(temp, "origin.git");
const local = join(temp, "local");
const peer = join(temp, "peer");
const userDataDir = join(temp, "user-data");
const shots = resolve(root, "output/playwright/m7-review-gate");

const git = (dir, ...args) =>
  execFileSync(
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

try {
  await mkdir(shots, { recursive: true });

  // Bare remote + local & peer clones.
  git(temp, "init", "-q", "--bare", "-b", "main", originBare);
  git(temp, "clone", "-q", originBare, local);
  git(local, "config", "user.name", "Smoke Committer");
  git(local, "config", "user.email", "smoke@example.invalid");
  await writeFile(join(local, "shared.txt"), "initial\n");
  git(local, "add", "shared.txt");
  git(local, "commit", "-qm", "initial commit");
  git(local, "push", "-q", "-u", "origin", "main");
  git(temp, "clone", "-q", originBare, peer);

  // Create feature work on `feat`, including an untracked discard target and a COMMIT_EDITMSG draft with template comment.
  git(local, "switch", "-qc", "feat");
  await writeFile(join(local, "shared.txt"), "initial\nfeature line\n");
  await writeFile(join(local, "feature.txt"), "feature content\n");
  await writeFile(join(local, "scratch.tmp"), "drop me\n");
  await writeFile(join(local, ".git", "COMMIT_EDITMSG"), "feat: gate commit\n# Please enter the commit message\n");

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [appEntry, `--user-data-dir=${userDataDir}`, `--repository=${local}`],
    env,
    chromiumSandbox: true,
  });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));

  await page.getByTestId("commit-row").first().waitFor({ timeout: 30_000 });
  await idle();

  // 1. Open Workspace page and verify draft autofill + Agent review handoff copy.
  await page.getByTestId("page-workspace").click();
  await page.getByTestId("workspace-draft-badge").waitFor({ state: "visible", timeout: 20_000 });
  const draftValue = await page.getByTestId("workspace-commit-message").inputValue();
  assert.equal(draftValue, "feat: gate commit");
  await page.getByTestId("workspace-commit-message").fill("feat: gate commit\n\n#42 keep issue line");

  await page.getByTestId("workspace-handoff-button").click();
  await page.getByTestId("workspace-handoff-review").click();
  await page.getByTestId("handoff-dialog").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await page.getByTestId("handoff-dialog").getAttribute("data-scenario"), "workspace-review");
  await page.getByTestId("handoff-copy").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="handoff-copy-status"]')?.textContent?.includes("已复制"), null, { timeout: 5_000 });
  const copiedText = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copiedText, /CS-DATA-/u);
  assert.match(copiedText, /scratch\.tmp/u);
  await page.screenshot({ path: join(shots, "01-workspace-review-handoff.png") });
  await page.getByTestId("handoff-close").click();
  await page.getByTestId("handoff-dialog").waitFor({ state: "detached" });

  // 2. Two-step confirmed discard removes untracked `scratch.tmp`.
  await page.getByTestId("workspace-file").filter({ hasText: "scratch.tmp" }).click();
  await page.getByTestId("workspace-selected-discard").click();
  await page.getByTestId("workspace-discard-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("workspace-discard-confirm").click();
  await page.getByTestId("workspace-discard-dialog").waitFor({ state: "detached", timeout: 15_000 });
  await assert.rejects(stat(join(local, "scratch.tmp")), "scratch.tmp should be removed after confirmation");

  // 3. Stage remaining changes and commit with preserved '#' body line.
  await page.getByTestId("workspace-stage-all").click();
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="workspace-commit-submit"]');
    return btn && !btn.disabled && btn.textContent?.includes("2");
  }, null, { timeout: 15_000 });
  await page.screenshot({ path: join(shots, "02-workspace-ready-to-commit.png") });
  await page.getByTestId("workspace-commit-submit").click();
  await page.getByTestId("workspace-clean").waitFor({ state: "visible", timeout: 20_000 });
  await idle();
  const featTip = oid(local, "HEAD");
  assert.equal(git(local, "log", "-1", "--format=%B", "HEAD"), "feat: gate commit\n\n#42 keep issue line");

  // 4. Switch to Commits, open ScopePicker, fast-forward merge `feat` into `main` & switch to `main`.
  await page.getByTestId("page-commits").click();
  await page.getByTestId("scope-picker").click();
  const featRow = page.locator("[data-scope-ref-kind='localBranch'][data-ref-name='refs/heads/feat']");
  await featRow.hover();
  await featRow.getByTestId("branch-more").click();
  await page.getByTestId("branch-more-merge-into").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("branch-more-merge-into").click();
  await page.getByTestId("ff-merge-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("ff-merge-switch-checkbox").check();
  await page.getByTestId("ff-merge-submit").click();
  await page.getByTestId("ff-merge-dialog").waitFor({ state: "detached", timeout: 20_000 });
  await page.getByTestId("update-current-button").filter({ hasText: "更新 main" }).waitFor({ timeout: 20_000 });
  await idle();
  assert.equal(git(local, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(oid(local, "refs/heads/main"), featTip);

  // 5. Open ScopePicker and directly delete ancestor-merged `feat` (not checked out anywhere).
  await page.getByTestId("scope-picker").click();
  const deleteFeat = featRow.getByTestId("branch-delete");
  await deleteFeat.waitFor({ state: "visible", timeout: 15_000 });
  await deleteFeat.click();
  await page.getByTestId("operation-notice").filter({ hasText: /已删除本地分支 feat/u }).waitFor({ timeout: 20_000 });
  await idle();
  assert.throws(() => git(local, "show-ref", "--verify", "refs/heads/feat"), "feat ref should be deleted");
  await page.keyboard.press("Escape");
  await page.getByTestId("scope-popover").waitFor({ state: "detached" });

  // 6. Top bar `推送 ↑1` pushes `main` to originBare.
  const pushButton = page.getByTestId("push-current-button");
  await pushButton.waitFor({ state: "visible", timeout: 15_000 });
  assert.match(await pushButton.textContent(), /↑1/u);
  await page.screenshot({ path: join(shots, "03-topbar-push-ready.png") });
  await pushButton.click();
  await page.getByTestId("operation-notice").filter({ hasText: /已推送 main/u }).waitFor({ timeout: 20_000 });
  await idle();
  assert.equal(oid(originBare, "refs/heads/main"), featTip);

  // 7. Peer pushes first without local fetching -> non-force push is rejected safely without --force.
  git(peer, "pull", "-q");
  await writeFile(join(peer, "peer-only.txt"), "peer ahead\n");
  git(peer, "add", "peer-only.txt");
  git(peer, "commit", "-qm", "peer advance");
  git(peer, "push", "-q", "origin", "main");
  const remoteBeforeReject = oid(originBare, "refs/heads/main");

  await writeFile(join(local, "local-div.txt"), "local advance\n");
  git(local, "add", "local-div.txt");
  git(local, "commit", "-qm", "local diverged commit");
  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await pushButton.waitFor({ state: "visible", timeout: 20_000 });
  await idle();
  await pushButton.click();
  await page.getByTestId("refusal-dialog").waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await page.getByTestId("refusal-list").textContent(), /rejected|远端返回/iu);
  assert.equal(oid(originBare, "refs/heads/main"), remoteBeforeReject, "remote main must not be overwritten with force");
  await page.screenshot({ path: join(shots, "04-push-rejected-safe.png") });
  await page.getByTestId("refusal-close").click();

  assert.deepEqual(errors, []);
  console.log("M7 review-gate Electron smoke passed: workspace draft/handoff/discard/stage/commit, ff-merge+switch, delete merged branch, push ↑1, and non-ff rejection.");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
