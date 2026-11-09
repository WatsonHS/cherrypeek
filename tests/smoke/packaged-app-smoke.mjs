import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const bundle = resolve(root, "release", process.arch === "arm64" ? "mac-arm64" : "mac", "CommitScope.app");
const temporary = await mkdtemp(join(tmpdir(), "commitscope 包测试 "));
const profile = join(temporary, "profile");
const output = resolve(root, "output/playwright");
await mkdir(output, { recursive: true });
const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
delete env.ELECTRON_RUN_AS_NODE;
const head = execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
let app;
let daemonPid;
try {
  app = await electron.launch({
    executablePath: join(bundle, "Contents/MacOS/CommitScope"),
    args: [`--repository=${root}`, `--user-data-dir=${profile}`],
    cwd: temporary,
    env,
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  await page.getByTestId("commit-row").first().waitFor({ timeout: 40_000 });
  assert.equal(await page.getByTestId("commit-row").first().getAttribute("data-oid"), head);
  const status = await page.evaluate(() => window.commitScope.getCoreStatus());
  assert.equal(status.state, "ready");
  assert.equal(status.core.git.available, true);
  daemonPid = status.core.pid;
  const paths = await app.evaluate(({ app, BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      packaged: app.isPackaged,
      name: app.getName(),
      appPath: app.getAppPath(),
      resources: process.resourcesPath,
      userData: app.getPath("userData"),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    };
  });
  assert.equal(paths.packaged, true);
  assert.equal(paths.appPath, join(bundle, "Contents/Resources/app.asar"));
  assert.equal(await realpath(paths.userData), await realpath(profile));
  assert.equal(paths.sandbox, true);
  assert.equal(paths.contextIsolation, true);
  assert.equal(paths.nodeIntegration, false);
  const daemonCommand = execFileSync("/bin/ps", ["-p", String(daemonPid), "-o", "command="], { encoding: "utf8" }).trim();
  assert.equal(daemonCommand, join(paths.resources, "commitscope-daemon"));
  await page.screenshot({ path: join(output, "p4-02-packaged-app.png") });
  await app.close();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(daemonPid, 0); } catch { daemonPid = undefined; break; }
    await delay(100);
  }
  assert.equal(daemonPid, undefined, "closing the app must reap its bundled core");
  const result = { passed: true, architecture: process.arch, git: status.core.git, paths, head, daemonCommand, path: env.PATH, coreReaped: true };
  await writeFile(join(output, "p4-02-packaged-app.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
