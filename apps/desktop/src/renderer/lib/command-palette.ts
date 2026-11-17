import type { RefInfo, RepositoryScope, WorktreeInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { repositoryName, shortRefName } from "./format.js";

export type PaletteCommand = "openRepository" | "commits" | "files" | "workspace" | "stats" | "copyCommit" | "copyMessage" | "copyBranch"
  | "openFinder" | "openTerminal" | "openEditor" | "fetch" | "fetchPrune" | "push" | "mergeIntoBase";
export type PaletteAction = { kind: "commit"; oid: string } | { kind: "scope"; scope: RepositoryScope } | { kind: "command"; command: PaletteCommand };
export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  detail?: string;
  shortcut?: string;
  action: PaletteAction;
}
export interface PaletteContext {
  refs: RefInfo[];
  worktrees: WorktreeInfo[];
  repositoryReady: boolean;
  coreReady: boolean;
  filesAvailable: boolean;
  workspaceAvailable: boolean;
  selectedOid: string | null;
  oidLength: number;
  /** P5-05. The full message of the selected commit once its details are loaded, else its summary. */
  selectedMessage?: string | null;
  /** The branch the window's working directory has checked out, as a full ref name. */
  headReference?: string | null;
  /** False for a bare repository, which has no working directory to open in a terminal or editor. */
  hasWorkingDirectory?: boolean;
  /** P5-01: the core can run operations and no fetch is in progress. */
  fetchAvailable?: boolean;
  /** M7: label for non-force push/publish of current branch when available. */
  pushLabel?: string | null;
  /** M7: label for fast-forward merging current branch into local default base. */
  mergeBaseLabel?: string | null;
}

/** Only uses the current frozen navigation snapshot; never reads the repository from the renderer. */
export function paletteItems(query: string, context: PaletteContext, modifier = "⌘"): { items: PaletteItem[]; total: number } {
  const text = query.trim().toLowerCase();
  const items: PaletteItem[] = [];
  if (context.repositoryReady) {
    if (/^[0-9a-f]{4,64}$/.test(text) && text.length <= context.oidLength) {
      items.push({ id: "commit", group: "提交", label: `定位提交 ${text}`, detail: "在当前浏览范围内定位", action: { kind: "commit", oid: text } });
    }
    const scopes: PaletteItem[] = [
      { id: "head", group: "分支", label: "HEAD", detail: "当前工作区的提交历史", action: { kind: "scope", scope: "head" } },
      { id: "all", group: "分支", label: "所有分支", action: { kind: "scope", scope: "allBranches" } },
      ...context.refs.filter(ref => ref.kind === "localBranch" || ref.kind === "remoteBranch" || ref.kind === "tag").map(ref => ({
        id: `ref:${ref.name}`, group: ref.kind === "tag" ? "标签" : "分支", label: shortRefName(ref.name), detail: ref.name,
        action: { kind: "scope", scope: { ref: ref.name } } as PaletteAction,
      })),
      ...context.worktrees.filter(tree => tree.available && tree.headOid).map(tree => ({
        id: `worktree:${tree.id}`, group: "worktree", label: repositoryName(tree.path),
        detail: `${tree.path}${tree.headReference ? ` · ${shortRefName(tree.headReference)}` : " · detached"}`,
        action: { kind: "scope", scope: { worktree: tree.id } } as PaletteAction,
      })),
    ];
    items.push(...scopes.filter(item => !text || `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(text)));
  }
  const commands: [PaletteCommand, string, boolean, string?][] = [
    ["openRepository", "打开仓库…", context.coreReady],
    ["commits", "切换到提交页", context.repositoryReady, `${modifier}1`],
    ["files", "切换到文件页", context.repositoryReady && context.filesAvailable, `${modifier}2`],
    ["workspace", "切换到工作区", context.repositoryReady && context.workspaceAvailable, `${modifier}3`],
    ["stats", "切换到统计页", context.repositoryReady, `${modifier}4`],
    ["fetch", "Fetch：从所有远端获取新提交", context.repositoryReady && Boolean(context.fetchAvailable)],
    ["fetchPrune", "Fetch 并清理远端已删除的分支", context.repositoryReady && Boolean(context.fetchAvailable)],
    ["push", context.pushLabel ?? "推送当前分支", context.repositoryReady && Boolean(context.fetchAvailable && context.pushLabel)],
    ["mergeIntoBase", context.mergeBaseLabel ?? "快进合入默认基准分支…", context.repositoryReady && Boolean(context.fetchAvailable && context.mergeBaseLabel)],
    ["copyCommit", "复制当前提交 hash", context.repositoryReady && Boolean(context.selectedOid)],
    ["copyMessage", "复制当前提交消息", context.repositoryReady && Boolean(context.selectedOid && context.selectedMessage)],
    ["copyBranch", context.headReference ? `复制当前分支名 ${shortRefName(context.headReference)}` : "复制当前分支名", context.repositoryReady && Boolean(context.headReference)],
    ["openFinder", "在 Finder 中打开仓库目录", context.repositoryReady],
    ["openTerminal", "在终端打开工作区", context.repositoryReady && Boolean(context.hasWorkingDirectory)],
    ["openEditor", "在编辑器打开工作区", context.repositoryReady && Boolean(context.hasWorkingDirectory)],
  ];
  items.push(...commands.filter(([, label, enabled]) => enabled && (!text || label.toLowerCase().includes(text))).map(([command, label, , shortcut]) => ({
    id: command, group: "命令", label, shortcut, action: { kind: "command", command } as PaletteAction,
  })));
  // Keep groups together and reserve room for commands even in a repository with thousands of refs.
  const visible = ["提交", "命令", "分支", "标签", "worktree"].flatMap(group => items.filter(item => item.group === group).slice(0, 20));
  return { items: visible, total: items.length };
}
