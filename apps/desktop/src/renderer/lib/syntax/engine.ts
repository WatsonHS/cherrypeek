/*
 * Tokenizer used inside the highlighting worker (and by tests under Node). Shiki's core
 * API with the JavaScript regex engine: no WASM and no generated code, so the renderer's
 * CSP stays `script-src 'self'`. Grammars are the ones bundled with the app, loaded the
 * first time a language is needed.
 */
import { codeToTokens, createShikiPrimitive, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { isSyntaxLanguage, type SyntaxLanguage } from "./languages.js";
import { SYNTAX_THEME, SYNTAX_THEME_NAME, alignTokenLines } from "./theme.js";
import { MAX_TOKENIZE_LINE_LENGTH, type SyntaxToken } from "./tokens.js";

type GrammarModule = Promise<{ default: LanguageRegistration[] }>;

// Literal specifiers so the bundler can emit each grammar (with its embedded languages) as a
// lazy chunk; that needs Vite's `worker.format: "es"`, the default "iife" inlines them all.
const GRAMMARS: Readonly<Record<SyntaxLanguage, () => GrammarModule>> = {
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

export interface SyntaxEngine {
  /**
   * Tokenizes `lines.join("\n")` as one document, so constructs spanning lines (block
   * comments, template strings) are coloured correctly. Returns one token list per line,
   * or null when the language cannot be loaded or tokenizing fails.
   */
  tokenize(lines: readonly string[], language: string): Promise<SyntaxToken[][] | null>;
}

export function createSyntaxEngine(): SyntaxEngine {
  const shiki = createShikiPrimitive({
    themes: [SYNTAX_THEME],
    langs: [],
    // Patterns the JavaScript engine cannot express are skipped instead of failing the grammar.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  const loaded = new Map<SyntaxLanguage, Promise<boolean>>();

  function ensureLanguage(language: SyntaxLanguage): Promise<boolean> {
    let ready = loaded.get(language);
    if (!ready) {
      ready = GRAMMARS[language]().then(module => {
        shiki.loadLanguageSync(module.default);
        return true;
      }).catch(() => false);
      loaded.set(language, ready);
    }
    return ready;
  }

  return {
    async tokenize(lines, language) {
      if (!isSyntaxLanguage(language) || !(await ensureLanguage(language))) return null;
      try {
        const { tokens } = codeToTokens(shiki, lines.join("\n"), {
          lang: language,
          theme: SYNTAX_THEME_NAME,
          tokenizeMaxLineLength: MAX_TOKENIZE_LINE_LENGTH,
        });
        return alignTokenLines(lines, tokens);
      } catch {
        return null;
      }
    },
  };
}
