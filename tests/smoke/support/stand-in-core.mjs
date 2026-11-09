// Test stand-in for the core process, used only by tests/smoke/pages-smoke.mjs --stand-in.
// It forwards every message to the real daemon and answers the P4-09 to P4-12 methods
// (workspace, files page, blame) itself from the git CLI, so the renderer flows can be exercised
// independently of the daemon's implementation. Its answers are not acceptance evidence for
// P4-09 to P4-12; `pnpm test:smoke:pages` runs the same flows against the real daemon.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";

const repo = process.env.COMMITSCOPE_STAND_IN_REPOSITORY;
const real = spawn(process.env.COMMITSCOPE_STAND_IN_REAL_CORE, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
const OURS = new Set(["readWorkspaceStatus", "readWorkspaceDiff", "readWorkspaceFile", "listTree", "readFileContent", "readFileHistory", "readFileChange", "listPathChanges", "readBlame"]);
const out = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const git = (args, options = {}) => execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: options.buffer ? "buffer" : "utf8" });
const hex = text => Buffer.from(text, "utf8").toString("hex");
const fromHex = value => Buffer.from(value, "hex").toString("utf8");
const gitPath = text => ({ display: text, rawHex: hex(text), textLossy: false });

readline.createInterface({ input: process.stdin }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { real.stdin.write(`${line}\n`); return; }
  if (message.type === "request" && OURS.has(message.method)) {
    try { handle(message); } catch (error) {
      out({ type: "error", requestId: message.requestId, repoId: message.repoId, generation: message.generation, code: error.code ?? "GIT_ERROR", message: String(error.message ?? error).slice(0, 500), retryable: false });
    }
    return;
  }
  if (message.type === "cancel") { real.stdin.write(`${line}\n`); return; }
  real.stdin.write(`${line}\n`);
}).on("close", () => real.stdin.end());

readline.createInterface({ input: real.stdout }).on("line", line => {
  try {
    const message = JSON.parse(line);
    if (message.type === "hello") {
      for (const name of ["workspaceStatus", "fileBrowsing", "diffFullContext", "blame"]) {
        if (!message.core.capabilities.includes(name)) message.core.capabilities.push(name);
      }
      message.core.pid = process.pid;
      out(message);
      return;
    }
  } catch { /* pass through */ }
  process.stdout.write(`${line}\n`);
});
real.on("exit", code => process.exit(code ?? 0));

function respond(message, data, { sequence = 0, done = true, processed = 1 } = {}) {
  out({ type: "response", requestId: message.requestId, repoId: message.repoId, generation: message.generation, sequence, done,
    coverage: { complete: done, processed }, nextCursor: null, data });
}

function identity(name, email, time, offset) { return { name, email, timestamp: String(time), offset }; }

function summaries(oids) {
  if (!oids.length) return new Map();
  const raw = git(["show", "-s", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ad%x00%cn%x00%ce%x00%ct%x00%s%x00", "--date=format:%z", ...oids]);
  const fields = raw.split("\0");
  const map = new Map();
  for (let index = 0; index + 9 < fields.length; index += 10) {
    const [oid, parents, an, ae, at, az, cn, ce, ct, subject] = fields.slice(index, index + 10).map((value, position) => position === 0 ? value.trim() : value);
    map.set(oid, { oid, parents: parents ? parents.split(" ") : [], summary: subject.trim(), summaryTruncated: false,
      author: identity(an, ae, at, az.trim() || "+0000"), committer: identity(cn, ce, ct, az.trim() || "+0000"), textLossy: false });
  }
  return map;
}

function statusOf(letter) {
  return { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typeChanged" }[letter[0]] ?? "modified";
}

function handle(message) {
  const params = message.params;
  switch (message.method) {
    case "listTree": {
      const dir = params.pathHex ? fromHex(params.pathHex) : null;
      const raw = git(["ls-tree", "-z", "--long", params.commit, ...(dir ? ["--", `${dir}/`] : [])]);
      const entries = raw.split("\0").filter(Boolean).map(item => {
        const [meta, name] = item.split("\t");
        const [mode, type, oid, size] = meta.split(/\s+/u);
        const kind = type === "tree" ? "directory" : type === "commit" ? "submodule" : mode === "120000" ? "symlink" : "file";
        return { name: gitPath(name.split("/").at(-1)), path: gitPath(name), kind, mode, oid, size: size === "-" ? null : Number(size) };
      }).sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || Buffer.compare(Buffer.from(a.name.display), Buffer.from(b.name.display)));
      const page = entries.slice(params.offset, params.offset + params.limit);
      respond(message, { section: "treePage", page: { commit: params.commit, path: dir ? gitPath(dir) : null, entries: page, offset: params.offset, total: entries.length, hasMore: params.offset + page.length < entries.length } });
      return;
    }
    case "readFileContent": {
      const file = fromHex(params.pathHex);
      const base = { commit: params.commit, path: gitPath(file), text: "", lines: 0, totalLines: null, truncated: false, size: null, textLossy: false, symlinkTarget: null, blobOid: null };
      let line;
      try { line = git(["ls-tree", params.commit, "--", file]).trim(); } catch { line = ""; }
      if (!line) { respond(message, { section: "fileContent", content: { ...base, kind: "missing" } }); return; }
      const [mode, type, oid] = line.split("\t")[0].split(/\s+/u);
      if (type === "commit") { respond(message, { section: "fileContent", content: { ...base, kind: "submodule", blobOid: oid } }); return; }
      const bytes = git(["cat-file", "blob", oid], { buffer: true });
      if (mode === "120000") { respond(message, { section: "fileContent", content: { ...base, kind: "symlink", size: bytes.length, symlinkTarget: gitPath(bytes.toString("utf8")), blobOid: oid } }); return; }
      if (bytes.subarray(0, 8192).includes(0)) { respond(message, { section: "fileContent", content: { ...base, kind: "binary", size: bytes.length, blobOid: oid } }); return; }
      const text = bytes.toString("utf8");
      const all = text.split("\n");
      if (all.at(-1) === "") all.pop();
      const shown = all.slice(0, params.maxLines);
      respond(message, { section: "fileContent", content: { ...base, kind: "text", text: shown.length ? `${shown.join("\n")}\n` : "", lines: shown.length, totalLines: all.length,
        truncated: all.length > shown.length, size: bytes.length, blobOid: oid } });
      return;
    }
    case "readFileHistory": {
      const target = params.pathHex ? fromHex(params.pathHex) : ".";
      const offset = params.cursor ? Number(params.cursor) : 0;
      const filter = params.message ? ["-i", "-F", `--grep=${params.message}`] : [];
      const oids = git(["log", "--format=%H", ...filter, `--skip=${offset}`, `-n${params.pageSize + 1}`, params.commit, "--", target]).split("\n").filter(Boolean);
      const page = oids.slice(0, params.pageSize);
      const info = summaries(page);
      const entries = page.map(oid => {
        const commit = info.get(oid);
        const parent = commit.parents[0];
        const range = parent ? [parent, oid] : ["--root", oid];
        const numstat = git(["diff-tree", "-r", "-M", "--numstat", "--no-commit-id", ...range, "--", target]).split("\n").filter(Boolean);
        const status = git(["diff-tree", "-r", "-M", "--name-status", "--no-commit-id", ...range, "--", target]).split("\n").filter(Boolean);
        let additions = 0;
        let deletions = 0;
        let binary = false;
        for (const row of numstat) {
          const [add, del] = row.split("\t");
          if (add === "-") binary = true; else { additions += Number(add); deletions += Number(del); }
        }
        const first = status[0]?.split("\t") ?? ["M"];
        return { commit, change: { status: params.kind === "file" ? statusOf(first[0]) : "modified", oldPath: params.kind === "file" && first[0].startsWith("R") ? gitPath(first[1]) : null,
          additions: binary ? null : additions, deletions: binary ? null : deletions, binary, files: Math.max(1, status.length) } };
      });
      respond(message, { section: "fileHistory", page: { commit: params.commit, path: gitPath(params.pathHex ? target : ""), entries, nextCursor: oids.length > params.pageSize ? String(offset + params.pageSize) : null } });
      return;
    }
    case "readFileChange": {
      const file = fromHex(params.pathHex);
      const old = params.oldPathHex ? fromHex(params.oldPathHex) : null;
      const info = summaries([params.oid]).get(params.oid);
      const parent = params.parentIndex === null ? null : info.parents[params.parentIndex];
      // Like the core: a parent index the commit does not have is an invalid request (a root commit takes null).
      if (params.parentIndex !== null && !parent) throw Object.assign(new Error("parentIndex is outside the commit parent list"), { code: "INVALID_REQUEST" });
      const range = parent ? [parent, params.oid] : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", params.oid];
      const paths = old ? [old, file] : [file];
      const patch = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-M", params.fullFile ? "-U100000" : "-U3", ...range, "--", ...paths]);
      const numstat = git(["diff", "-M", "--numstat", ...range, "--", ...paths]).trim().split("\t");
      const status = git(["diff", "-M", "--name-status", ...range, "--", ...paths]).trim().split("\t");
      const binary = numstat[0] === "-";
      respond(message, { section: "fileDiff", diff: { oid: params.oid, parentIndex: params.parentIndex, parentOid: parent,
        file: { status: statusOf(status[0] || "M"), oldPath: old ? gitPath(old) : status[0]?.startsWith("A") ? null : gitPath(file), newPath: status[0]?.startsWith("D") ? null : gitPath(file),
          oldOid: null, newOid: null, oldMode: "100644", newMode: "100644", similarity: null,
          additions: binary ? null : Number(numstat[0] || 0), deletions: binary ? null : Number(numstat[1] || 0), binary, gitlink: false },
        kind: binary ? "binary" : "text", patch: binary ? "" : patch.slice(0, params.fullFile ? 1024 * 1024 : 128 * 1024), truncated: false, textLossy: false, oldSize: null, newSize: null } });
      return;
    }
    case "listPathChanges": {
      const directory = params.pathHex ? fromHex(params.pathHex) : "";
      const info = summaries([params.oid]).get(params.oid);
      const parent = params.parentIndex === null ? null : info.parents[params.parentIndex];
      // Like the core: a parent index the commit does not have is an invalid request (a root commit takes null).
      if (params.parentIndex !== null && !parent) throw Object.assign(new Error("parentIndex is outside the commit parent list"), { code: "INVALID_REQUEST" });
      const range = parent ? [parent, params.oid] : ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", params.oid];
      const scope = directory ? ["--", directory] : [];
      const statuses = git(["diff", "-M", "--name-status", ...range, ...scope]).trim().split("\n").filter(Boolean).map(line => line.split("\t"));
      const counts = new Map(git(["diff", "-M", "--numstat", ...range, ...scope]).trim().split("\n").filter(Boolean)
        .map(line => line.split("\t")).map(([added, deleted, ...paths]) => [paths.at(-1).replace(/^.*\{.*=> (.*)\}.*$/u, "$1"), [added, deleted]]));
      const files = statuses.map(([letter, first, second]) => {
        const renamed = letter.startsWith("R");
        const newPath = renamed ? second : letter.startsWith("D") ? null : first;
        const [added, deleted] = counts.get(newPath ?? first) ?? ["0", "0"];
        const binary = added === "-";
        return { status: statusOf(letter), oldPath: letter.startsWith("A") ? null : gitPath(first), newPath: newPath ? gitPath(newPath) : null,
          oldOid: null, newOid: null, oldMode: "100644", newMode: "100644", similarity: renamed ? Number(letter.slice(1)) : null,
          additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary, gitlink: false };
      });
      const page = files.slice(params.offset, params.offset + params.pageSize);
      const total = (key) => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);
      respond(message, { section: "changedFiles", page: { oid: params.oid, parentIndex: params.parentIndex, parentOid: parent, offset: params.offset, pageSize: params.pageSize,
        totalFiles: files.length, hasMore: params.offset + params.pageSize < files.length, files: page,
        overview: { totalFiles: files.length, counts: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, typeChanged: 0 }, additions: total("additions"), deletions: total("deletions"),
          binaryFiles: files.filter(file => file.binary).length, gitlinkFiles: 0, directories: [] } } });
      return;
    }
    case "readBlame": {
      const file = fromHex(params.pathHex);
      const raw = git(["blame", "--incremental", params.commit, "--", file]);
      const blocks = [];
      const commits = new Map();
      let current = null;
      for (const row of raw.split("\n")) {
        const header = row.match(/^([0-9a-f]{40,64}) (\d+) (\d+) (\d+)$/u);
        if (header) { current = { oid: header[1], originalStartLine: Number(header[2]), startLine: Number(header[3]), lineCount: Number(header[4]), originalPath: null }; continue; }
        if (!current) continue;
        const [key, ...rest] = row.split(" ");
        const value = rest.join(" ");
        if (!commits.has(current.oid)) commits.set(current.oid, { oid: current.oid, summary: "", summaryTruncated: false, authorName: "", authorEmail: "", authorTime: 0, textLossy: false });
        const commit = commits.get(current.oid);
        if (key === "author") commit.authorName = value;
        else if (key === "author-mail") commit.authorEmail = value.replace(/^<|>$/gu, "");
        else if (key === "author-time") commit.authorTime = Number(value);
        else if (key === "summary") commit.summary = value;
        else if (key === "filename") {
          if (value !== file) current.originalPath = gitPath(value);
          blocks.push(current);
          current = null;
        }
      }
      const totalLines = blocks.reduce((sum, block) => sum + block.lineCount, 0);
      const seen = new Set();
      const size = 40;
      for (let index = 0, sequence = 0; index < Math.max(blocks.length, 1); index += size, sequence += 1) {
        const chunkBlocks = blocks.slice(index, index + size);
        const chunkCommits = [];
        for (const block of chunkBlocks) if (!seen.has(block.oid)) { seen.add(block.oid); chunkCommits.push(commits.get(block.oid)); }
        const done = index + size >= blocks.length;
        respond(message, { section: "blameChunk", chunk: { commit: params.commit, path: gitPath(file), totalLines, blocks: chunkBlocks, commits: chunkCommits } },
          { sequence, done, processed: Math.min(blocks.length, index + size) });
      }
      return;
    }
    case "readWorkspaceStatus": {
      const raw = git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--branch"]);
      const records = raw.split("\0");
      const entries = new Map();
      let head = null;
      let ref = null;
      const entry = path => entries.get(path) ?? entries.set(path, { path: gitPath(path), originalPath: null, staged: null, unstaged: null, untracked: false, untrackedSize: null, conflict: null }).get(path);
      const change = letter => letter === "." ? null : { status: statusOf(letter), additions: null, deletions: null, binary: false, gitlink: false };
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record) continue;
        if (record.startsWith("# branch.oid ")) head = record.slice(13);
        else if (record.startsWith("# branch.head ")) ref = record.slice(14) === "(detached)" ? null : `refs/heads/${record.slice(14)}`;
        else if (record.startsWith("1 ")) { const parts = record.split(" "); const item = entry(parts.slice(8).join(" ")); item.staged = change(parts[1][0]); item.unstaged = change(parts[1][1]); }
        else if (record.startsWith("2 ")) { const parts = record.split(" "); const item = entry(parts.slice(9).join(" ")); item.staged = change(parts[1][0]); item.unstaged = change(parts[1][1]); item.originalPath = gitPath(records[index + 1]); index += 1; }
        else if (record.startsWith("u ")) { const parts = record.split(" "); entry(parts.slice(10).join(" ")).conflict = "bothModified"; }
        else if (record.startsWith("? ")) { const path = record.slice(2); const item = entry(path); item.untracked = true; try { item.untrackedSize = lstatSync(join(repo, path)).size; } catch { item.untrackedSize = null; } }
      }
      for (const [cached, side] of [[true, "staged"], [false, "unstaged"]]) {
        for (const row of git(["diff", ...(cached ? ["--cached"] : []), "--numstat", "-z", "--no-renames"]).split("\0").filter(Boolean)) {
          const [add, del, path] = row.split("\t");
          const item = entries.get(path);
          if (item?.[side]) Object.assign(item[side], add === "-" ? { binary: true } : { additions: Number(add), deletions: Number(del) });
        }
      }
      const list = [...entries.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path.display), Buffer.from(b.path.display)));
      respond(message, { section: "workspaceStatus", status: { observedAtUnixMs: Date.now(), headReference: ref, headOid: head === "(initial)" ? null : head, operation: "none",
        entries: list.slice(0, params.maxEntries), complete: list.length <= params.maxEntries, totalPaths: list.length, conflictCount: list.filter(item => item.conflict).length } });
      return;
    }
    case "readWorkspaceDiff": {
      const file = fromHex(params.pathHex);
      const patch = git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(params.side === "staged" ? ["--cached"] : []), params.fullFile ? "-U100000" : "-U3", "--", file]);
      respond(message, { section: "workspaceDiff", diff: { side: params.side, path: gitPath(file), oldPath: null, kind: "text", patch: patch.slice(0, 128 * 1024), truncated: false, textLossy: false, oldSize: null, newSize: null } });
      return;
    }
    case "readWorkspaceFile": {
      const file = fromHex(params.pathHex);
      const full = join(repo, file);
      const base = { path: gitPath(file), text: "", lines: 0, truncated: false, size: null, textLossy: false, symlinkTarget: null };
      let stat;
      try { stat = lstatSync(full); } catch { respond(message, { section: "workspaceFile", file: { ...base, kind: "missing" } }); return; }
      if (stat.isSymbolicLink()) { respond(message, { section: "workspaceFile", file: { ...base, kind: "symlink", symlinkTarget: gitPath(readlinkSync(full)) } }); return; }
      if (!stat.isFile()) { respond(message, { section: "workspaceFile", file: { ...base, kind: "notFile" } }); return; }
      if (stat.size > 1024 * 1024) { respond(message, { section: "workspaceFile", file: { ...base, kind: "tooLarge", size: stat.size } }); return; }
      const bytes = readFileSync(full);
      if (bytes.subarray(0, 8192).includes(0)) { respond(message, { section: "workspaceFile", file: { ...base, kind: "binary", size: stat.size } }); return; }
      const all = bytes.toString("utf8").split("\n");
      if (all.at(-1) === "") all.pop();
      const shown = all.slice(0, params.maxLines);
      respond(message, { section: "workspaceFile", file: { ...base, kind: "text", text: shown.length ? `${shown.join("\n")}\n` : "", lines: shown.length, truncated: all.length > shown.length, size: stat.size } });
      return;
    }
  }
}
