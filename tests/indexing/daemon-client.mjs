import assert from "node:assert/strict";
import { HistoryDaemonClient, createDaemonEnvironment, projectPage, projectSession } from "../history/daemon-client.mjs";

export class MetadataIndexDaemonClient extends HistoryDaemonClient {
  getMetadataIndexStatus(session) {
    return this.request("getMetadataIndexStatus", session.repoId, session.generation, {});
  }

  controlMetadataIndex(session, action) {
    return this.request("controlMetadataIndex", session.repoId, session.generation, { action });
  }

  selectScope(session, scope, pageSize = 32) {
    return this.request("selectRepositoryScope", session.repoId, session.generation, { scope, pageSize });
  }
}

export { createDaemonEnvironment, projectPage, projectSession };

export function projectMetadataStatus(response) {
  const chunk = response.chunks.find(message => message.data.section === "metadataIndex");
  assert.ok(chunk, `missing metadataIndex response section: ${JSON.stringify(response.chunks.map(message => message.data.section))}`);
  assert.equal(response.completion.coverage.complete, true, "the response envelope must be complete independently of index coverage");
  assert.equal(response.completion.coverage.processed, 1, "one status object is returned by the metadataIndex envelope");
  assert.ok(chunk.data.status, "metadataIndex status is present");
  assert.ok(["idle", "queued", "running", "paused", "cancelled", "complete", "quotaLimited", "unavailable", "failed"].includes(chunk.data.status.state));
  assert.equal(typeof chunk.data.status.coverage.processed, "number");
  assert.equal(typeof chunk.data.status.coverage.complete, "boolean");
  assert.equal(chunk.data.status.coverage.complete, chunk.data.status.state === "complete",
    "only the complete index state may claim complete index coverage");
  return chunk.data.status;
}

