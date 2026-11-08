import { checkProtocol } from "./protocol-lib.mjs";

try {
  await checkProtocol();
  process.stdout.write("Protocol schemas, types, and standalone validators are up to date.\n");
} catch (error) {
  process.stderr.write(`Protocol check failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
}
