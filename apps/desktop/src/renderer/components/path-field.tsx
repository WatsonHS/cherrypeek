import * as React from "react";
import type { RepositoryActions } from "../app.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

/** Path input shared by the open screen and the repository switcher. Enter does not submit while an IME is composing. */
export function PathField({ actions, disabled, onOpened }: { actions: RepositoryActions; disabled?: boolean; onOpened?: () => void }): React.JSX.Element {
  const composing = React.useRef(false);
  const submit = () => {
    onOpened?.();
    void actions.open();
  };
  return <div className="flex items-center gap-2">
    <label htmlFor="repository-path" className="sr-only">仓库目录</label>
    <Input id="repository-path" value={actions.path} disabled={disabled} spellCheck={false}
      className="font-mono text-[12.5px]" placeholder="输入绝对路径，例如 /Users/me/project"
      onChange={event => actions.setPath(event.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submit();
        }
      }} />
    <Button variant="outline" className="h-9" disabled={disabled} onClick={submit}>打开</Button>
  </div>;
}
