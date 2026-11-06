import { chmod, mkdir, copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { build as buildRenderer } from "vite";
import { build as buildBundle } from "esbuild";
import { generateProtocol } from "./protocol-lib.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const desktop = resolve(root, "apps/desktop");
const dist = resolve(desktop, "dist");
const resources = resolve(dist, "resources");
const release = process.argv.includes("--release");
const profileArgs = release ? ["--release"] : [];
const binaryDir = release ? "release" : "debug";

await generateProtocol();
await execFileAsync("cargo", ["build", "-p", "commitscope-daemon", "--locked", ...profileArgs], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
await rm(dist, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await copyFile(resolve(root, `target/${binaryDir}/commitscope-daemon`), resolve(resources, "commitscope-daemon"));
await chmod(resolve(resources, "commitscope-daemon"), 0o755);
await buildRenderer({ configFile: resolve(desktop, "vite.config.ts") });
await buildBundle({
  entryPoints: [resolve(desktop, "src/main/index.ts")],
  outfile: resolve(dist, "main/index.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
});
await buildBundle({
  entryPoints: [resolve(desktop, "src/preload/index.ts")],
  outfile: resolve(dist, "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: false,
});
process.stdout.write(`Built ${release ? "release" : "debug"} Rust daemon and Electron desktop assets.\n`);
