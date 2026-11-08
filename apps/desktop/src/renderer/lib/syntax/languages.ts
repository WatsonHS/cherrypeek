/*
 * Which bundled grammar highlights a file. The choice uses the file name only: nothing
 * in the viewed repository (attributes, modelines, editor config, grammars) is read.
 */

/** Grammar ids bundled with the app (Shiki language names). */
export const SYNTAX_LANGUAGES = [
  "c", "cpp", "csharp", "css", "dart", "docker", "go", "html", "ini", "java", "javascript",
  "json", "jsonc", "jsx", "kotlin", "less", "lua", "make", "markdown", "php", "python",
  "ruby", "rust", "scss", "shellscript", "sql", "svelte", "swift", "toml", "tsx",
  "typescript", "vue", "xml", "yaml",
] as const;

export type SyntaxLanguage = (typeof SYNTAX_LANGUAGES)[number];

const EXTENSIONS: Readonly<Record<string, SyntaxLanguage>> = {
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", "c++": "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", "h++": "cpp", ipp: "cpp", inl: "cpp",
  cs: "csharp", csx: "csharp",
  css: "css",
  dart: "dart",
  dockerfile: "docker",
  go: "go",
  htm: "html", html: "html", xhtml: "html",
  cfg: "ini", ini: "ini",
  java: "java",
  cjs: "javascript", js: "javascript", mjs: "javascript",
  json: "json", geojson: "json", webmanifest: "json",
  jsonc: "jsonc", json5: "jsonc",
  jsx: "jsx",
  kt: "kotlin", kts: "kotlin",
  less: "less",
  lua: "lua",
  mk: "make", mak: "make",
  markdown: "markdown", md: "markdown", mdown: "markdown", mkd: "markdown",
  php: "php", phtml: "php",
  py: "python", pyi: "python", pyw: "python",
  gemspec: "ruby", rake: "ruby", rb: "ruby", ru: "ruby",
  rs: "rust",
  scss: "scss",
  bash: "shellscript", ksh: "shellscript", sh: "shellscript", zsh: "shellscript",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  tsx: "tsx",
  cts: "typescript", mts: "typescript", ts: "typescript",
  vue: "vue",
  csproj: "xml", plist: "xml", svg: "xml", xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml",
  yaml: "yaml", yml: "yaml",
};

/** Whole (lower-case) file names that have no telling extension. */
const FILE_NAMES: Readonly<Record<string, SyntaxLanguage>> = {
  ".bash_profile": "shellscript", ".bashrc": "shellscript", ".profile": "shellscript",
  ".zprofile": "shellscript", ".zshenv": "shellscript", ".zshrc": "shellscript",
  ".editorconfig": "ini", ".gitconfig": "ini",
  "cargo.lock": "toml",
  containerfile: "docker", dockerfile: "docker",
  gemfile: "ruby", podfile: "ruby", rakefile: "ruby",
  gnumakefile: "make", makefile: "make",
};

export function isSyntaxLanguage(value: string): value is SyntaxLanguage {
  return (SYNTAX_LANGUAGES as readonly string[]).includes(value);
}

/** Grammar for a repository path (Git uses `/` separators), or null when none applies. */
export function languageForPath(path: string): SyntaxLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (!name) return null;
  if (Object.hasOwn(FILE_NAMES, name)) return FILE_NAMES[name];
  // "Dockerfile.dev" and similar variants.
  if (name.startsWith("dockerfile.") || name.startsWith("containerfile.")) return "docker";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return Object.hasOwn(EXTENSIONS, extension) ? EXTENSIONS[extension] : null;
}
