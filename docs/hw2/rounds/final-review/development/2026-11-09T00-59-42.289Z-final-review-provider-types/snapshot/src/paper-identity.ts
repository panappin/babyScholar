// Browser-safe counterpart to the Worker helper. It deliberately has no
// Worker imports so frontend code never pulls backend runtime modules/bindings.
const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org"]);
const ARXIV_ID = /^(\d{4}\.\d{4,5}|[A-Za-z][A-Za-z.-]*\/\d{7})(v\d+)?$/u;

export function canonicalArxivId(value: string): string | undefined {
  return ARXIV_ID.exec(value)?.[1];
}

export function arxivSourceIdentity(value: string): string {
  // API values are validated by the Worker. Keep an invalid value distinct
  // rather than guessing an identity from a title or URL in the browser.
  return `arxiv:${canonicalArxivId(value) ?? `invalid:${value}`}`;
}

export function safeArxivPaperLink(value: string | null, arxivId: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !ARXIV_HOSTS.has(url.hostname.toLowerCase())
    || url.port
    || url.username
    || url.password
    || !url.pathname.startsWith("/abs/")
  ) {
    return null;
  }
  const match = ARXIV_ID.exec(url.pathname.slice("/abs/".length));
  const expected = canonicalArxivId(arxivId);
  if (!match || !expected || match[1] !== expected) return null;
  return `https://arxiv.org/abs/${match[1]}${match[2] ?? ""}`;
}
