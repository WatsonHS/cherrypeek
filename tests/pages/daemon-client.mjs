import assert from "node:assert/strict";
import { NavigationDaemonClient, createDaemonEnvironment, projectSession } from "../navigation/daemon-client.mjs";

const PAGE_CAPABILITIES = ["workspaceStatus", "fileBrowsing", "diffFullContext", "blame"];

export class PagesDaemonClient extends NavigationDaemonClient {
  async start(timeoutMs) {
    const core = await super.start(timeoutMs);
    for (const capability of PAGE_CAPABILITIES) {
      if (!core.capabilities.includes(capability)) throw new Error(`Daemon does not advertise ${capability}`);
    }
    return core;
  }

  call(method, params, timeoutMs) {
    return this.request(method, this.session.repoId, this.session.generation, params, timeoutMs);
  }

  begin(method, params, timeoutMs, onMessage) {
    return this.beginRequest(method, this.session.repoId, this.session.generation, params, timeoutMs, onMessage);
  }

  async workspaceStatus(maxEntries = 2000) {
    return single(await this.call("readWorkspaceStatus", { maxEntries }), "workspaceStatus", "status");
  }

  async workspaceDiff(side, pathHex, oldPathHex = null, fullFile = false) {
    const params = { side, pathHex, oldPathHex };
    if (fullFile) params.fullFile = true;
    return single(await this.call("readWorkspaceDiff", params), "workspaceDiff", "diff");
  }

  async workspaceFile(pathHex, maxLines) {
    return single(await this.call("readWorkspaceFile", { pathHex, maxLines }), "workspaceFile", "file");
  }

  async listTree(commit, pathHex, offset = 0, limit = 500) {
    return single(await this.call("listTree", { commit, pathHex, offset, limit }), "treePage", "page");
  }

  async fileContent(commit, pathHex, maxLines = 5000) {
    return single(await this.call("readFileContent", { commit, pathHex, maxLines }), "fileContent", "content");
  }

  async fileHistory(commit, pathHex, { kind = "file", message = "", cursor = null, pageSize = 200 } = {}) {
    return single(await this.call("readFileHistory", { commit, pathHex, kind, message, cursor, pageSize }), "fileHistory", "page");
  }

  async fileChange(oid, parentIndex, pathHex, oldPathHex = null, fullFile = false) {
    const params = { oid, parentIndex, pathHex, oldPathHex };
    if (fullFile) params.fullFile = true;
    return single(await this.call("readFileChange", params), "fileDiff", "diff");
  }

  async listPathChanges(oid, parentIndex, pathHex, offset = 0, pageSize = 200) {
    return single(await this.call("listPathChanges", { oid, parentIndex, pathHex, offset, pageSize }), "changedFiles", "page");
  }

  async blame(commit, pathHex) {
    return projectBlame(await this.call("readBlame", { commit, pathHex }, 60_000));
  }
}

export { createDaemonEnvironment, projectSession };

/** Single-section reads answer with one complete, sequence-zero frame. */
function single(response, section, key) {
  assert.equal(response.chunks.length, 1, `${section} answers with one frame`);
  const chunk = response.chunks[0];
  assert.equal(chunk.data.section, section);
  assert.equal(chunk.sequence, 0);
  assert.equal(chunk.done, true);
  assert.equal(chunk.coverage.complete, true);
  assert.equal(chunk.coverage.processed, 1);
  return chunk.data[key];
}

/** Blame streams chunks; every chunk but the last is incomplete and the block count only grows. */
export function projectBlame(response) {
  const chunks = response.chunks;
  assert.ok(chunks.length >= 1);
  let processed = 0;
  const blocks = [];
  const commits = new Map();
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.data.section, "blameChunk");
    assert.equal(chunk.sequence, index, "blame chunks arrive in sequence");
    const last = index === chunks.length - 1;
    assert.equal(chunk.done, last, "only the last blame chunk is done");
    assert.equal(chunk.coverage.complete, last);
    const data = chunk.data.chunk;
    assert.equal(data.totalLines, chunks[0].data.chunk.totalLines, "totalLines is the same in every chunk");
    blocks.push(...data.blocks);
    for (const commit of data.commits) {
      assert.equal(commits.has(commit.oid), false, `commit ${commit.oid} is sent once`);
      commits.set(commit.oid, commit);
    }
    assert.ok(chunk.coverage.processed >= processed, "processed never goes back");
    processed = chunk.coverage.processed;
  });
  assert.equal(processed, blocks.length, "the final processed count equals the blocks sent");
  const first = chunks[0].data.chunk;
  return { commit: first.commit, path: first.path, totalLines: first.totalLines, blocks, commits, chunkCount: chunks.length };
}
