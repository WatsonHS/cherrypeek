import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
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
// Remove legacy pre-rename artifacts in release/ if any exist.
for (const entry of await readdir(resolve(root, "release")).catch(() => [])) {
  if (entry.startsWith("CommitScope-")) await rm(resolve(root, "release", entry), { recursive: true, force: true });
}
// All runtime imports are bundled; the package needs no development dependencies.
await writeFile(resolve(root, "apps/desktop/dist/package.json"), JSON.stringify({
  name,
  // Electron names the app data folder after productName: ~/Library/Application Support/CherryPeek.
  productName: "CherryPeek",
  version,
  author: "Sheng Huang",
  license: "MIT",
  private: true,
  description: "桌面 Git 历史浏览、统计分析与安全收口客户端",
  main: "main/index.cjs",
}, null, 2) + "\n");
await run("pnpm", [
  "exec", "electron-builder", "--config", "electron-builder.config.cjs", "--mac", `--${process.arch}`,
  "--publish", "never", ...(process.argv.includes("--dir") ? ["--dir"] : []),
]);
