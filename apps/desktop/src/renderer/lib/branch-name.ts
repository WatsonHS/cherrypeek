/**
 * Checks a new local branch name the way `git check-ref-format --branch` does, as far as is practical
 * on the client. Git (and the core) stay the final authority; this only gives early, specific feedback.
 */

export type BranchNameProblem =
  | "empty"
  | "reserved"
  | "leadingDash"
  | "space"
  | "controlChar"
  | "forbiddenChar"
  | "doubleDot"
  | "atBrace"
  | "leadingSlash"
  | "trailingSlash"
  | "doubleSlash"
  | "trailingDot"
  | "componentLeadingDot"
  | "componentLock"
  | "exists"
  | "prefixConflict";

export type BranchNameCheck = { ok: true } | { ok: false; problem: BranchNameProblem; message: string; /** The name is only blank so far: show no error yet. */ quiet: boolean };

const FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

const MESSAGES: Record<BranchNameProblem, string> = {
  empty: "请输入分支名",
  reserved: "这个名称不能用作分支名",
  leadingDash: "分支名不能以 - 开头",
  space: "分支名不能包含空格",
  controlChar: "分支名不能包含控制字符",
  forbiddenChar: "分支名不能包含 ~ ^ : ? * [ \\",
  doubleDot: "分支名不能包含 ..",
  atBrace: "分支名不能包含 @{",
  leadingSlash: "分支名不能以 / 开头",
  trailingSlash: "分支名不能以 / 结尾",
  doubleSlash: "分支名不能包含连续的 /",
  trailingDot: "分支名不能以 . 结尾",
  componentLeadingDot: "/ 分隔的每一段都不能以 . 开头",
  componentLock: "/ 分隔的每一段都不能以 .lock 结尾",
  exists: "已有同名的本地分支",
  prefixConflict: "与已有分支冲突：其中一个是另一个的目录前缀",
};

/**
 * @param existingLocal short names of the local branches known right now (without `refs/heads/`).
 */
export function checkBranchName(name: string, existingLocal: readonly string[] = []): BranchNameCheck {
  const fail = (problem: BranchNameProblem, detail = ""): BranchNameCheck =>
    ({ ok: false, problem, message: `${MESSAGES[problem]}${detail}`, quiet: problem === "empty" });
  if (name === "") return fail("empty");
  if (name === "@" || name === "HEAD") return fail("reserved");
  if (name.startsWith("-")) return fail("leadingDash");
  for (const char of name) {
    const code = char.codePointAt(0)!;
    if (char === " ") return fail("space");
    if (code < 0x20 || code === 0x7f) return fail("controlChar");
    if (FORBIDDEN.has(char)) return fail("forbiddenChar");
  }
  if (name.includes("..")) return fail("doubleDot");
  if (name.includes("@{")) return fail("atBrace");
  if (name.startsWith("/")) return fail("leadingSlash");
  if (name.endsWith("/")) return fail("trailingSlash");
  if (name.includes("//")) return fail("doubleSlash");
  if (name.endsWith(".")) return fail("trailingDot");
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return fail("componentLeadingDot");
    if (part.endsWith(".lock")) return fail("componentLock");
  }
  for (const existing of existingLocal) {
    if (existing === name) return fail("exists");
    if (existing.startsWith(`${name}/`) || name.startsWith(`${existing}/`)) return fail("prefixConflict", `（${existing}）`);
  }
  return { ok: true };
}
