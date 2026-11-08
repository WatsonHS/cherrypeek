/*
 * Tokenizer side of the token model (worker only). The Shiki theme paints each kind with a
 * sentinel colour, which is mapped back to a kind; the real colours live in CSS (`--syn-*`).
 */
import type { ThemeRegistrationRaw } from "shiki/core";
import type { SyntaxToken, SyntaxTokenKind } from "./tokens.js";

/** Sentinel colours: the theme paints each kind with one of these, then we map them back. */
const KIND_COLORS: Readonly<Record<SyntaxTokenKind, string>> = {
  plain: "#000000",
  keyword: "#000001",
  string: "#000002",
  number: "#000003",
  function: "#000004",
  type: "#000005",
  comment: "#000006",
};

const COLOR_KINDS: ReadonlyMap<string, SyntaxTokenKind> = new Map(
  Object.entries(KIND_COLORS).map(([kind, color]) => [color, kind as SyntaxTokenKind]),
);

/**
 * TextMate scope selectors per kind. The deepest matching scope wins (then the longer
 * selector), so the "plain" entries reset colour inside strings, templates and embedded
 * code, and keep operators, variables and property names in the normal text colour.
 */
const SCOPES: ReadonlyArray<readonly [SyntaxTokenKind, readonly string[]]> = [
  ["comment", ["comment", "punctuation.definition.comment"]],
  ["string", [
    "string", "punctuation.definition.string", "constant.character.escape",
    "markup.inline.raw", "markup.underline.link", "string.other.link",
  ]],
  ["number", [
    "constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant",
    "variable.other.enummember", "keyword.other.unit",
  ]],
  ["keyword", [
    "keyword", "storage", "variable.language",
    "keyword.operator.new", "keyword.operator.expression", "keyword.operator.cast", "keyword.operator.sizeof",
    "keyword.operator.alignof", "keyword.operator.typeid", "keyword.operator.alignas", "keyword.operator.instanceof",
    "keyword.operator.logical.python", "keyword.operator.wordlike", "keyword.operator.delete", "keyword.operator.noexcept",
    "punctuation.definition.template-expression", "punctuation.section.embedded",
  ]],
  ["function", [
    "entity.name.function", "support.function", "variable.function", "meta.function-call.generic",
    "entity.name.command", "markup.heading", "entity.name.section",
  ]],
  ["type", [
    "entity.name.type", "entity.name.class", "entity.name.namespace", "entity.other.inherited-class",
    "support.type", "support.class", "entity.name.tag",
    "entity.other.attribute-name.class", "entity.other.attribute-name.id",
    "entity.other.attribute-name.pseudo-class", "entity.other.attribute-name.pseudo-element",
    "storage.type.java", "storage.type.primitive.java", "storage.type.generic.java", "storage.type.annotation.java",
    "storage.type.object.array.java", "storage.type.primitive.array.java", "storage.type.cs", "storage.type.generic.cs",
    "storage.type.numeric.go", "storage.type.byte.go", "storage.type.boolean.go", "storage.type.string.go",
    "storage.type.uintptr.go", "storage.type.error.go", "storage.type.rune.go",
  ]],
  ["plain", [
    "keyword.operator", "variable", "meta.template.expression", "meta.embedded", "meta.interpolation",
    "support.type.property-name", "support.type.vendored.property-name", "meta.object-literal.key",
    "entity.name.tag.yaml", "string.unquoted.argument",
  ]],
];

export const SYNTAX_THEME_NAME = "commitscope-syntax";

export const SYNTAX_THEME: ThemeRegistrationRaw = {
  name: SYNTAX_THEME_NAME,
  type: "light",
  fg: KIND_COLORS.plain,
  bg: "#ffffff",
  settings: [
    { settings: { foreground: KIND_COLORS.plain, background: "#ffffff" } },
    ...SCOPES.map(([kind, scope]) => ({ scope: [...scope], settings: { foreground: KIND_COLORS[kind] } })),
  ],
};

/** Kind for a tokenizer colour; unknown or missing colours (e.g. skipped long lines) are plain. */
export function kindForColor(color: string | undefined): SyntaxTokenKind {
  return (color && COLOR_KINDS.get(color.toLowerCase())) || "plain";
}

// ---- Line alignment ------------------------------------------------------------------------

/** The part of a Shiki `ThemedToken` that is used here. */
export interface ColoredText {
  content: string;
  color?: string;
}

/**
 * Turns tokenizer output for `lines.join("\n")` into exactly one token list per input
 * line whose texts concatenate to that line. Adjacent tokens of the same kind are merged.
 * A line that does not match its tokens (e.g. a trailing "\r" the tokenizer treated as part
 * of the line break) is repaired or left plain. Returns null when the line structure
 * differs, which means the input did not split into these lines.
 */
export function alignTokenLines(lines: readonly string[], tokenLines: readonly (readonly ColoredText[])[]): SyntaxToken[][] | null {
  if (tokenLines.length !== lines.length) return null;
  return lines.map((line, index) => {
    const tokens: SyntaxToken[] = [];
    for (const token of tokenLines[index]!) {
      if (!token.content) continue;
      const kind = kindForColor(token.color);
      const last = tokens[tokens.length - 1];
      if (last && last.kind === kind) last.text += token.content;
      else tokens.push({ text: token.content, kind });
    }
    const text = tokens.map(token => token.text).join("");
    if (text === line) return tokens;
    if (line.endsWith("\r") && text === line.slice(0, -1)) {
      const last = tokens[tokens.length - 1];
      if (last && last.kind === "plain") last.text += "\r";
      else tokens.push({ text: "\r", kind: "plain" });
      return tokens;
    }
    return line ? [{ text: line, kind: "plain" }] : [];
  });
}
