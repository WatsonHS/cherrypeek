import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export const context = { repoId: null, generation: null };
export const daemonPath = process.env.COMMITSCOPE_DAEMON_PATH;

export async function loadBuilt(name) {
  return import(pathToFileURL(join(process.env.COMMITSCOPE_PROTOCOL_BUILD_DIR, `${name}.mjs`)));
}

export async function waitFor(predicate, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  }
  assert.fail(`condition not met in ${timeoutMs}ms`);
}

export async function waitForProcessExit(pid, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await delay(20);
  }
  assert.fail(`process ${pid} did not exit`);
}
