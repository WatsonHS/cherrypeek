// Deterministic 100k linear commits, each modifying one text file. Never reuses an existing directory.
import { mkdir } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { once } from "node:events";
const path = resolve(process.argv[2]);
await mkdir(path, { recursive: false });
execFileSync("git", ["init", "-q", "-b", "main", path]);
const child = spawn(
  "git",
  [
    "-C",
    path,
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "fast-import",
    "--quiet",
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
for (let i = 1; i <= 100000; i++) {
  const message = `fixture ${i}`,
    content = `value ${i}\n`;
  const block = `commit refs/heads/main\nmark :${i}\nauthor Author ${i % 8} <author${i % 8}@example.invalid> ${1700000000 + i * 60} +0000\ncommitter Integrator <integrator@example.invalid> ${1700000030 + i * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${i > 1 ? `from :${i - 1}\n` : ""}M 100644 inline src/file.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
  if (!child.stdin.write(block)) await once(child.stdin, "drain");
}
child.stdin.end("done\n");
const [code] = await once(child, "close");
if (code !== 0) throw Error(`fast-import exited ${code}`);
console.log(path);
