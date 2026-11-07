import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export async function createGraphFixture(root, { mainCommitCount = 13_050, includeBoundaries = true } = {}) {
  await mkdir(root, { recursive: true });
  const repository = join(root, "graph-history");
  await git(["init", "--quiet", "--initial-branch=main", repository]);
  await git(["-C", repository, "config", "user.name", "Graph Fixture"]);
  await git(["-C", repository, "config", "user.email", "graph@example.invalid"]);

  const marks = { root: 1, mainTip: mainCommitCount + 1, topics: [], unrelated: mainCommitCount + 11 };
  const stream = [];
  stream.push(commitRecord({ ref: "refs/heads/main", mark: 1, message: "graph root", timestamp: 1_700_000_000 }));
  let previous = 1;
  for (let index = 2; index <= mainCommitCount + 1; index += 1) {
    stream.push(commitRecord({ ref: "refs/heads/main", mark: index, parent: previous, message: `main ${index - 1}`, timestamp: 1_700_000_000 + Math.floor(index / 10) * 86_400 + index % 10 }));
    previous = index;
  }

  const topicCount = 9;
  for (let index = 0; index < topicCount; index += 1) {
    const mark = mainCommitCount + index + 2;
    marks.topics.push(mark);
    stream.push(commitRecord({ ref: `refs/heads/topic/${String(index).padStart(2, "0")}`, mark, parent: 1, message: `topic ${index}`, timestamp: 1_700_010_000 + index }));
  }

  const unrelated = marks.unrelated;
  stream.push(commitRecord({ ref: "refs/heads/unrelated-root", mark: unrelated, message: "independent root", timestamp: 1_700_020_000 }));

  const mergeMark = unrelated + 1;
  const mergeParents = [marks.mainTip, ...marks.topics, marks.root];
  stream.push(commitRecord({ ref: "refs/heads/main", mark: mergeMark, parent: mergeParents[0], merges: mergeParents.slice(1), message: "wide octopus with a long root edge", timestamp: 1_701_000_000 + Math.floor(mainCommitCount / 10) * 86_400 }));
  stream.push("done\n");
  await runFastImport(repository, stream.join(""));

  const headOid = (await git(["-C", repository, "rev-parse", "HEAD"])).trim();
  const mainOrder = (await git(["-C", repository, "rev-list", "--topo-order", "HEAD"])).trim().split("\n").filter(Boolean);
  if (mainOrder.length < mainCommitCount) throw new Error(`Graph fixture history is too short: ${mainOrder.length}`);

  let shallowRepository = null;
  let shallowHead = null;
  let graftRepository = null;
  let sha256Repository = null;
  if (includeBoundaries) {
    shallowRepository = join(root, "shallow");
    await git(["clone", "--quiet", "--no-local", "--depth=2", "--single-branch", `file://${repository}`, shallowRepository]);
    shallowHead = (await git(["-C", shallowRepository, "rev-parse", "HEAD"])).trim();

    graftRepository = join(root, "grafts");
    await git(["clone", "--quiet", "--shared", repository, graftRepository]);
    const graftsPath = (await git(["-C", graftRepository, "rev-parse", "--path-format=absolute", "--git-path", "info/grafts"])).trim();
    const relativeGraftsPath = relative(await realpath(graftRepository), resolve(graftsPath));
    if (!relativeGraftsPath || relativeGraftsPath.startsWith(`..${sep}`) || relativeGraftsPath === ".." || resolve(graftsPath) === resolve(graftRepository)) {
      throw new Error(`Refusing to write graft metadata outside the temporary repository: ${graftsPath}`);
    }
    await mkdir(dirname(graftsPath), { recursive: true });
    const unrelatedOid = (await git(["-C", repository, "rev-parse", "refs/heads/unrelated-root"])).trim();
    const rootOid = (await git(["-C", graftRepository, "rev-parse", `HEAD~${mainCommitCount}`])).trim();
    await writeFile(graftsPath, `${rootOid} ${unrelatedOid}\n`);

    const shaRoot = join(root, "sha256");
    let supportsSha256;
    try {
      await git(["init", "--quiet", "--object-format=sha256", "--initial-branch=main", shaRoot]);
      supportsSha256 = true;
    } catch (error) {
      if (!/object-format|sha256|unsupported|unknown option/i.test(`${error.message}\n${error.stderr ?? ""}`)) throw error;
      supportsSha256 = false;
    }
    if (supportsSha256) {
      await git(["-C", shaRoot, "config", "user.name", "Graph Fixture"]);
      await git(["-C", shaRoot, "config", "user.email", "graph@example.invalid"]);
      const shaStream = [];
      for (let index = 1; index <= 12; index += 1) {
        shaStream.push(commitRecord({ ref: "refs/heads/main", mark: index, ...(index > 1 ? { parent: index - 1 } : {}), message: `sha256 ${index}`, timestamp: 1_700_100_000 + index }));
      }
      shaStream.push("done\n");
      await runFastImport(shaRoot, shaStream.join(""));
      sha256Repository = shaRoot;
    }
  }

  return { repository, shallowRepository, shallowHead, graftRepository, sha256Repository, mainCommitCount, headOid, topicCount, mergeParentsCount: mergeParents.length };
}

export async function gitText(repository, args) {
  return (await git(["-C", repository, ...args])).trim();
}

export async function gitParentMap(repository, tips) {
  const output = await git(["-C", repository, "rev-list", "--topo-order", "--parents", ...tips, "--"]);
  return output.trim().split("\n").filter(Boolean).map(line => {
    const [oid, ...parents] = line.trim().split(/\s+/);
    return { oid, parents };
  });
}

function commitRecord({ ref, mark, parent, merges = [], message, timestamp }) {
  let result = `commit ${ref}\nmark :${mark}\nauthor Graph Fixture <graph@example.invalid> ${timestamp} +0000\ncommitter Graph Fixture <graph@example.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`;
  if (parent !== undefined) result += `from :${parent}\n`;
  for (const merge of merges) result += `merge :${merge}\n`;
  return `${result}\n`;
}

function runFastImport(repository, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", repository, "-c", "core.fsmonitor=false", "fast-import", "--quiet"], {
      stdio: ["pipe", "ignore", "pipe"], detached: process.platform !== "win32", windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16 * 1024); });
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`git fast-import exited ${code ?? signal}: ${stderr}`));
      else resolve();
    });
    child.stdin.end(input);
  });
}

async function git(args) {
  const { stdout } = await execFileAsync("git", args, { env: cleanGitEnvironment(), timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function cleanGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}

function killGroup(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
  } else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}
