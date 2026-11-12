import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { checkBranchName } = await import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, "branch-name.mjs")));

const problem = (name, existing = []) => {
  const result = checkBranchName(name, existing);
  return result.ok ? "ok" : result.problem;
};

test("ordinary branch names are accepted", () => {
  for (const name of ["main", "fix/file-page", "feature/a.b", "m5-basic-operations", "release-0.1", "用户/修复", "a@b", "v1.0.0"]) {
    assert.equal(problem(name), "ok", name);
  }
});

test("names Git refuses are rejected with a specific reason", () => {
  const cases = {
    "": "empty",
    "HEAD": "reserved",
    "@": "reserved",
    "-x": "leadingDash",
    "fix/file page": "space",
    "a\tb": "controlChar",
    "a\u007fb": "controlChar",
    "a~1": "forbiddenChar",
    "a^": "forbiddenChar",
    "a:b": "forbiddenChar",
    "a?b": "forbiddenChar",
    "a*b": "forbiddenChar",
    "a[b": "forbiddenChar",
    "a\\b": "forbiddenChar",
    "a..b": "doubleDot",
    "a@{b": "atBrace",
    "/a": "leadingSlash",
    "a/": "trailingSlash",
    "a//b": "doubleSlash",
    "a.": "trailingDot",
    ".a": "componentLeadingDot",
    "a/.b": "componentLeadingDot",
    "a.lock": "componentLock",
    "a.lock/b": "componentLock",
  };
  for (const [name, expected] of Object.entries(cases)) assert.equal(problem(name), expected, JSON.stringify(name));
});

test("an empty name is quiet, every other problem is not", () => {
  assert.equal(checkBranchName("").quiet, true);
  assert.equal(checkBranchName("a b").quiet, false);
  assert.equal(checkBranchName("a b").message, "分支名不能包含空格");
});

test("existing local branches block the name, including directory-prefix clashes", () => {
  const existing = ["main", "feature/x"];
  assert.equal(problem("main", existing), "exists");
  assert.equal(problem("Main", existing), "ok");
  assert.equal(problem("feature", existing), "prefixConflict");
  assert.equal(problem("feature/x/y", existing), "prefixConflict");
  assert.equal(problem("feature/y", existing), "ok");
  assert.equal(problem("mainline", existing), "ok");
});
