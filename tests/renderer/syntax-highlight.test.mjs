import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = name => import(pathToFileURL(join(process.env.COMMITSCOPE_RENDERER_BUILD_DIR, `${name}.mjs`)));
const { languageForPath, SYNTAX_LANGUAGES } = await load("syntax-languages");
const {
  decodeTokenLines, encodeTokenLines, exceedsHighlightLimits,
  HIGHLIGHT_TIMEOUT_MS, MAX_HIGHLIGHT_BYTES, MAX_HIGHLIGHT_LINES, MAX_TOKENIZE_LINE_LENGTH,
} = await load("syntax-tokens");
const { alignTokenLines, kindForColor } = await load("syntax-theme");
const { createSyntaxEngine } = await load("syntax-engine");
const { highlightLines } = await load("syntax-highlight");

const joined = tokens => tokens.map(token => token.text).join("");
const kindsOf = (tokens, text) => tokens.filter(token => token.text.includes(text)).map(token => token.kind);
const kindOf = (tokens, text) => {
  const kinds = kindsOf(tokens, text);
  assert.ok(kinds.length > 0, `no token contains ${JSON.stringify(text)} in ${JSON.stringify(tokens)}`);
  return kinds[0];
};

function assertLinesKept(lines, tokenLines) {
  assert.ok(tokenLines, "expected token lines");
  assert.equal(tokenLines.length, lines.length);
  lines.forEach((line, index) => assert.equal(joined(tokenLines[index]), line, `line ${index + 1}`));
}

test("languages come from the file name only, case-insensitively", () => {
  const cases = {
    "src/app.ts": "typescript", "src/view.TSX": "tsx", "lib/index.mjs": "javascript", "a.cjs": "javascript",
    "a.jsx": "jsx", "types/a.d.ts": "typescript", "package.json": "json", "tsconfig.jsonc": "jsonc",
    "crates/core/src/lib.rs": "rust", "Cargo.toml": "toml", "Cargo.lock": "toml", "README.md": "markdown",
    "styles.css": "css", "index.html": "html", ".github/workflows/ci.yml": "yaml", "pnpm-lock.yaml": "yaml",
    "build.sh": "shellscript", "x.bash": "shellscript", "x.zsh": "shellscript", ".zshrc": "shellscript",
    "main.py": "python", "main.go": "go", "Main.java": "java", "Main.kt": "kotlin", "App.swift": "swift",
    "a.c": "c", "a.h": "c", "a.cpp": "cpp", "a.hpp": "cpp", "Program.cs": "csharp", "a.rb": "ruby",
    "index.php": "php", "q.sql": "sql", "main.dart": "dart", "pom.xml": "xml", "App.vue": "vue",
    "App.svelte": "svelte", "Dockerfile": "docker", "docker/Dockerfile.dev": "docker", "Makefile": "make",
    "Gemfile": "ruby",
  };
  for (const [path, language] of Object.entries(cases)) {
    assert.equal(languageForPath(path), language, path);
    assert.ok(SYNTAX_LANGUAGES.includes(language), language);
  }
  for (const path of ["README", "LICENSE", "src/a.b/notes", "file.", ".gitignore", "image.png", "x.unknownext", "dir/", "", "a.constructor", "a.__proto__"]) {
    assert.equal(languageForPath(path), null, path);
  }
});

test("size limits count lines and UTF-8 bytes of the joined text", () => {
  assert.equal(exceedsHighlightLimits(Array(MAX_HIGHLIGHT_LINES).fill("x")), false);
  assert.equal(exceedsHighlightLimits(Array(MAX_HIGHLIGHT_LINES + 1).fill("")), true);
  // Two lines joined by "\n" fill the byte budget exactly.
  const half = (MAX_HIGHLIGHT_BYTES - 1) / 2;
  assert.equal(exceedsHighlightLimits(["a".repeat(Math.floor(half)), "a".repeat(Math.ceil(half))]), false);
  assert.equal(exceedsHighlightLimits(["a".repeat(MAX_HIGHLIGHT_BYTES + 1)]), true);
  // "é" is 2 bytes, "中" 3 and an emoji 4, although each is 1 or 2 UTF-16 units.
  assert.equal(exceedsHighlightLimits(["é".repeat(MAX_HIGHLIGHT_BYTES / 2)]), false);
  assert.equal(exceedsHighlightLimits(["é".repeat(MAX_HIGHLIGHT_BYTES / 2 + 1)]), true);
  assert.equal(exceedsHighlightLimits(["中".repeat(Math.floor(MAX_HIGHLIGHT_BYTES / 3) + 1)]), true);
  assert.equal(exceedsHighlightLimits(["😀".repeat(MAX_HIGHLIGHT_BYTES / 4)]), false);
  assert.equal(exceedsHighlightLimits(["😀".repeat(MAX_HIGHLIGHT_BYTES / 4 + 1)]), true);
});

test("tokenizer colours map back to kinds; anything unknown is plain", () => {
  assert.equal(kindForColor("#000001"), "keyword");
  assert.equal(kindForColor("#000006"), "comment");
  assert.equal(kindForColor("#000000"), "plain");
  assert.equal(kindForColor(""), "plain");
  assert.equal(kindForColor(undefined), "plain");
  assert.equal(kindForColor("#123456"), "plain");
});

test("aligning keeps one token list per line that rebuilds the line", () => {
  const lines = ["const a = 1;", "", "x\r", "broken"];
  const aligned = alignTokenLines(lines, [
    [{ content: "const", color: "#000001" }, { content: " ", color: "#000000" }, { content: "a = ", color: "#000000" }, { content: "1", color: "#000003" }, { content: ";", color: "#000000" }],
    [],
    [{ content: "x", color: "#000002" }],
    [{ content: "brok", color: "#000001" }],
  ]);
  assertLinesKept(lines, aligned);
  assert.deepEqual(aligned[0], [
    { text: "const", kind: "keyword" }, { text: " a = ", kind: "plain" }, { text: "1", kind: "number" }, { text: ";", kind: "plain" },
  ]);
  assert.deepEqual(aligned[1], []);
  assert.deepEqual(aligned[2], [{ text: "x", kind: "string" }, { text: "\r", kind: "plain" }]);
  assert.deepEqual(aligned[3], [{ text: "broken", kind: "plain" }]);
  assert.equal(alignTokenLines(["a", "b"], [[{ content: "a" }]]), null);
});

test("the worker encoding round-trips over the caller's lines", () => {
  const lines = ["let s = \"😀\";", "", "  // c"];
  const tokenLines = [
    [{ text: "let", kind: "keyword" }, { text: " s = ", kind: "plain" }, { text: "\"😀\"", kind: "string" }, { text: ";", kind: "plain" }],
    [],
    [{ text: "  ", kind: "plain" }, { text: "// c", kind: "comment" }],
  ];
  const encoded = encodeTokenLines(tokenLines);
  assert.deepEqual(decodeTokenLines(lines, encoded), tokenLines);
  // Lengths that do not add up leave that line plain; a different line count is rejected.
  assert.deepEqual(decodeTokenLines(["let s = 1;", "", "  // c"], encoded)[0], [{ text: "let s = 1;", kind: "plain" }]);
  assert.equal(decodeTokenLines(["only one"], encoded), null);
});

test("Shiki tokenizes TypeScript as one document and keeps every line intact", async () => {
  const engine = createSyntaxEngine();
  const lines = [
    "/* first line of a block comment",
    "   still inside the comment */",
    "",
    "export function greet(name: string): string {",
    "  const label = \"hi 😀 there\";",
    "  return `${label}, ${name.trim()}` + 42;",
    "}",
    "class Box<T> extends Base { value = true; }",
  ];
  const tokens = await engine.tokenize(lines, "typescript");
  assertLinesKept(lines, tokens);
  assert.deepEqual(tokens[0].map(token => token.kind), ["comment"]);
  assert.deepEqual(tokens[1], [{ text: lines[1], kind: "comment" }]);
  assert.deepEqual(tokens[2], []);
  assert.equal(kindOf(tokens[3], "export"), "keyword");
  assert.equal(kindOf(tokens[3], "function"), "keyword");
  assert.equal(kindOf(tokens[3], "greet"), "function");
  assert.equal(kindOf(tokens[3], "string"), "type");
  assert.equal(kindOf(tokens[4], "😀"), "string");
  assert.equal(kindOf(tokens[4], "const"), "keyword");
  assert.equal(kindOf(tokens[4], "label"), "plain");
  // Template text is a string, the embedded expression is code again.
  assert.equal(kindOf(tokens[5], ", "), "string");
  assert.equal(kindOf(tokens[5], "trim"), "function");
  assert.equal(kindOf(tokens[5], "42"), "number");
  assert.ok(!kindsOf(tokens[5], "name").includes("string"));
  assert.equal(kindOf(tokens[7], "Box"), "type");
  assert.equal(kindOf(tokens[7], "true"), "number");
});

test("CRLF lines, long lines and unknown languages degrade without losing text", async () => {
  const engine = createSyntaxEngine();
  const crlf = ["let a = 1;\r", "// note\r", "let b = 2;"];
  const crlfTokens = await engine.tokenize(crlf, "typescript");
  assertLinesKept(crlf, crlfTokens);
  assert.equal(kindOf(crlfTokens[1], "// note"), "comment");

  const long = `const big = "${"x".repeat(MAX_TOKENIZE_LINE_LENGTH)}";`;
  const lines = ["const a = 1;", long, "const b = 2;"];
  const tokens = await engine.tokenize(lines, "typescript");
  assertLinesKept(lines, tokens);
  assert.deepEqual(tokens[1], [{ text: long, kind: "plain" }]);
  assert.equal(kindOf(tokens[2], "const"), "keyword");

  assert.equal(await engine.tokenize(["x"], "brainfuck"), null);
  assert.equal(await engine.tokenize(["x"], "constructor"), null);
});

test("property names, keys and operators stay in the text colour", async () => {
  const engine = createSyntaxEngine();
  const json = await engine.tokenize(["{\"name\": \"commitscope\", \"private\": true, \"n\": 1}"], "json");
  assert.equal(kindOf(json[0], "name"), "plain");
  assert.equal(kindOf(json[0], "commitscope"), "string");
  assert.equal(kindOf(json[0], "true"), "number");
  const ts = await engine.tokenize(["if (a && typeof b === \"x\") obj.prop = 1;"], "typescript");
  assert.equal(kindOf(ts[0], "&&"), "plain");
  assert.equal(kindOf(ts[0], "typeof"), "keyword");
  assert.equal(kindOf(ts[0], "prop"), "plain");
  const py = await engine.tokenize(["def run(x):", "    return helper(x)  # done"], "python");
  assert.equal(kindOf(py[0], "run"), "function");
  assert.equal(kindOf(py[1], "helper"), "function");
  assert.equal(kindOf(py[1], "# done"), "comment");
});

test("every bundled language loads with the JavaScript regex engine", async () => {
  const engine = createSyntaxEngine();
  const lines = ["value = \"text\" // 1", "", "# 2 /* x */"];
  for (const language of SYNTAX_LANGUAGES) {
    const tokens = await engine.tokenize(lines, language);
    assert.ok(tokens, `${language} did not load`);
    assertLinesKept(lines, tokens);
  }
});

// ---- Renderer client, with a stand-in for the worker ------------------------------------------

class FakeWorker {
  static created = [];
  sent = [];
  terminated = false;
  constructor() { FakeWorker.created.push(this); }
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  reply(id, tokenLines) { this.onmessage?.({ data: { id, tokens: tokenLines ? encodeTokenLines(tokenLines) : null } }); }
  crash() { this.onerror?.({ type: "error" }); }
}
globalThis.Worker = FakeWorker;
const latestWorker = () => FakeWorker.created[FakeWorker.created.length - 1];
const settled = async promise => {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  return done;
};

test("content that should stay plain never reaches the worker", async () => {
  assert.equal(await highlightLines(["x"], null), null);
  assert.equal(await highlightLines(["x"], "brainfuck"), null);
  assert.equal(await highlightLines(Array(MAX_HIGHLIGHT_LINES + 1).fill("x"), "typescript"), null);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await highlightLines(["x"], "typescript", aborted.signal), null);
  assert.equal(FakeWorker.created.length, 0);
});

test("requests run one at a time, cancelled ones are dropped and results are cached", async () => {
  const first = highlightLines(["let a;"], "typescript");
  const worker = latestWorker();
  const controller = new AbortController();
  const cancelled = highlightLines(["cancel me"], "typescript", controller.signal);
  const third = highlightLines(["fn b() {}"], "rust");
  assert.deepEqual(worker.sent.map(message => message.lines), [["let a;"]]);

  controller.abort();
  assert.equal(await cancelled, null);
  worker.reply(worker.sent[0].id, [[{ text: "let", kind: "keyword" }, { text: " a;", kind: "plain" }]]);
  assert.deepEqual(await first, [[{ text: "let", kind: "keyword" }, { text: " a;", kind: "plain" }]]);
  // The cancelled request was never sent; the next one went out after the first finished.
  assert.deepEqual(worker.sent.map(message => message.lines), [["let a;"], ["fn b() {}"]]);
  assert.equal(worker.sent[1].language, "rust");
  worker.reply(worker.sent[1].id, null);
  assert.equal(await third, null);

  // Same content again is answered from the cache without another round trip.
  assert.deepEqual(await highlightLines(["let a;"], "typescript"), [[{ text: "let", kind: "keyword" }, { text: " a;", kind: "plain" }]]);
  assert.equal(worker.sent.length, 2);
  assert.equal(FakeWorker.created.length, 1);
});

test("an aborted request that is already running resolves null at once", async () => {
  const worker = latestWorker();
  const controller = new AbortController();
  const running = highlightLines(["running"], "typescript", controller.signal);
  const next = highlightLines(["next"], "typescript");
  controller.abort();
  assert.equal(await running, null);
  assert.equal(await settled(next), false);
  // The late answer for the aborted request only unblocks the queue.
  worker.reply(worker.sent.at(-1).id, [[{ text: "running", kind: "plain" }]]);
  worker.reply(worker.sent.at(-1).id, [[{ text: "next", kind: "type" }]]);
  assert.deepEqual(await next, [[{ text: "next", kind: "type" }]]);
});

test("a request past the timeout falls back to plain text and replaces the worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stuck = latestWorker();
  const slow = highlightLines(["slow"], "typescript");
  const after = highlightLines(["after"], "typescript");
  t.mock.timers.tick(HIGHLIGHT_TIMEOUT_MS);
  assert.equal(await slow, null);
  assert.equal(stuck.terminated, true);
  const fresh = latestWorker();
  assert.notEqual(fresh, stuck);
  assert.deepEqual(fresh.sent.map(message => message.lines), [["after"]]);
  // A late answer from the replaced worker is ignored.
  stuck.reply(stuck.sent.at(-1).id, [[{ text: "slow", kind: "keyword" }]]);
  fresh.reply(fresh.sent[0].id, [[{ text: "after", kind: "string" }]]);
  assert.deepEqual(await after, [[{ text: "after", kind: "string" }]]);
});

test("worker crashes fall back to plain text and turn highlighting off after three", async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pending = highlightLines([`crash ${attempt}`], "typescript");
    const worker = latestWorker();
    worker.crash();
    assert.equal(await pending, null);
    assert.equal(worker.terminated, true);
  }
  const created = FakeWorker.created.length;
  assert.equal(await highlightLines(["after crashes"], "typescript"), null);
  assert.equal(FakeWorker.created.length, created);
});
