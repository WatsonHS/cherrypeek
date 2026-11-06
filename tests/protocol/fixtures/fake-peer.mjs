import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "normal";
const ready = {
  protocolVersion: 1,
  coreVersion: "0.1.0-test",
  pid: process.pid,
  git: { available: true, version: "git version fixture", error: null },
  capabilities: ["getRuntimeInfo"],
};
let pendingInput = Buffer.alloc(0);
let requestsSeen = 0;

function wire(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function hello(version = 1) { return wire({ type: "hello", core: { ...ready, protocolVersion: version } }); }
function chunk(request, sequence, done) {
  return {
    type: "response",
    requestId: request.requestId,
    repoId: request.repoId ?? null,
    generation: request.generation ?? null,
    sequence,
    done,
    coverage: { complete: done, processed: sequence + 1 },
    nextCursor: null,
    data: sequence === 0
      ? { section: "core", coreVersion: ready.coreVersion, pid: process.pid }
      : { section: "git", git: ready.git },
  };
}
function respond(request, sequenceStart = 0, context = {}) {
  process.stdout.write(wire({ ...chunk(request, sequenceStart, false), ...context }));
  process.stdout.write(wire({ ...chunk(request, sequenceStart + 1, true), ...context }));
}

function handle(message) {
  if (message.type === "hello") {
    if (mode === "no-hello") return;
    if (mode === "mismatch-version") process.stdout.write(hello(99));
    else if (mode === "duplicate-hello") process.stdout.write(Buffer.concat([hello(), hello()]));
    else if (mode === "split-handshake") {
      const frame = hello();
      let index = 0;
      const writeNext = () => {
        if (index >= frame.length) return;
        process.stdout.write(frame.subarray(index, index + 1));
        index += 1;
        setImmediate(writeNext);
      };
      writeNext();
    } else process.stdout.write(hello());
    return;
  }
  if (message.type === "cancel") {
    if ((mode === "late-cancel" || mode === "context") && globalThis.lastRequest) {
      const request = globalThis.lastRequest;
      setTimeout(() => respond(request), 80);
    }
    return;
  }
  if (message.type !== "request") return;
  requestsSeen += 1;
  globalThis.lastRequest = message;
  if (process.env.COMMITSCOPE_PEER_COUNT_FILE) writeFileSync(process.env.COMMITSCOPE_PEER_COUNT_FILE, String(requestsSeen));
  if (mode === "exit-on-request") process.exit(23);
  if (mode === "stdout-close") {
    process.stdout.end();
    setInterval(() => undefined, 1000);
    return;
  }
  if (mode === "stall") return;
  if (mode === "invalid-utf8") {
    process.stdout.write(Buffer.concat([Buffer.from([0xff, 0x0a]), hello()]));
    return;
  }
  if (mode === "oversized") {
    process.stdout.write(Buffer.alloc(1024 * 1024 + 2, 0x61));
    return;
  }
  if (mode === "bad-json") {
    process.stdout.write(Buffer.from('{"type":}\n'));
    return;
  }
  if (mode === "wrong-sequence") {
    process.stdout.write(wire(chunk(message, 1, true)));
    return;
  }
  if (mode === "wrong-context") {
    process.stdout.write(wire({ ...chunk(message, 0, true), repoId: "other" }));
    return;
  }
  if (mode === "late-cancel" && requestsSeen === 1) return;
  if (mode === "context" && requestsSeen === 1) {
    setTimeout(() => respond(message), 60);
    return;
  }
  if (mode === "context" && requestsSeen === 2) return;
  if (mode === "timeout-late" && requestsSeen === 1) {
    setTimeout(() => respond(message), 120);
    return;
  }
  if (mode === "callback") {
    respond(message);
    return;
  }
  respond(message);
}

process.stdin.on("data", chunk => {
  pendingInput = Buffer.concat([pendingInput, chunk]);
  while (true) {
    const newline = pendingInput.indexOf(0x0a);
    if (newline < 0) break;
    const line = pendingInput.subarray(0, newline).toString("utf8");
    pendingInput = pendingInput.subarray(newline + 1);
    try { handle(JSON.parse(line)); } catch { process.exitCode = 2; }
  }
});
process.stdin.on("end", () => process.exit());
