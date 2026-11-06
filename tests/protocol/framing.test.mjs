import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { loadBuilt } from "./test-utils.mjs";

const { JsonLineFramer } = await loadBuilt("json-line-framer");

test("frames combined lines and UTF-8 split one byte at a time, including CRLF", () => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  new JsonLineFramer(input, line => lines.push(line), error => errors.push(error));
  const wire = Buffer.from('{"text":"仓储✓"}\r\n{"n":2}\n', "utf8");
  for (const byte of wire) input.write(Buffer.from([byte]));
  input.end();
  assert.deepEqual(lines, ['{"text":"仓储✓"}', '{"n":2}']);
  assert.deepEqual(errors, []);
});

test("invalid UTF-8 is fatal and later lines in that same chunk are ignored", () => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  new JsonLineFramer(input, line => lines.push(line), error => errors.push(error));
  input.write(Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from('{"type":"hello"}\n')]));
  assert.deepEqual(lines, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid UTF-8/);
});

test("rejects oversized lines before a newline and truncated EOF", async () => {
  const tooLongInput = new PassThrough();
  const tooLongErrors = [];
  new JsonLineFramer(tooLongInput, () => assert.fail("oversized frame must not be delivered"), error => tooLongErrors.push(error), 8);
  tooLongInput.write(Buffer.alloc(10, 0x61));
  assert.equal(tooLongErrors.length, 1);
  assert.match(tooLongErrors[0].message, /exceeds 8 byte limit/);

  const truncatedInput = new PassThrough();
  const truncatedErrors = [];
  new JsonLineFramer(truncatedInput, () => assert.fail("truncated frame must not be delivered"), error => truncatedErrors.push(error));
  truncatedInput.write(Buffer.from('{"partial":'));
  const ended = once(truncatedInput, "end");
  truncatedInput.end();
  await ended;
  assert.equal(truncatedErrors.length, 1);
  assert.match(truncatedErrors[0].message, /incomplete JSON line/);
});
