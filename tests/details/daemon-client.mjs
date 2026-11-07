import assert from "node:assert/strict";
import { NavigationDaemonClient, createDaemonEnvironment, projectRefreshed, projectSession } from "../navigation/daemon-client.mjs";

export class CommitDetailsDaemonClient extends NavigationDaemonClient {
  async start(timeoutMs) {
    const core = await super.start(timeoutMs);
    if (!core.capabilities.includes("commitDetails")) throw new Error("Daemon does not advertise commitDetails");
    return core;
  }

  getCommit(session, oid, timeoutMs) {
    return this.request("getCommit", session.repoId, session.generation, { oid }, timeoutMs);
  }

  beginGetCommit(session, oid, timeoutMs, onMessage) {
    return this.beginRequest("getCommit", session.repoId, session.generation, { oid }, timeoutMs, onMessage);
  }

  listChangedFiles(session, oid, parentIndex, { offset = 0, pageSize = 200 } = {}, timeoutMs) {
    return this.request("listChangedFiles", session.repoId, session.generation, { oid, parentIndex, offset, pageSize }, timeoutMs);
  }

  beginListChangedFiles(session, oid, parentIndex, { offset = 0, pageSize = 200 } = {}, timeoutMs, onMessage) {
    return this.beginRequest("listChangedFiles", session.repoId, session.generation, { oid, parentIndex, offset, pageSize }, timeoutMs, onMessage);
  }

  readMergeCommits(session, oid, parentIndex, { offset = 0, pageSize = 200 } = {}, timeoutMs) {
    return this.request("readMergeCommits", session.repoId, session.generation, { oid, parentIndex, offset, pageSize }, timeoutMs);
  }

  branchesContaining(session, oid, timeoutMs) {
    return this.request("branchesContaining", session.repoId, session.generation, { oid }, timeoutMs);
  }
}

export { createDaemonEnvironment, projectRefreshed, projectSession };

function project(response, section, valueKey) {
  const matches = response.chunks.filter(chunk => chunk.data.section === section);
  assert.equal(matches.length, 1, `expected one ${section} response section, got ${JSON.stringify(response.chunks.map(chunk => chunk.data.section))}`);
  const chunk = matches[0];
  assert.equal(chunk.sequence, 0, "detail methods return one sequence-zero terminal frame");
  assert.equal(chunk.done, true, "detail methods return only a complete terminal frame");
  assert.equal(chunk.coverage.complete, true, "coverage.complete applies to this single bounded request");
  assert.equal(response.completion, chunk);
  return chunk.data[valueKey];
}

export function projectCommitDetails(response) {
  return project(response, "commitDetails", "details");
}

export function projectChangedFiles(response) {
  return project(response, "changedFiles", "page");
}

export function projectMergeCommits(response) {
  return project(response, "mergeCommits", "page");
}

export function projectBranchesContaining(response) {
  return project(response, "branchesContaining", "result");
}
