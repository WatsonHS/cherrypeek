import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const buildDir = await mkdtemp(join(tmpdir(), "commitscope-protocol-"));
try {
  await execFileAsync("cargo", ["build", "--locked", "-p", "commitscope-daemon"], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  await build({
    entryPoints: {
      "core-process": resolve(root, "apps/desktop/src/main/core-process.ts"),
      "json-line-framer": resolve(root, "apps/desktop/src/main/json-line-framer.ts"),
      "protocol-transport": resolve(root, "apps/desktop/src/main/protocol-transport.ts"),
      "repository-session-controller": resolve(root, "apps/desktop/src/main/repository-session-controller.ts"),
      "view-context-gate": resolve(root, "apps/desktop/src/main/view-context-gate.ts"),
    },
    outdir: buildDir,
    bundle: true,
    platform: "node",
    format: "esm",
    outExtension: { ".js": ".mjs" },
    target: "node24",
    packages: "bundle",
    sourcemap: false,
  });
  const testFiles = (await readdir(resolve(root, "tests/protocol")))
    .filter(file => file.endsWith(".test.mjs"))
    .map(file => resolve(root, "tests/protocol", file));
  const env = {
    ...process.env,
    COMMITSCOPE_PROTOCOL_BUILD_DIR: buildDir,
    COMMITSCOPE_DAEMON_PATH: resolve(root, "target/debug", process.platform === "win32" ? "commitscope-daemon.exe" : "commitscope-daemon"),
  };
  const child = spawn(process.execPath, ["--test", "--test-timeout=20000", ...testFiles], { cwd: root, env, stdio: "inherit" });
  const result = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (result.code !== 0) process.exitCode = result.code ?? 1;
} finally {
  await rm(buildDir, { recursive: true, force: true });
}
