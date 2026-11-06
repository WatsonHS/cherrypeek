import { generateProtocol } from "./protocol-lib.mjs";

try {
  await generateProtocol();
  process.stdout.write("Generated protocol schemas and TypeScript types.\n");
} catch (error) {
  process.stderr.write(`Protocol generation failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
