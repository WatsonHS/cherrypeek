import * as React from "react";
import type { RepositoryInfo } from "../../../../../packages/protocol/src/generated/server-message.js";
import { workspaceHeadText } from "../lib/workspace-indicator.js";
import { PlaceholderBox } from "./placeholder.js";

/**
 * The workspace page. Reading the working tree needs the core's workspace capability (P4-09),
 * which is not wired yet, so the page states that plainly instead of showing sample files.
 */
export function WorkspacePage({ repository }: { repository: RepositoryInfo }): React.JSX.Element {
  const directory = repository.worktreePath ?? repository.path;
  return <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="workspace-page">
    <nav aria-label="工作区改动的文件" className="flex min-h-0 max-w-[400px] flex-[1_1_340px] flex-col border-r border-line">
      <div className="flex items-center gap-1.5 px-[18px] pt-2 pb-0.5">
        <span className="min-w-0 flex-1 truncate text-xs text-fg3" title={`${directory} · HEAD ${workspaceHeadText(repository)}`}>
          <span className="font-mono">{directory}</span> · {workspaceHeadText(repository)}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pt-2 pb-4">
        <PlaceholderBox task="P4-09" title="已暂存 / 未暂存 / 未跟踪 / 冲突"
          note="核心还不能读取工作区状态。接入后这里按组列出改动的文件，同一文件两组都有时各出现一次。" />
      </div>
    </nav>
    <main aria-label="所选文件的改动" className="flex min-h-0 min-w-0 flex-[999_1_560px] items-center justify-center overflow-auto bg-panel p-8">
      <PlaceholderBox task="P4-09" title="工作区改动" className="max-w-[520px]"
        note="读取工作区需要核心提供只读的工作区查询（P4-09 后端，尚未接入）。这里不显示示例文件，也不会把未读取说成“干净”。" />
    </main>
  </div>;
}
