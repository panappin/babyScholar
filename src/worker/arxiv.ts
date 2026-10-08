import { IntegrationError } from "./integration-errors.js";
import type {
  PaperSearchErrorPayload,
  PaperSearchFailureKind,
  PaperSearchResponse,
  PaperSearchResult,
} from "./paper-search-types.js";

export type {
  PaperSearchErrorPayload,
  PaperSearchFailureKind,
  PaperSearchFailureResponse,
  PaperSearchResponse,
  PaperSearchResult,
} from "./paper-search-types.js";

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const ARXIV_PROBE_QUERY = "all:electron";
const ARXIV_TIMEOUT_MS = 10_000;
const ARXIV_MAX_RESPONSE_BYTES = 1_000_000;
const ARXIV_REQUEST_SPACING_MS = 3_000;
const ARXIV_CACHE_TTL_MS = 5 * 60_000;
const ARXIV_MAX_CACHE_ENTRIES = 20;
const ARXIV_LINK_HOSTS = new Set(["arxiv.org", "www.arxiv.org"]);

type FetchImplementation = typeof fetch;

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string[];
}

export interface ArxivProbeResult {
  provider: "arxiv";
  query: string;
  title: string;
  link: string;
}

export class PaperSearchError extends Error {
  constructor(readonly kind: PaperSearchFailureKind, message: string) {
    super(message);
    this.name = "PaperSearchError";
  }
}

export function publicPaperSearchError(error: unknown): PaperSearchErrorPayload {
  if (error instanceof PaperSearchError) {
    return { kind: error.kind, message: error.message };
  }
  return { kind: "upstream" as const, message: "The paper search could not be completed." };
}

export function paperSearchFailureStatus(error: unknown) {
  if (error instanceof PaperSearchError && error.kind === "invalid_query") return 400;
  if (error instanceof PaperSearchError && error.kind === "timeout") return 504;
  return 502;
}

export interface ArxivSearchOptions {
  fetchImplementation?: FetchImplementation;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  requestSpacingMs?: number;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

export interface ArxivSearchService {
  search(query: string | null): Promise<PaperSearchResponse>;
}

interface NormalizedSearchQuery {
  query: string;
  expression: string;
}

interface ParsedArxivIdentifier {
  base: string;
  versioned: string;
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function localName(name: string) {
  return name.slice(name.lastIndexOf(":") + 1);
}

function decodeXml(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (_, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const point = Number.parseInt(entity.slice(2), 16);
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) {
        throw new IntegrationError("malformed_response", "arXiv XML contains an invalid character entity.");
      }
      return String.fromCodePoint(point);
    }
    if (entity.startsWith("#")) {
      const point = Number.parseInt(entity.slice(1), 10);
      if (!Number.isInteger(point) || point < 0 || point > 0x10ffff) {
        throw new IntegrationError("malformed_response", "arXiv XML contains an invalid character entity.");
      }
      return String.fromCodePoint(point);
    }
    return named[entity.toLowerCase()] ?? "";
  });
}

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of source.matchAll(matcher)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

// This deliberately small, non-DOM parser accepts only the Atom fields this
// Worker reads. It rejects declarations and malformed nesting rather than
// treating upstream XML as HTML, so it remains compatible with Workers.
function parseXmlDocument(xml: string): XmlNode {
  if (xml.length === 0 || xml.includes("<!DOCTYPE") || xml.includes("<!ENTITY")) {
    throw new IntegrationError("malformed_response", "arXiv did not return a supported XML document.");
  }

  const rootNodes: XmlNode[] = [];
  const stack: XmlNode[] = [];
  const token = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/[^>]+>|<[^>]+>|[^<]+/gu;

  for (const match of xml.matchAll(token)) {
    const value = match[0];
    if (value.startsWith("<!--") || value.startsWith("<?")) continue;
    if (value.startsWith("<![CDATA[")) {
      if (!stack.length) throw new IntegrationError("malformed_response", "arXiv XML has text outside its root.");
      stack.at(-1)?.text.push(value.slice(9, -3));
      continue;
    }
    if (value.startsWith("</")) {
      const name = value.slice(2, -1).trim();
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new IntegrationError("malformed_response", "arXiv XML has invalid element nesting.");
      }
      continue;
    }
    if (value.startsWith("<")) {
      if (value.startsWith("<!")) {
        throw new IntegrationError("malformed_response", "arXiv XML contains an unsupported declaration.");
      }
      const selfClosing = /\/>$/u.test(value);
      const body = value.slice(1, selfClosing ? -2 : -1).trim();
      const name = /^([A-Za-z_][\w:.-]*)/u.exec(body)?.[1];
      if (!name) throw new IntegrationError("malformed_response", "arXiv XML contains an invalid element.");
      const node: XmlNode = { name, attributes: parseAttributes(body.slice(name.length)), children: [], text: [] };
      if (stack.length) stack.at(-1)?.children.push(node);
      else rootNodes.push(node);
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (value.trim()) {
      if (!stack.length) throw new IntegrationError("malformed_response", "arXiv XML has text outside its root.");
      stack.at(-1)?.text.push(decodeXml(value));
    }
  }

  if (stack.length || rootNodes.length !== 1) {
    throw new IntegrationError("malformed_response", "arXiv did not return a complete XML document.");
  }
  return rootNodes[0];
}

function child(node: XmlNode, name: string) {
  return node.children.find((item) => localName(item.name) === name);
}

function children(node: XmlNode, name: string) {
  return node.children.filter((item) => localName(item.name) === name);
}

function nodeText(node: XmlNode | undefined): string | undefined {
  if (!node) return undefined;
  const value = [...node.text, ...node.children.map((item) => nodeText(item) ?? "")].join("");
  return normalizeWhitespace(value) || undefined;
}

function arxivIdentifier(value: string | undefined): ParsedArxivIdentifier | undefined {
  if (!value) return undefined;
  let candidate = value;
  try {
    const url = new URL(value);
    if (!ARXIV_LINK_HOSTS.has(url.hostname.toLowerCase()) || !url.pathname.startsWith("/abs/")) return undefined;
    candidate = url.pathname.slice("/abs/".length);
  } catch {
    return undefined;
  }
  const match = /^(\d{4}\.\d{4,5}|[A-Za-z][A-Za-z.-]*\/\d{7})(v\d+)?$/u.exec(candidate);
  if (!match) return undefined;
  return { base: match[1], versioned: `${match[1]}${match[2] ?? ""}` };
}

function canonicalArxivLink(value: string | undefined, kind: "abstract" | "pdf"): string | null {
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
  const identifier = arxivIdentifier(`https://arxiv.org/abs/${candidate}`);
  if (!identifier) return null;
  return `https://arxiv.org${prefix}${identifier.versioned}${hasPdfExtension ? ".pdf" : ""}`;
}

function parsePaper(entry: XmlNode): PaperSearchResult {
  const identifier = arxivIdentifier(nodeText(child(entry, "id")));
  if (!identifier) {
    throw new IntegrationError("malformed_response", "arXiv Atom feed contained a paper without a supported identifier.");
  }
  const links = children(entry, "link");
  const alternate = links.find((link) => {
    const rel = link.attributes.rel?.toLowerCase();
    return !rel || rel === "alternate";
  });
  const pdf = links.find((link) => {
    const rel = link.attributes.rel?.toLowerCase();
    return (rel === "related" && link.attributes.title?.toLowerCase() === "pdf")
      || link.attributes.href?.includes("/pdf/");
  });
  const published = nodeText(child(entry, "published"));
  const yearMatch = published ? /^(\d{4})-/u.exec(published) : undefined;

  return {
    id: identifier.base,
    title: nodeText(child(entry, "title")) ?? "",
    authors: children(entry, "author").map((author) => nodeText(child(author, "name"))).filter((name): name is string => Boolean(name)),
    year: yearMatch ? Number(yearMatch[1]) : null,
    abstract: nodeText(child(entry, "summary")) ?? "",
    url: canonicalArxivLink(alternate?.attributes.href, "abstract"),
    pdfUrl: canonicalArxivLink(pdf?.attributes.href, "pdf"),
  };
}

function parseArxivFeed(xml: string): PaperSearchResult[] {
  const feed = parseXmlDocument(xml);
  if (localName(feed.name) !== "feed") {
    throw new IntegrationError("malformed_response", "arXiv did not return an Atom feed.");
  }

  const entries = children(feed, "entry");
  const errorEntry = entries.find((entry) => nodeText(child(entry, "title"))?.toLowerCase() === "error");
  if (errorEntry) {
    throw new IntegrationError("upstream_error", "arXiv returned an error feed.");
  }
  return entries.map(parsePaper);
}

function normalizeSearchQuery(value: string | null): NormalizedSearchQuery {
  if (value === null) {
    throw new PaperSearchError("invalid_query", "Query parameter q is required.");
  }
  // NFC retains Unicode letters and numbers while making equivalent text forms consistent for cache keys.
  const query = normalizeWhitespace(value.normalize("NFC"));
  if (!query) throw new PaperSearchError("invalid_query", "Query parameter q must not be blank.");
  if ([...query].length > 200) {
    throw new PaperSearchError("invalid_query", "Query parameter q must be 200 characters or fewer.");
  }

  // This endpoint accepts plain text only. Keeping Unicode letters/numbers and generating every field/operator
  // server-side makes quotes, field prefixes, boolean operators, wildcards, and punctuation non-executable input.
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) {
    throw new PaperSearchError("invalid_query", "Query parameter q must contain letters or numbers.");
  }
  return { query, expression: terms.map((term) => `all:"${term}"`).join(" AND ") };
}

function clonePapers(papers: PaperSearchResult[]) {
  return papers.map((paper) => ({ ...paper, authors: [...paper.authors] }));
}

function arxivSearchUrl(expression: string, maximumResults = 10) {
  const url = new URL(ARXIV_ENDPOINT);
  url.searchParams.set("search_query", expression);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(maximumResults));
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");
  return url;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function readResponseBody(response: Response, maximumBytes: number, signal: AbortSignal) {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    throw new IntegrationError("malformed_response", "arXiv response exceeded the permitted size.");
  }
  if (!response.body) {
    const text = await abortable(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new IntegrationError("malformed_response", "arXiv response exceeded the permitted size.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new IntegrationError("malformed_response", "arXiv response exceeded the permitted size.");
      }
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* The stream can already be cancelled. */ }
  }
}

async function requestArxivFeed(
  url: URL,
  fetchImplementation: FetchImplementation,
  timeoutMs: number,
  maximumBytes: number,
): Promise<PaperSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new IntegrationError("upstream_error", `arXiv returned HTTP ${response.status}.`, response.status);
    }
    return parseArxivFeed(await readResponseBody(response, maximumBytes, controller.signal));
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (controller.signal.aborted) {
      throw new IntegrationError("timeout", `arXiv did not respond within ${timeoutMs}ms.`);
    }
    throw new IntegrationError("network_failure", "Could not reach arXiv.");
  } finally {
    clearTimeout(timeout);
  }
}

function searchFailure(error: unknown): PaperSearchError {
  if (error instanceof PaperSearchError) return error;
  if (error instanceof IntegrationError && error.kind === "timeout") {
    return new PaperSearchError("timeout", "The arXiv search timed out.");
  }
  return new PaperSearchError("upstream", "arXiv could not provide a valid paper search response.");
}

export function createArxivSearchService(options: ArxivSearchOptions = {}): ArxivSearchService {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? ARXIV_TIMEOUT_MS;
  const maximumBytes = options.maxResponseBytes ?? ARXIV_MAX_RESPONSE_BYTES;
  const requestSpacingMs = options.requestSpacingMs ?? ARXIV_REQUEST_SPACING_MS;
  const cacheTtlMs = options.cacheTtlMs ?? ARXIV_CACHE_TTL_MS;
  const maxCacheEntries = Math.max(1, options.maxCacheEntries ?? ARXIV_MAX_CACHE_ENTRIES);
  const cache = new Map<string, { expiresAt: number; papers: PaperSearchResult[] }>();
  const inFlight = new Map<string, Promise<PaperSearchResult[]>>();
  let requestQueue: Promise<void> = Promise.resolve();
  let lastRequestStartedAt = Number.NEGATIVE_INFINITY;

  const evictExpired = () => {
    const timestamp = now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(key);
    }
  };

  const requestWithSpacing = (expression: string) => {
    const scheduled = requestQueue.then(async () => {
      const delay = Math.max(0, lastRequestStartedAt + requestSpacingMs - now());
      if (delay) await sleep(delay);
      lastRequestStartedAt = now();
      return requestArxivFeed(arxivSearchUrl(expression), fetchImplementation, timeoutMs, maximumBytes);
    });
    requestQueue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };

  return {
    async search(value: string | null): Promise<PaperSearchResponse> {
      const normalized = normalizeSearchQuery(value);
      evictExpired();
      const cached = cache.get(normalized.expression);
      if (cached) {
        return { provider: "arxiv", query: normalized.query, papers: clonePapers(cached.papers) };
      }

      let pending = inFlight.get(normalized.expression);
      if (!pending) {
        pending = requestWithSpacing(normalized.expression)
          .then((papers) => {
            while (cache.size >= maxCacheEntries) {
              const oldest = cache.keys().next();
              if (oldest.done) break;
              cache.delete(oldest.value);
            }
            cache.set(normalized.expression, { expiresAt: now() + cacheTtlMs, papers: clonePapers(papers) });
            return papers;
          })
          .finally(() => { inFlight.delete(normalized.expression); });
        inFlight.set(normalized.expression, pending);
      }
      try {
        return { provider: "arxiv", query: normalized.query, papers: clonePapers(await pending) };
      } catch (error) {
        throw searchFailure(error);
      }
    },
  };
}

const defaultSearchService = createArxivSearchService();

export function searchArxivPapers(query: string | null) {
  return defaultSearchService.search(query);
}

export async function probeArxiv(
  fetchImplementation: FetchImplementation = fetch,
  timeoutMs = ARXIV_TIMEOUT_MS,
): Promise<ArxivProbeResult> {
  const papers = await requestArxivFeed(
    arxivSearchUrl(ARXIV_PROBE_QUERY, 1),
    fetchImplementation,
    timeoutMs,
    ARXIV_MAX_RESPONSE_BYTES,
  );
  const paper = papers[0];
  if (!paper?.title || !paper.url) {
    throw new IntegrationError("malformed_response", "arXiv Atom feed contained no usable paper entry.");
  }
  return { provider: "arxiv", query: ARXIV_PROBE_QUERY, title: paper.title, link: paper.url };
}
