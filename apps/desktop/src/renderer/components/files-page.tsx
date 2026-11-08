import * as React from "react";
import { PlaceholderBox } from "./placeholder.js";

/** The files page. Directory listing and file content need the core's tree and blob reads (P4-10). */
export function FilesPage(): React.JSX.Element {
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-panel p-8" data-testid="files-page">
    <PlaceholderBox task="P4-10" title="文件页" className="max-w-[520px]"
      note="目录树和文件内容需要核心按提交读取目录与文件（P4-10 后端，尚未接入）。" />
  </div>;
}
