import { HistoryDaemonClient, createDaemonEnvironment, projectPage, projectSession } from "../history/daemon-client.mjs";

/** Navigation tests deliberately reuse the history JSONL transport and page projection. */
export class NavigationDaemonClient extends HistoryDaemonClient {
  getNavigation(session) {
    return this.request("getRepositoryNavigation", session.repoId, session.generation, {});
  }

  selectScope(session, scope, pageSize = 200) {
    return this.request("selectRepositoryScope", session.repoId, session.generation, { scope, pageSize });
  }

  beginSelectScope(session, scope, pageSize = 200) {
    return this.beginRequest("selectRepositoryScope", session.repoId, session.generation, { scope, pageSize });
  }

  mergeStatus(session, refNames) {
    return this.request("refMergeStatus", session.repoId, session.generation, { refNames });
  }

}

export { createDaemonEnvironment, projectPage, projectSession };

export function projectNavigation(response) {
  const chunk = response.chunks.find(message => message.data.section === "repositoryNavigation");
  if (!chunk) throw new Error(`Missing repositoryNavigation response: ${JSON.stringify(response.chunks.map(message => message.data.section))}`);
  const navigation = chunk.data.navigation;
  if (!response.completion.coverage.complete ||
    response.completion.coverage.processed !== navigation.refs.length + navigation.worktrees.length) {
    throw new Error("repositoryNavigation coverage does not match refs + worktrees");
  }
  return navigation;
}

export function projectMergeStatus(response) {
  const chunk = response.chunks.find(message => message.data.section === "refMergeStatus");
  if (!chunk) throw new Error(`Missing refMergeStatus response: ${JSON.stringify(response.chunks.map(message => message.data.section))}`);
  const result = chunk.data.result;
  if (!response.completion.coverage.complete || response.completion.coverage.processed !== result.statuses.length) {
    throw new Error("refMergeStatus coverage does not match status count");
  }
  return result;
}

export function projectRefreshed(response) {
  const session = projectSession(response);
  const page = projectPage(response);
  if (!session) throw new Error("Scope result did not include a repositorySession chunk");
  return { session, page };
}
