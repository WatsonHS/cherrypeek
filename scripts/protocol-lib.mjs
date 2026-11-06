import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const protocolKinds = [
  { key: "core-ready", name: "CoreReady" },
  { key: "client-message", name: "ClientMessage" },
  { key: "server-message", name: "ServerMessage" },
];
const schemaPath = key => resolve(root, `packages/protocol/schema/${key}.schema.json`);
const typePath = key => resolve(root, `packages/protocol/src/generated/${key}.ts`);

export async function generateProtocol({ write = true, tempDir } = {}) {
  const { stdout } = await execFileAsync("cargo", ["run", "-q", "--locked", "-p", "commitscope-core", "--bin", "export-protocol", "--", "--all"], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  const schemas = JSON.parse(stdout);
  const generated = new Map();
  for (const { key, name } of protocolKinds) {
    const schema = schemas[key];
    if (!schema) throw new Error(`Rust exporter omitted ${key} schema`);
    if (schema.$schema !== "http://json-schema.org/draft-07/schema#") {
      throw new Error(`Expected draft-07 JSON Schema for ${key}, received ${schema.$schema ?? "no dialect"}`);
    }
    let typeSource = await compile(schema, name, {
      bannerComment: "/* Generated from Rust protocol types. Do not edit by hand. */",
      style: { semi: true, singleQuote: false },
      additionalProperties: false,
    });
    const outputSchema = tempDir ? resolve(tempDir, `${key}.schema.json`) : schemaPath(key);
    const outputType = tempDir ? resolve(tempDir, `${key}.ts`) : typePath(key);
    generated.set(key, { schema, typeSource, outputSchema, outputType });
    if (write) {
      await mkdir(dirname(outputSchema), { recursive: true });
      await mkdir(dirname(outputType), { recursive: true });
      await writeFile(outputSchema, `${JSON.stringify(schema, null, 2)}\n`);
      await writeFile(outputType, typeSource);
    }
  }
  return generated;
}

export async function checkProtocol() {
  const generated = await generateProtocol({ write: false });
  for (const { key } of protocolKinds) {
    const { schema, typeSource } = generated.get(key);
    const actualSchema = await readFile(schemaPath(key), "utf8");
    const actualType = await readFile(typePath(key), "utf8");
    const expectedSchema = `${JSON.stringify(schema, null, 2)}\n`;
    if (actualSchema !== expectedSchema) throw new Error(`Generated ${key} schema differs; run pnpm protocol:generate`);
    if (actualType !== typeSource) throw new Error(`Generated ${key} TypeScript differs; run pnpm protocol:generate`);
  }
}
