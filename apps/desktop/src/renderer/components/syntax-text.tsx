import * as React from "react";
import type { SyntaxToken, SyntaxTokenKind } from "../lib/syntax/tokens.js";

const KIND_CLASS: Readonly<Record<Exclude<SyntaxTokenKind, "plain">, string>> = {
  keyword: "text-syn-keyword",
  string: "text-syn-string",
  number: "text-syn-number",
  function: "text-syn-function",
  type: "text-syn-type",
  comment: "text-syn-comment",
};

/**
 * One line of code: highlighted tokens as text nodes (repository text is never parsed as
 * markup), or `fallback` as plain text while tokens are missing. Plain tokens inherit the
 * surrounding text colour.
 */
export const SyntaxLine = React.memo(function SyntaxLine({ tokens, fallback }: { tokens: readonly SyntaxToken[] | null; fallback: string }): React.JSX.Element {
  if (!tokens) return <>{fallback}</>;
  return (
    <>
      {tokens.map((token, index) => token.kind === "plain"
        ? <React.Fragment key={index}>{token.text}</React.Fragment>
        : <span key={index} className={KIND_CLASS[token.kind]}>{token.text}</span>)}
    </>
  );
});
