import { IntegrationError } from "./integration-errors.js";

const ARXIV_QUERY = "all:electron";
const ARXIV_TIMEOUT_MS = 10_000;

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
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
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

// A deliberately small, non-DOM parser for the Atom fields this fixed probe needs.
// It rejects malformed nesting and document type declarations instead of treating XML as HTML.
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
  const value = [...node.text, ...node.children.map((item) => nodeText(item) ?? "")].join("").replace(/\s+/gu, " ").trim();
  return value || undefined;
}

function parseArxivFeed(xml: string): Omit<ArxivProbeResult, "provider" | "query"> {
  const feed = parseXmlDocument(xml);
  if (localName(feed.name) !== "feed") {
    throw new IntegrationError("malformed_response", "arXiv did not return an Atom feed.");
  }

  const entries = children(feed, "entry");
  const errorEntry = entries.find((entry) => nodeText(child(entry, "title"))?.toLowerCase() === "error");
  if (errorEntry) {
    throw new IntegrationError(
      "upstream_error",
      `arXiv returned an error feed: ${nodeText(child(errorEntry, "summary")) ?? "unspecified error"}`,
    );
  }

  const entry = entries[0];
  if (!entry) {
    throw new IntegrationError("malformed_response", "arXiv Atom feed contained no paper entry.");
  }
  const title = nodeText(child(entry, "title"));
  const links = children(entry, "link").map((link) => link.attributes.href).filter(Boolean);
  const alternate = children(entry, "link").find((link) => link.attributes.rel === "alternate")?.attributes.href;
  const link = alternate ?? links[0] ?? nodeText(child(entry, "id"));

  if (!title || !link) {
    throw new IntegrationError("malformed_response", "arXiv Atom feed contained no usable paper entry.");
  }

  let parsedLink: URL;
  try {
    parsedLink = new URL(link);
  } catch {
    throw new IntegrationError("malformed_response", "arXiv paper entry had an invalid link.");
  }
  if (!parsedLink.hostname.endsWith("arxiv.org") || !parsedLink.pathname.includes("/abs/")) {
    throw new IntegrationError("malformed_response", "arXiv paper entry did not contain an abstract link.");
  }
  parsedLink.protocol = "https:";
  return { title, link: parsedLink.toString() };
}

export async function probeArxiv(
  fetchImplementation: FetchImplementation = fetch,
  timeoutMs = ARXIV_TIMEOUT_MS,
): Promise<ArxivProbeResult> {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", ARXIV_QUERY);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "1");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // One request, one connection, no retry. arXiv asks clients to delay 3 seconds between calls.
    response = await fetchImplementation(url, {
      headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new IntegrationError("timeout", `arXiv did not respond within ${timeoutMs}ms.`);
    }
    throw new IntegrationError("network_failure", "Could not reach arXiv.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new IntegrationError("upstream_error", `arXiv returned HTTP ${response.status}.`, response.status);
  }
  const text = await response.text();
  const paper = parseArxivFeed(text);
  return { provider: "arxiv", query: ARXIV_QUERY, ...paper };
}
