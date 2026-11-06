import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function snapshotTree(root) {
  const result = [];
  await visit(resolve(root), "");
  return result;

  async function visit(absolute, relative) {
    const metadata = await lstat(absolute);
    const record = {
      path: relative || ".",
      mode: metadata.mode & 0o7777,
      type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : metadata.isSymbolicLink() ? "symlink" : "other",
    };
    if (metadata.isSymbolicLink()) record.target = await readlink(absolute);
    else if (metadata.isFile()) record.sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
    result.push(record);
    if (metadata.isDirectory()) {
      const children = (await readdir(absolute)).sort();
      for (const child of children) await visit(join(absolute, child), relative ? `${relative}/${child}` : child);
    }
  }
}
