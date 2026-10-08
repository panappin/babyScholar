import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  PaperSearchErrorPayload,
  PaperSearchFailureResponse,
  PaperSearchResponse,
  PaperSearchResult,
} from "./worker/paper-search-types";

type HealthState = "loading" | "connected" | "failed";

type SearchState =
  | { status: "initial" }
  | { status: "loading"; query: string }
  | { status: "results"; response: PaperSearchResponse }
  | { status: "empty"; query: string; provider: string }
  | { status: "error"; query: string; message: string };

type QueryValidation = { query: string } | { error: string };

const SEARCH_TIMEOUT_MS = 20_000;

const healthCopy: Record<HealthState, string> = {
  loading: "Checking backend connection...",
  connected: "Backend connected",
  failed: "Backend unavailable",
};

function normalizeQuery(value: string) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function validateQuery(value: string): QueryValidation {
  const query = normalizeQuery(value);
  if (!query) return { error: "Enter a research topic or keywords to search." };
  if ([...query].length > 200) return { error: "Use 200 characters or fewer." };
  if (!(query.match(/[\p{L}\p{N}]/gu) ?? []).length) {
    return { error: "Use letters or numbers in the research topic or keywords." };
  }
  return { query };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPaperSearchResult(value: unknown): value is PaperSearchResult {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.title === "string"
    && Array.isArray(value.authors)
    && value.authors.every((author) => typeof author === "string")
    && (typeof value.year === "number" || value.year === null)
    && typeof value.abstract === "string"
    && (typeof value.url === "string" || value.url === null)
    && (typeof value.pdfUrl === "string" || value.pdfUrl === null);
}

function isPaperSearchResponse(value: unknown): value is PaperSearchResponse {
  return isRecord(value)
    && value.provider === "arxiv"
    && typeof value.query === "string"
    && Array.isArray(value.papers)
    && value.papers.every(isPaperSearchResult);
}

function errorPayload(value: unknown): PaperSearchErrorPayload | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const error = value.error;
  if (
    (error.kind === "invalid_query" || error.kind === "timeout" || error.kind === "upstream")
    && typeof error.message === "string"
  ) {
    return { kind: error.kind, message: error.message };
  }
  return undefined;
}

function App() {
  const [healthState, setHealthState] = useState<HealthState>("loading");
  const [storageState, setStorageState] = useState<{ d1: HealthState; r2: HealthState }>({
    d1: "loading",
    r2: "loading",
  });
  const [input, setInput] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "initial" });
  const activeSearch = useRef<AbortController | null>(null);
  const searchRequestId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { signal });

        if (!response.ok) {
          throw new Error(`Health check returned ${response.status}`);
        }

        const body: unknown = await response.json();
        const isHealthy =
          typeof body === "object"
          && body !== null
          && "status" in body
          && body.status === "ok";

        if (!isHealthy) {
          throw new Error("Health check returned an unexpected response");
        }

        if (!controller.signal.aborted) setHealthState("connected");
      } catch {
        if (!controller.signal.aborted) {
          setHealthState("failed");
        }
      }
    }

    async function checkStorage() {
      try {
        const response = await fetch("/api/storage/status", { signal });
        // A 503 still contains separate results, so one failed component does
        // not hide the other component's successful check.
        if (!response.ok && response.status !== 503) throw new Error("Storage check failed");
        const body: unknown = await response.json();
        const componentState = (name: "d1" | "r2"): HealthState => {
          if (typeof body !== "object" || body === null || !(name in body)) return "failed";
          const component = (body as Record<string, unknown>)[name];
          return typeof component === "object" && component !== null
            && "status" in component && component.status === "ok"
            ? "connected"
            : "failed";
        };
        if (!controller.signal.aborted) {
          setStorageState({ d1: componentState("d1"), r2: componentState("r2") });
        }
      } catch {
        if (!controller.signal.aborted) setStorageState({ d1: "failed", r2: "failed" });
      }
    }

    void checkHealth();
    void checkStorage();

    return () => controller.abort();
  }, []);

  useEffect(() => () => activeSearch.current?.abort(), []);

  async function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (searchState.status === "loading") return;

    const validation = validateQuery(input);
    if ("error" in validation) {
      setSearchState({ status: "error", query: normalizeQuery(input), message: validation.error });
      return;
    }

    const query = validation.query;
    const requestId = searchRequestId.current + 1;
    searchRequestId.current = requestId;
    activeSearch.current?.abort();
    const controller = new AbortController();
    activeSearch.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SEARCH_TIMEOUT_MS);
    setSearchState({ status: "loading", query });

    try {
      const parameters = new URLSearchParams({ q: query });
      const response = await fetch(`/api/papers/search?${parameters}`, { signal: controller.signal });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const serverError = errorPayload(body as PaperSearchFailureResponse | undefined);
        throw new Error(serverError?.message ?? `The paper search failed (HTTP ${response.status}).`);
      }
      if (!isPaperSearchResponse(body)) {
        throw new Error("The paper search returned an unexpected response. Please try again.");
      }
      if (controller.signal.aborted || requestId !== searchRequestId.current) return;
      setSearchState(body.papers.length
        ? { status: "results", response: body }
        : { status: "empty", query: body.query, provider: body.provider });
    } catch (error) {
      if (requestId !== searchRequestId.current) return;
      if (controller.signal.aborted) {
        if (timedOut) {
          setSearchState({ status: "error", query, message: "The paper search took too long. Please try again." });
        }
        return;
      }
      setSearchState({
        status: "error",
        query,
        message: error instanceof Error ? error.message : "The paper search could not be completed. Please try again.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (requestId === searchRequestId.current) activeSearch.current = null;
    }
  }

  const searching = searchState.status === "loading";
  const inputIsInvalid = searchState.status === "error" && normalizeQuery(input) === searchState.query;

  return (
    <main className="app-shell">
      <div className="app-content">
        <section className="welcome" aria-labelledby="app-title">
          <p className="eyebrow">Research workspace</p>
          <h1 id="app-title">AI Research Assistant</h1>
          <div className="statuses" role="status" aria-live="polite">
            <p className="status">
              <span className={`status-dot status-dot--${healthState}`} aria-hidden="true" />
              {healthCopy[healthState]}
            </p>
            {(["d1", "r2"] as const).map((name) => (
              <p className="status" key={name}>
                <span className={`status-dot status-dot--${storageState[name]}`} aria-hidden="true" />
                {name.toUpperCase()} {storageState[name] === "loading" ? "checking..." :
                  storageState[name] === "connected" ? "connected" : "unavailable"}
              </p>
            ))}
          </div>
        </section>

        <section className="search-panel" aria-labelledby="paper-search-title">
          <div className="search-introduction">
            <div>
              <p className="eyebrow">arXiv paper search</p>
              <h2 id="paper-search-title">Search research papers</h2>
            </div>
            <p>Find arXiv metadata by research topic or keywords.</p>
          </div>

          <form className="search-form" onSubmit={submitSearch} noValidate>
            <label htmlFor="paper-search-query">Research topic or keywords</label>
            <div className="search-controls">
              <input
                id="paper-search-query"
                name="q"
                type="text"
                value={input}
                maxLength={200}
                onChange={(event) => setInput(event.target.value)}
                placeholder="e.g. graph neural networks"
                aria-describedby="paper-search-help"
                aria-invalid={inputIsInvalid || undefined}
                autoComplete="off"
              />
              <button type="submit" disabled={searching}>
                {searching ? "Searching..." : "Search"}
              </button>
            </div>
            <p className="search-help" id="paper-search-help">Plain-text topics or keywords only, up to 200 characters.</p>
          </form>

          {searchState.status === "initial" && (
            <p className="search-feedback" role="status">Search only runs when you submit a topic or keywords.</p>
          )}
          {searchState.status === "loading" && (
            <p className="search-feedback" role="status">Searching arXiv for &ldquo;{searchState.query}&rdquo;...</p>
          )}
          {searchState.status === "empty" && (
            <p className="search-feedback" role="status">No papers found for &ldquo;{searchState.query}&rdquo;. Try different keywords.</p>
          )}
          {searchState.status === "error" && (
            <p className="search-feedback search-feedback--error" role="alert">
              {searchState.query ? `Search for “${searchState.query}”: ` : ""}{searchState.message}
            </p>
          )}
        </section>

        {searchState.status === "results" && (
          <section className="results-panel" aria-labelledby="search-results-title">
            <div className="results-heading">
              <div>
                <p className="eyebrow">Search results</p>
                <h2 id="search-results-title">
                  {searchState.response.papers.length} {searchState.response.papers.length === 1 ? "paper" : "papers"} for
                  {" "}&ldquo;{searchState.response.query}&rdquo;
                </h2>
              </div>
              <p className="provider">Provider: {searchState.response.provider}</p>
            </div>
            <p className="results-note">Years reflect each paper&apos;s first arXiv submission.</p>
            <ol className="paper-list">
              {searchState.response.papers.map((paper) => (
                <li key={paper.id}>
                  <article className="paper-card">
                    <h3>{paper.title || "Untitled paper"}</h3>
                    <dl className="paper-metadata">
                      <div>
                        <dt>Authors</dt>
                        <dd>{paper.authors.length ? paper.authors.join(", ") : "Authors unavailable"}</dd>
                      </div>
                      <div>
                        <dt>First submitted</dt>
                        <dd>{paper.year ?? "Year unavailable"}</dd>
                      </div>
                    </dl>
                    <div className="paper-abstract">
                      <h4>Abstract</h4>
                      <p>{paper.abstract || "Abstract unavailable."}</p>
                    </div>
                    {paper.url ? (
                      <a className="paper-link" href={paper.url} target="_blank" rel="noopener noreferrer">
                        View paper on arXiv <span className="visually-hidden">(opens in a new tab)</span>
                      </a>
                    ) : (
                      <p className="paper-link-unavailable">Paper link unavailable</p>
                    )}
                  </article>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </main>
  );
}

export default App;
