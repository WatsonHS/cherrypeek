import type { RefInfo, RepositoryScope, WorktreeInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { repositoryName, shortRefName } from "./format.js";

export type PaletteCommand = "openRepository" | "commits" | "files" | "workspace" | "copyCommit";
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
    ["copyCommit", "复制当前提交 hash", context.repositoryReady && Boolean(context.selectedOid)],
  ];
  items.push(...commands.filter(([, label, enabled]) => enabled && (!text || label.toLowerCase().includes(text))).map(([command, label, , shortcut]) => ({
    id: command, group: "命令", label, shortcut, action: { kind: "command", command } as PaletteAction,
  })));
  // Keep groups together and reserve room for commands even in a repository with thousands of refs.
  const visible = ["提交", "命令", "分支", "标签", "worktree"].flatMap(group => items.filter(item => item.group === group).slice(0, 20));
  return { items: visible, total: items.length };
}
