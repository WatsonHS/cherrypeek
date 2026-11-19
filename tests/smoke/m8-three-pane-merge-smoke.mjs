#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const appEntry = resolve(root, "apps/desktop/dist/main/index.cjs");
const temp = await mkdtemp(join(tmpdir(), "commitscope-m8-smoke-"));
const originBare = join(temp, "origin.git");
const local = join(temp, "local");
const peer = join(temp, "peer");
const userDataDir = join(temp, "user-data");
const shots = resolve(root, "output/playwright/m8-three-pane-merge");

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

  // Base repository with multi-hunk `shared.txt` (separated by >= 3 unchanged lines so 2 hunks stay distinct).
  git(temp, "init", "-q", "--bare", "-b", "main", originBare);
  git(temp, "clone", "-q", originBare, local);
  git(local, "config", "user.name", "Smoke Committer");
  git(local, "config", "user.email", "smoke@example.invalid");
  await writeFile(
    join(local, "shared.txt"),
    [
      "line-01-header",
      "hunk0-base",
      "line-03-mid",
      "line-04-mid",
      "line-05-mid",
      "hunk1-base",
      "line-07-footer",
      "",
    ].join("\n"),
  );
  git(local, "add", "shared.txt");
  git(local, "commit", "-qm", "initial shared file");
  git(local, "push", "-q", "-u", "origin", "main");
  git(temp, "clone", "-q", originBare, peer);

  // Case 1 setup: clean diverged commits (`peer-clean.txt` vs `local-clean.txt` with distinct author metadata).
  await writeFile(join(peer, "peer-clean.txt"), "from peer\n");
  git(peer, "add", "peer-clean.txt");
  git(peer, "commit", "-qm", "peer: clean advance");
  git(peer, "push", "-q", "origin", "main");

  await writeFile(join(local, "local-clean.txt"), "from local\n");
  git(local, "add", "local-clean.txt");
  execFileSync(
    "git",
    [
      "-C", local,
      "-c", "user.name=Original Local Author",
      "-c", "user.email=local-author@example.invalid",
      "commit", "-qm", "feat: local clean commit",
    ],
    { encoding: "utf8" },
  );

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

  // Case 1: update-current detects diverged -> RefusalDialog -> 1-commit rebase + immediate push.
  await page.getByTestId("update-current-button").click();
  await page.getByTestId("refusal-dialog").waitFor({ state: "visible", timeout: 25_000 });
  await page.getByTestId("refusal-resolve-diverged").click();
  await page.getByTestId("diverged-sync-dialog").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("merge-mode-single-rebase").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("merge-mode-single-rebase").check();
  await page.getByTestId("diverged-sync-push-after").check();
  await page.screenshot({ path: join(shots, "01-clean-diverged-single-rebase.png") });
  await page.getByTestId("diverged-sync-confirm").click();
  await page.getByTestId("diverged-sync-dialog").waitFor({ state: "detached", timeout: 25_000 });
  await page.getByTestId("operation-notice").filter({ hasText: /已推送 main/u }).waitFor({ timeout: 25_000 });
  await idle();

  const rebasedHead = oid(local, "HEAD");
  assert.equal(oid(originBare, "refs/heads/main"), rebasedHead);
  assert.equal(git(local, "rev-list", "--count", "--parents", "-n", "1", "HEAD"), "1");
  assert.equal(git(local, "show", "-s", "--format=%an|%ae|%s", "HEAD"), "Original Local Author|local-author@example.invalid|feat: local clean commit");
  assert.equal(existsSync(join(local, "peer-clean.txt")), true);
  assert.equal(existsSync(join(local, "local-clean.txt")), true);

  // Case 2 setup: 2-hunk conflict on `shared.txt`.
  git(peer, "pull", "-q", "--ff-only");
  await writeFile(
    join(peer, "shared.txt"),
    [
      "line-01-header",
      "hunk0-remote",
      "line-03-mid",
      "line-04-mid",
      "line-05-mid",
      "hunk1-remote",
      "line-07-footer",
      "",
    ].join("\n"),
  );
  git(peer, "add", "shared.txt");
  git(peer, "commit", "-qm", "peer: conflicting 2 hunks");
  git(peer, "push", "-q", "origin", "main");

  await writeFile(
    join(local, "shared.txt"),
    [
      "line-01-header",
      "hunk0-local",
      "line-03-mid",
      "line-04-mid",
      "line-05-mid",
      "hunk1-local",
      "line-07-footer",
      "",
    ].join("\n"),
  );
  git(local, "add", "shared.txt");
  git(local, "commit", "-qm", "local: conflicting 2 hunks");
  const localBeforeMerge = oid(local, "HEAD");

  await page.getByRole("button", { name: "刷新仓库历史" }).click();
  await idle();

  // Trigger fetch + diverged refusal via update-current, then enter ThreePaneMergeView.
  await page.getByTestId("update-current-button").click();
  await page.getByTestId("refusal-dialog").waitFor({ state: "visible", timeout: 25_000 });
  await page.getByTestId("refusal-resolve-diverged").click();
  await page.getByTestId("diverged-sync-conflicted").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("open-three-pane-merge").click();
  await page.getByTestId("three-pane-merge-view").waitFor({ state: "visible", timeout: 20_000 });
  assert.match(await page.getByTestId("merge-unresolved-count").textContent(), /剩余 2 处冲突/u);
  assert.equal(await page.getByTestId("merge-complete-submit").isDisabled(), true);
  await page.screenshot({ path: join(shots, "02-three-pane-unresolved.png") });

  // Verify Cancel writes ZERO state to repo.
  await page.getByTestId("merge-cancel").click();
  await page.getByTestId("three-pane-merge-view").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(oid(local, "HEAD"), localBeforeMerge);
  assert.equal(existsSync(join(local, ".git/MERGE_HEAD")), false);
  assert.equal(git(local, "status", "--porcelain"), "");

  // Reopen via ScopePicker branch row `more` menu -> `同步 / 解决冲突…`.
  await page.getByTestId("scope-picker").click();
  const mainRow = page.locator("[data-scope-ref-kind='localBranch'][data-ref-name='refs/heads/main']");
  await mainRow.hover();
  await mainRow.getByTestId("branch-more").click();
  await page.getByTestId("branch-more-resolve-diverged").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("branch-more-resolve-diverged").click();
  await page.getByTestId("open-three-pane-merge").waitFor({ state: "visible", timeout: 20_000 });
  await page.getByTestId("open-three-pane-merge").click();
  await page.getByTestId("three-pane-merge-view").waitFor({ state: "visible", timeout: 20_000 });

  // Resolve hunk 0 with sequential bilateral append (» then «), hunk 1 with » + manual center edit.
  await page.getByTestId("merge-accept-left-0").click();
  await page.getByTestId("merge-accept-right-0").click();
  assert.match(await page.getByTestId("merge-unresolved-count").textContent(), /剩余 1 处冲突/u);
  assert.equal(await page.getByTestId("merge-complete-submit").isDisabled(), true);

  await page.getByTestId("merge-accept-left-1").click();
  await page.getByTestId("merge-center-editor-1").fill("hunk1-local\nhunk1-manual-note");

  await page.waitForFunction(() => {
    const badge = document.querySelector('[data-testid="merge-unresolved-count"]');
    const btn = document.querySelector('[data-testid="merge-complete-submit"]');
    return badge?.textContent?.includes("全部冲突已解决") && btn && !btn.disabled;
  }, null, { timeout: 10_000 });
  await page.getByTestId("merge-push-after").check();
  await page.screenshot({ path: join(shots, "03-three-pane-resolved.png") });
  await page.getByTestId("merge-complete-submit").click();
  await page.getByTestId("three-pane-merge-view").waitFor({ state: "detached", timeout: 25_000 });
  await page.getByTestId("operation-notice").filter({ hasText: /已推送 main/u }).waitFor({ timeout: 25_000 });
  await idle();

  const mergedHead = oid(local, "HEAD");
  assert.equal(oid(originBare, "refs/heads/main"), mergedHead);
  assert.equal(git(local, "rev-parse", "HEAD^1"), localBeforeMerge);
  assert.equal(git(local, "status", "--porcelain"), "");
  assert.equal(existsSync(join(local, ".git/MERGE_HEAD")), false);
  assert.equal(
    await readFile(join(local, "shared.txt"), "utf8"),
    [
      "line-01-header",
      "hunk0-local",
      "hunk0-remote",
      "line-03-mid",
      "line-04-mid",
      "line-05-mid",
      "hunk1-local",
      "hunk1-manual-note",
      "line-07-footer",
      "",
    ].join("\n"),
  );

  assert.deepEqual(errors, []);
  console.log("M8 three-pane merge Electron smoke passed: clean 1-commit rebase+push, cancel zero-write, bilateral »/« sequential append, in-pane edit, and atomic merge+push.");
} finally {
  if (app) await app.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
