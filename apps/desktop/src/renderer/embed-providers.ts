/** Safe remote presentation descriptors.  They contain no HTML, iframe, script,
 * style, or callback fields; the renderer can only show a card and ask the
 * bounded main-process open-external command to handle its URL. */

export type EmbedDescriptor =
  | { readonly kind: "generic-web"; readonly url: string; readonly hostname: string }
  | { readonly kind: "youtube"; readonly url: string; readonly videoId: string }
  | { readonly kind: "sns"; readonly url: string; readonly provider: "x"; readonly statusId: string };

const CONTROL = /[\u0000-\u001F\u007F]/u;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

export function parseSafeExternalUrl(value: string): URL | null {
  if (value.length === 0 || CONTROL.test(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username.length > 0 || url.password.length > 0) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function youtubeId(url: URL): string | null {
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const candidate = url.hostname.toLowerCase() === "youtu.be"
    ? url.pathname.split("/").filter(Boolean)[0]
    : url.pathname === "/watch" ? url.searchParams.get("v")
      : /^\/(?:embed|shorts)\/([^/]+)$/u.exec(url.pathname)?.[1] ?? null;
  return candidate !== null && /^[A-Za-z0-9_-]{11}$/u.test(candidate) ? candidate : null;
}

function xStatusId(url: URL): string | null {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/[A-Za-z0-9_]+\/status\/(\d+)(?:\/)?$/u.exec(url.pathname);
  return match?.[1] ?? null;
}

/** Provider recognition is deterministic and network-free. */
export function describeEmbed(value: string): EmbedDescriptor | null {
  const url = parseSafeExternalUrl(value);
  if (url === null) return null;
  const youtube = youtubeId(url);
  if (youtube !== null) return Object.freeze({ kind: "youtube", url: url.href, videoId: youtube });
  const status = xStatusId(url);
  if (status !== null) return Object.freeze({ kind: "sns", url: url.href, provider: "x", statusId: status });
  return Object.freeze({ kind: "generic-web", url: url.href, hostname: url.hostname });
}
