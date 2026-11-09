import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") throw new Error("Run macOS packaging on a Mac.");
if (!["arm64", "x64"].includes(process.arch)) throw new Error(`Unsupported Mac architecture: ${process.arch}`);

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

await run(process.execPath, ["scripts/build.mjs", "--release"]);
const { name, version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
// All runtime imports are bundled; the package needs no development dependencies.
await writeFile(resolve(root, "apps/desktop/dist/package.json"), JSON.stringify({
  name,
  version,
  private: true,
  description: "只读 Git 历史浏览器",
  main: "main/index.cjs",
}, null, 2) + "\n");
await run("pnpm", [
  "exec", "electron-builder", "--config", "electron-builder.config.cjs", "--mac", `--${process.arch}`,
  "--publish", "never", ...(process.argv.includes("--dir") ? ["--dir"] : []),
]);
