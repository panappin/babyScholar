const ARXIV_LINK_HOSTS = new Set(["arxiv.org", "www.arxiv.org"]);

interface ParsedArxivIdentifier {
  base: string;
  versioned: string;
}

export function parseArxivId(candidate: string): ParsedArxivIdentifier | undefined {
  const match = /^(\d{4}\.\d{4,5}|[A-Za-z][A-Za-z.-]*\/\d{7})(v\d+)?$/u.exec(candidate);
  if (!match) return undefined;
  return { base: match[1], versioned: `${match[1]}${match[2] ?? ""}` };
}

export function arxivIdentifier(value: string | undefined): ParsedArxivIdentifier | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!ARXIV_LINK_HOSTS.has(url.hostname.toLowerCase()) || !url.pathname.startsWith("/abs/")) return undefined;
    return parseArxivId(url.pathname.slice("/abs/".length));
  } catch {
    return undefined;
  }
}

// Shared with the existing search adapter: only exact arXiv hosts, HTTP(S),
// no credentials/nonstandard port, supported IDs, and canonical HTTPS output.
export function canonicalArxivLink(value: string | undefined, kind: "abstract" | "pdf"): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !ARXIV_LINK_HOSTS.has(url.hostname.toLowerCase())
    || url.port
    || url.username
    || url.password
  ) {
    return null;
  }
  const prefix = kind === "abstract" ? "/abs/" : "/pdf/";
  if (!url.pathname.startsWith(prefix)) return null;
  const withoutPrefix = url.pathname.slice(prefix.length);
  const hasPdfExtension = kind === "pdf" && withoutPrefix.endsWith(".pdf");
  const candidate = hasPdfExtension ? withoutPrefix.slice(0, -4) : withoutPrefix;
  const identifier = parseArxivId(candidate);
  if (!identifier) return null;
  return `https://arxiv.org${prefix}${identifier.versioned}${hasPdfExtension ? ".pdf" : ""}`;
}
