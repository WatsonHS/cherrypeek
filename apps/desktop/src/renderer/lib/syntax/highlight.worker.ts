/*
 * Highlighting worker: tokenizes off the renderer's main thread and answers with the
 * compact encoding from tokens.ts. Requests are answered in order; any failure answers
 * null so the caller falls back to plain text.
 */
import { createSyntaxEngine } from "./engine.js";
import { encodeTokenLines, type HighlightRequest, type HighlightResponse } from "./tokens.js";

// The renderer tsconfig uses the DOM lib; describe just the worker scope that is used here.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<HighlightRequest>) => void) | null;
  postMessage(message: HighlightResponse, transfer: Transferable[]): void;
};

const engine = createSyntaxEngine();

scope.onmessage = event => {
  const { id, lines, language } = event.data;
  void engine.tokenize(lines, language).catch(() => null).then(tokenLines => {
    if (!tokenLines) {
      scope.postMessage({ id, tokens: null }, []);
      return;
    }
    const tokens = encodeTokenLines(tokenLines);
    scope.postMessage({ id, tokens }, [tokens.counts.buffer, tokens.kinds.buffer, tokens.lengths.buffer]);
  });
};
