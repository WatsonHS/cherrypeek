/**
 * P5-04. Builds the web address of a commit or branch from the remotes of the navigation snapshot. The renderer
 * never supplies a URL: it names a commit or a ref, and only an `https://` address the core derived from a
 * configured remote can come out of here.
 */

export interface RemoteWebInfo {
  name: string;
  webUrl?: string | null;
}

export type RemotePageTarget = { commit: string } | { branch: string };

/** `https://host[:port]/path` without trailing slash, or null when the address is not safe to open. */
export function normalizeWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (/[\s\\\u0000-\u001f\u007f?#]/u.test(value) || !/^https:\/\/[^/]/u.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const path = url.pathname.replace(/\/+$/u, "");
  if (path === "") return null;
  return `https://${url.host}${path}`;
}

/** The remote named `origin` when it has a usable address, else the first remote that has one. */
export function pickWebUrl(remotes: readonly RemoteWebInfo[]): string | null {
  const origin = remotes.find(remote => remote.name === "origin");
  const preferred = origin ? normalizeWebUrl(origin.webUrl) : null;
  if (preferred) return preferred;
  for (const remote of remotes) {
    const url = normalizeWebUrl(remote.webUrl);
    if (url) return url;
  }
  return null;
}

function encodeRefPath(name: string): string | null {
  const segments = name.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/u.test(segment))) return null;
  return segments.map(encodeURIComponent).join("/");
}

/**
 * `refs/heads/<name>` opens on the default remote. `refs/remotes/<remote>/<name>` opens on that remote's own page,
 * and yields null when that remote has no usable address rather than guessing another repository.
 */
export function buildRemotePageUrl(remotes: readonly RemoteWebInfo[], target: RemotePageTarget): string | null {
  if ("commit" in target) {
    if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(target.commit)) return null;
    const base = pickWebUrl(remotes);
    return base ? `${base}/commit/${target.commit.toLowerCase()}` : null;
  }
  const ref = target.branch;
  if (typeof ref !== "string" || ref.length > 16 * 1024) return null;
  if (ref.startsWith("refs/heads/")) {
    const base = pickWebUrl(remotes);
    const path = encodeRefPath(ref.slice("refs/heads/".length));
    return base && path ? `${base}/tree/${path}` : null;
  }
  if (ref.startsWith("refs/remotes/")) {
    const rest = ref.slice("refs/remotes/".length);
    // Remote names may contain "/", so prefer the longest configured remote that prefixes the ref.
    const owner = [...remotes].filter(remote => rest.startsWith(`${remote.name}/`)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!owner) return null;
    const base = normalizeWebUrl(owner.webUrl);
    const path = encodeRefPath(rest.slice(owner.name.length + 1));
    return base && path ? `${base}/tree/${path}` : null;
  }
  return null;
}
