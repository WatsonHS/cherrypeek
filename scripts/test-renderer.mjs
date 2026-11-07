import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

// Unit tests for renderer logic that does not need a DOM or Electron.
const root = resolve(import.meta.dirname, "..");
const buildDir = await mkdtemp(join(tmpdir(), "commitscope-renderer-"));
try {
  await build({
    entryPoints: {
      "repository-session-store": resolve(root, "apps/desktop/src/renderer/lib/repository-session-store.ts"),
      "commit-detail-store": resolve(root, "apps/desktop/src/renderer/lib/commit-detail-store.ts"),
      "metadata-search-store": resolve(root, "apps/desktop/src/renderer/lib/metadata-search-store.ts"),
      "search-date": resolve(root, "apps/desktop/src/renderer/lib/search-date.ts"),
      "selection-intent": resolve(root, "apps/desktop/src/renderer/lib/selection-intent.ts"),
      "virtual-window": resolve(root, "apps/desktop/src/renderer/lib/virtual-window.ts"),
      "graph": resolve(root, "apps/desktop/src/renderer/lib/graph.ts"),
    },
    outdir: buildDir,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    target: "node24",
    sourcemap: false,
  });
  const testDir = resolve(root, "tests/renderer");
  const testFiles = (await readdir(testDir)).filter(file => file.endsWith(".test.mjs")).map(file => resolve(testDir, file));
  const child = spawn(process.execPath, ["--test", "--test-timeout=10000", ...testFiles], {
    cwd: root,
    env: { ...process.env, COMMITSCOPE_RENDERER_BUILD_DIR: buildDir },
    stdio: "inherit",
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
