import assert from "node:assert/strict";
import { MetadataIndexDaemonClient, createDaemonEnvironment, projectMetadataStatus, projectPage, projectSession } from "../indexing/daemon-client.mjs";

export class SearchDaemonClient extends MetadataIndexDaemonClient {
  searchCommits(session, query, { cursor = null, anchorOid = null, pageSize = 200 } = {}, timeoutMs) {
    return this.request("searchCommits", session.repoId, session.generation, {
      query, cursor, anchorOid, pageSize,
    }, timeoutMs);
  }

  beginSearchCommits(session, query, options = {}, timeoutMs = 30_000, onMessage = null) {
    const { cursor = null, anchorOid = null, pageSize = 200 } = options;
    return this.beginRequest("searchCommits", session.repoId, session.generation, {
      query, cursor, anchorOid, pageSize,
    }, timeoutMs, onMessage);
  }

  listSearchIdentities(session, field, text, limit = 50, timeoutMs) {
    return this.request("listSearchIdentities", session.repoId, session.generation, { field, text, limit }, timeoutMs);
  }
}

export { createDaemonEnvironment, projectMetadataStatus, projectPage, projectSession };

export function projectSearchPage(response) {
  const chunks = response.chunks.filter(message => message.data.section === "searchPage");
  assert.ok(chunks.length > 0, `missing searchPage: ${JSON.stringify(response.chunks.map(message => message.data.section))}`);
  assert.equal(response.completion.coverage.complete, true, "search response envelope is complete independently of index coverage");
  const page = chunks[0].data.page;
  const commits = [];
  const pathMatches = [];
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.sequence, index, "search response frames start at sequence zero and increase without gaps");
    const next = chunk.data.page;
    for (const key of ["queryKey", "snapshotKey", "resultVersion", "pageOffset", "matchedCount", "previousCursor", "nextCursor", "anchorFound"]) {
      assert.equal(next[key], page[key], `search metadata ${key} is stable across frames`);
    }
    assert.deepEqual(next.coverage, page.coverage, "search prefix coverage is stable across frames");
    assert.deepEqual(next.index, page.index, "index state is stable across frames");
    commits.push(...next.commits);
    pathMatches.push(...next.pathMatches);
    assert.equal(chunk.coverage.processed, commits.length, "each frame envelope counts summaries cumulatively across the page");
    assert.equal(chunk.coverage.complete, chunk.done, "only the terminal response frame is complete");
    if (!chunk.done) assert.equal(chunk.nextCursor, null, "nonterminal envelopes do not publish the page cursor early");
    else assert.equal(chunk.nextCursor, page.nextCursor, "the terminal envelope publishes the page cursor");
  }
  assert.equal(response.completion.coverage.processed, commits.length, "terminal envelope counts every summary across response frames");
  assert.ok(commits.length <= 500, "merged result page remains within the protocol page-size limit");
  return { ...page, commits, pathMatches, frameCount: chunks.length, done: response.completion.done, completion: response.completion };
}

export function projectSearchIdentities(response) {
  const chunk = response.chunks.find(message => message.data.section === "searchIdentities");
  assert.ok(chunk, `missing searchIdentities: ${JSON.stringify(response.chunks.map(message => message.data.section))}`);
  assert.equal(chunk.sequence, 0, "search identities uses the request's first response sequence");
  assert.equal(response.completion.coverage.complete, true);
  assert.equal(response.completion.coverage.processed, chunk.data.result.identities.length);
  return chunk.data.result;
}
