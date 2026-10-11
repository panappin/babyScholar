import { useEffect, useRef, useState, type FormEvent } from "react";
import { DocumentWorkspace } from "./DocumentWorkspace";
import { arxivSourceIdentity, safeArxivPaperLink } from "./paper-identity";
import type {
  PaperSearchErrorPayload,
  PaperSearchFailureResponse,
  PaperSearchResponse,
  PaperSearchResult,
} from "./worker/paper-search-types";
import type {
  LibraryErrorResponse,
  ListPapersResponse,
  SavedPaper,
  SavePaperResponse,
} from "./worker/library-types";

type HealthState = "loading" | "connected" | "failed";
type View = "search" | "library" | "pdfs";
type SearchState =
  | { status: "initial" }
  | { status: "loading"; query: string }
  | { status: "results"; response: PaperSearchResponse }
  | { status: "empty"; query: string; provider: string }
  | { status: "error"; query: string; message: string };
type LibraryState = {
  status: "initial" | "loading" | "empty" | "loaded" | "error";
  papers: SavedPaper[];
  message?: string;
};
type SaveState =
  | { status: "saving" }
  | { status: "saved"; paper: SavedPaper; created: boolean }
  | { status: "error"; message: string }
  | { status: "uncertain"; message: string };
type QueryValidation = { query: string } | { error: string };

const SEARCH_TIMEOUT_MS = 20_000;
const LIBRARY_TIMEOUT_MS = 10_000;
const SAVE_TIMEOUT_MS = 15_000;

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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isSavedPaper(value: unknown): value is SavedPaper {
  if (!isRecord(value) || value.source !== "arxiv" || typeof value.arxivId !== "string" || typeof value.savedAt !== "string") {
    return false;
  }
  return isPaperSearchResult({
    id: value.arxivId,
    title: value.title,
    authors: value.authors,
    year: value.year,
    abstract: value.abstract,
    url: value.url,
    pdfUrl: value.pdfUrl,
  }) && typeof value.id === "string";
}

function isListPapersResponse(value: unknown): value is ListPapersResponse {
  return isRecord(value) && Array.isArray(value.papers) && value.papers.every(isSavedPaper);
}

function isSavePaperResponse(value: unknown): value is SavePaperResponse {
  return isRecord(value) && typeof value.created === "boolean" && isSavedPaper(value.paper);
}

function searchErrorPayload(value: unknown): PaperSearchErrorPayload | undefined {
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

function libraryErrorPayload(value: unknown): LibraryErrorResponse["error"] | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const error = value.error;
  if (
    ["invalid_request", "unsupported_media_type", "body_too_large", "request_timeout", "method_not_allowed", "storage_unavailable", "database_failure"].includes(String(error.kind))
    && typeof error.message === "string"
  ) {
    return error as LibraryErrorResponse["error"];
  }
  return undefined;
}

function sortedPapers(papers: SavedPaper[]): SavedPaper[] {
  return [...papers].sort((left, right) => right.savedAt.localeCompare(left.savedAt) || right.id.localeCompare(left.id));
}

function mergeSavedPaper(papers: SavedPaper[], next: SavedPaper): SavedPaper[] {
  const identity = arxivSourceIdentity(next.arxivId);
  return sortedPapers([...papers.filter((paper) => arxivSourceIdentity(paper.arxivId) !== identity), next]);
}

function savedPaperFor(papers: SavedPaper[], arxivId: string) {
  return papers.find((paper) => arxivSourceIdentity(paper.arxivId) === arxivSourceIdentity(arxivId));
}

function savedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Saved time unavailable" : `Saved ${date.toLocaleString()}`;
}

function PaperLink({ url, arxivId }: { url: string | null; arxivId: string }) {
  const safeUrl = safeArxivPaperLink(url, arxivId);
  return safeUrl ? (
    <a className="paper-link" href={safeUrl} target="_blank" rel="noopener noreferrer">
      View paper on arXiv <span className="visually-hidden">(opens in a new tab)</span>
    </a>
  ) : <p className="paper-link-unavailable">Paper link unavailable</p>;
}

function PaperDetails({ paper, saved }: { paper: PaperSearchResult | SavedPaper; saved?: SavedPaper }) {
  const arxivId = saved?.arxivId ?? paper.id;
  return (
    <>
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
        <div>
          <dt>arXiv ID</dt>
          <dd><code>{arxivId}</code></dd>
        </div>
        {saved && (
          <>
            <div>
              <dt>Saved</dt>
              <dd><time dateTime={saved.savedAt}>{savedTime(saved.savedAt)}</time></dd>
            </div>
            <div>
              <dt>Library record ID</dt>
              <dd><code>{saved.id}</code></dd>
            </div>
          </>
        )}
      </dl>
      <div className="paper-abstract">
        <h4>Abstract</h4>
        <p>{paper.abstract || "Abstract unavailable."}</p>
      </div>
      <PaperLink url={paper.url} arxivId={arxivId} />
    </>
  );
}

function App() {
  const [healthState, setHealthState] = useState<HealthState>("loading");
  const [storageState, setStorageState] = useState<{ d1: HealthState; r2: HealthState }>({ d1: "loading", r2: "loading" });
  const [view, setView] = useState<View>("search");
  const [input, setInput] = useState("");
  const [searchState, setSearchState] = useState<SearchState>({ status: "initial" });
  const [libraryState, setLibraryState] = useState<LibraryState>({ status: "initial", papers: [] });
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  const activeSearch = useRef<AbortController | null>(null);
  const activeLibrary = useRef<AbortController | null>(null);
  const activeSaves = useRef(new Map<string, AbortController>());
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeMessage, setRemoveMessage] = useState<string | null>(null);
  const searchRequestId = useRef(0);
  const libraryRequestId = useRef(0);
  const libraryRevision = useRef(0);
  const mounted = useRef(false);

  function updateSaveState(identity: string, next: SaveState) {
    if (mounted.current) setSaveStates((current) => ({ ...current, [identity]: next }));
  }

  async function loadLibrary() {
    const requestId = libraryRequestId.current + 1;
    libraryRequestId.current = requestId;
    const revisionAtStart = libraryRevision.current;
    activeLibrary.current?.abort();
    const controller = new AbortController();
    activeLibrary.current = controller;
    let timedOut = false;
    let receivedResponse = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, LIBRARY_TIMEOUT_MS);
    if (mounted.current) setLibraryState((current) => ({ status: "loading", papers: current.papers }));

    try {
      const response = await fetch("/api/library/papers", { signal: controller.signal });
      receivedResponse = true;
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const serverError = libraryErrorPayload(body);
        throw new Error(serverError?.message ?? `The library could not be loaded (HTTP ${response.status}).`);
      }
      if (!isListPapersResponse(body)) throw new Error("The library returned an unexpected response. Please reload it.");
      if (!mounted.current || controller.signal.aborted || requestId !== libraryRequestId.current) return body.papers;
      if (revisionAtStart !== libraryRevision.current) return body.papers;
      const papers = sortedPapers(body.papers);
      setLibraryState({ status: papers.length ? "loaded" : "empty", papers });
      setSaveStates((current) => {
        let changed = false;
        const next = { ...current };
        for (const [identity, state] of Object.entries(current)) {
          if (state.status !== "uncertain") continue;
          const confirmed = papers.find((paper) => arxivSourceIdentity(paper.arxivId) === identity);
          next[identity] = confirmed
            ? { status: "saved", paper: confirmed, created: false }
            : { status: "error", message: "The save could not be confirmed after reloading the library. You can try again." };
          changed = true;
        }
        return changed ? next : current;
      });
      return papers;
    } catch (error) {
      if (!mounted.current || requestId !== libraryRequestId.current || (controller.signal.aborted && !timedOut)) return undefined;
      const message = timedOut
        ? "Loading the library took too long. Please reload it."
        : receivedResponse && error instanceof Error ? error.message : "The library could not be loaded. Please reload it.";
      setLibraryState((current) => ({ status: "error", papers: current.papers, message }));
      return undefined;
    } finally {
      window.clearTimeout(timeout);
      if (activeLibrary.current === controller) activeLibrary.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { signal });
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || body.status !== "ok") throw new Error("Health check failed");
        if (!controller.signal.aborted) setHealthState("connected");
      } catch {
        if (!controller.signal.aborted) setHealthState("failed");
      }
    }
    async function checkStorage() {
      try {
        const response = await fetch("/api/storage/status", { signal });
        const body: unknown = await response.json();
        if (!response.ok && response.status !== 503) throw new Error("Storage check failed");
        const componentState = (name: "d1" | "r2"): HealthState => {
          const component = isRecord(body) ? body[name] : undefined;
          return isRecord(component) && component.status === "ok" ? "connected" : "failed";
        };
        if (!controller.signal.aborted) setStorageState({ d1: componentState("d1"), r2: componentState("r2") });
      } catch {
        if (!controller.signal.aborted) setStorageState({ d1: "failed", r2: "failed" });
      }
    }
    void checkHealth();
    void checkStorage();
    void loadLibrary();
    return () => {
      mounted.current = false;
      controller.abort();
      activeSearch.current?.abort();
      activeLibrary.current?.abort();
      for (const save of activeSaves.current.values()) save.abort();
      activeSaves.current.clear();
    };
  }, []);

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
    let receivedResponse = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, SEARCH_TIMEOUT_MS);
    setSearchState({ status: "loading", query });
    setView("search");
    try {
      const response = await fetch(`/api/papers/search?${new URLSearchParams({ q: query })}`, { signal: controller.signal });
      receivedResponse = true;
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(searchErrorPayload(body as PaperSearchFailureResponse | undefined)?.message ?? `The paper search failed (HTTP ${response.status}).`);
      if (!isPaperSearchResponse(body)) throw new Error("The paper search returned an unexpected response. Please try again.");
      if (controller.signal.aborted || requestId !== searchRequestId.current || !mounted.current) return;
      setSearchState(body.papers.length ? { status: "results", response: body } : { status: "empty", query: body.query, provider: body.provider });
    } catch (error) {
      if (!mounted.current || requestId !== searchRequestId.current || (controller.signal.aborted && !timedOut)) return;
      setSearchState({
        status: "error",
        query,
        message: timedOut
          ? "The paper search took too long. Please try again."
          : receivedResponse && error instanceof Error ? error.message : "The paper search could not be completed. Please try again.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (activeSearch.current === controller) activeSearch.current = null;
    }
  }

  async function reconcileUncertainSave(identity: string, controller: AbortController) {
    const papers = await loadLibrary();
    if (!mounted.current || activeSaves.current.get(identity) !== controller) return;
    if (!papers) {
      updateSaveState(identity, { status: "uncertain", message: "The save outcome is still unknown. Reload the library to reconcile it before saving again." });
      return;
    }
    const confirmed = savedPaperFor(papers, identity);
    updateSaveState(identity, confirmed
      ? { status: "saved", paper: confirmed, created: false }
      : { status: "error", message: "The save could not be confirmed after reloading the library. You can try again." });
  }

  async function savePaper(paper: PaperSearchResult) {
    const identity = arxivSourceIdentity(paper.id);
    if (activeSaves.current.has(identity) || saveStates[identity]?.status === "uncertain" || savedPaperFor(libraryState.papers, paper.id)) return;
    const controller = new AbortController();
    activeSaves.current.set(identity, controller);
    updateSaveState(identity, { status: "saving" });
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, SAVE_TIMEOUT_MS);
    try {
      const response = await fetch("/api/library/papers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paper }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const serverError = libraryErrorPayload(body);
        if (serverError) updateSaveState(identity, { status: "error", message: serverError.message });
        else {
          updateSaveState(identity, { status: "uncertain", message: `The save returned HTTP ${response.status} without an application result. Checking the library before another save.` });
          await reconcileUncertainSave(identity, controller);
        }
        return;
      }
      if (!isSavePaperResponse(body) || arxivSourceIdentity(body.paper.arxivId) !== identity) {
        updateSaveState(identity, { status: "uncertain", message: "The save response was unexpected. Checking the library before another save." });
        await reconcileUncertainSave(identity, controller);
        return;
      }
      if (!mounted.current || controller.signal.aborted || activeSaves.current.get(identity) !== controller) return;
      libraryRevision.current += 1;
      setLibraryState((current) => {
        const papers = mergeSavedPaper(current.papers, body.paper);
        return { status: papers.length ? "loaded" : "empty", papers };
      });
      updateSaveState(identity, { status: "saved", paper: body.paper, created: body.created });
    } catch {
      if (!mounted.current || activeSaves.current.get(identity) !== controller) return;
      // No trustworthy success payload arrived. A save can have committed before
      // a browser timeout/network interruption, so reconcile with GET first.
      updateSaveState(identity, {
        status: "uncertain",
        message: timedOut ? "Saving took too long. Checking the library before another save." : "The save was interrupted. Checking the library before another save.",
      });
      await reconcileUncertainSave(identity, controller);
    } finally {
      window.clearTimeout(timeout);
      if (activeSaves.current.get(identity) === controller) activeSaves.current.delete(identity);
    }
  }

  async function removePaper(paper: SavedPaper) {
    if (removingId) return;
    setRemovingId(paper.id);
    setRemoveMessage(null);
    try {
      const response = await fetch(`/api/library/papers/${encodeURIComponent(paper.id)}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isRecord(body) || body.deleted !== true || body.id !== paper.id) throw new Error("Removal could not be confirmed. Reload the library, then explicitly retry if needed.");
      if (!mounted.current) return;
      const identity = arxivSourceIdentity(paper.arxivId);
      libraryRevision.current += 1;
      setSaveStates((current) => { const next = { ...current }; delete next[identity]; return next; });
      setLibraryState((current) => { const papers = current.papers.filter((entry) => entry.id !== paper.id); return { status: papers.length ? "loaded" : "empty", papers }; });
      await loadLibrary();
    } catch {
      if (mounted.current) setRemoveMessage("Removal is unconfirmed. Reload the library and retry Remove if the record remains. No delete was retried automatically.");
    } finally { if (mounted.current) setRemovingId(null); }
  }

  const searching = searchState.status === "loading";
  const inputIsInvalid = searchState.status === "error" && normalizeQuery(input) === searchState.query;
  const libraryCount = libraryState.papers.length;

  return (
    <main className="app-shell">
      <div className="app-content">
        <section className="welcome" aria-labelledby="app-title">
          <p className="eyebrow">Research workspace</p>
          <h1 id="app-title">AI Research Assistant</h1>
          <div className="statuses" role="status" aria-live="polite">
            <p className="status"><span className={`status-dot status-dot--${healthState}`} aria-hidden="true" />{healthCopy[healthState]}</p>
            {(["d1", "r2"] as const).map((name) => (
              <p className="status" key={name}>
                <span className={`status-dot status-dot--${storageState[name]}`} aria-hidden="true" />
                {name.toUpperCase()} {storageState[name] === "loading" ? "checking..." : storageState[name] === "connected" ? "connected" : "unavailable"}
              </p>
            ))}
          </div>
        </section>

        <div className="workspace-tabs" role="tablist" aria-label="Research workspace views">
          <button id="search-tab" type="button" role="tab" aria-selected={view === "search"} aria-controls="search-view" onClick={() => setView("search")}>Search</button>
          <button id="library-tab" type="button" role="tab" aria-selected={view === "library"} aria-controls="library-view" onClick={() => setView("library")}>
            Library{libraryCount ? ` (${libraryCount})` : ""}
          </button>
          <button id="pdfs-tab" type="button" role="tab" aria-selected={view === "pdfs"} aria-controls="pdfs-view" onClick={() => setView("pdfs")}>PDFs</button>
        </div>

        {view === "search" && (
          <section id="search-view" className="search-panel" role="tabpanel" aria-labelledby="search-tab paper-search-title">
            <div className="search-introduction">
              <div><p className="eyebrow">arXiv paper search</p><h2 id="paper-search-title">Search research papers</h2></div>
              <p>Find arXiv metadata by research topic or keywords.</p>
            </div>
            <form className="search-form" onSubmit={submitSearch} noValidate>
              <label htmlFor="paper-search-query">Research topic or keywords</label>
              <div className="search-controls">
                <input id="paper-search-query" name="q" type="text" value={input} maxLength={200} onChange={(event) => setInput(event.target.value)} placeholder="e.g. graph neural networks" aria-describedby="paper-search-help" aria-invalid={inputIsInvalid || undefined} autoComplete="off" />
                <button type="submit" disabled={searching}>{searching ? "Searching..." : "Search"}</button>
              </div>
              <p className="search-help" id="paper-search-help">Plain-text topics or keywords only, up to 200 characters.</p>
            </form>
            {searchState.status === "initial" && <p className="search-feedback" role="status">Search only runs when you submit a topic or keywords.</p>}
            {searchState.status === "loading" && <p className="search-feedback" role="status">Searching arXiv for &ldquo;{searchState.query}&rdquo;...</p>}
            {searchState.status === "empty" && <p className="search-feedback" role="status">No papers found for &ldquo;{searchState.query}&rdquo;. Try different keywords.</p>}
            {searchState.status === "error" && <p className="search-feedback search-feedback--error" role="alert">{searchState.query ? `Search for “${searchState.query}”: ` : ""}{searchState.message}</p>}
          </section>
        )}

        {view === "search" && searchState.status === "results" && (
          <section className="results-panel" aria-labelledby="search-results-title">
            <div className="results-heading">
              <div><p className="eyebrow">Search results</p><h2 id="search-results-title">{searchState.response.papers.length} {searchState.response.papers.length === 1 ? "paper" : "papers"} for {" "}&ldquo;{searchState.response.query}&rdquo;</h2></div>
              <p className="provider">Provider: {searchState.response.provider}</p>
            </div>
            <p className="results-note">Years reflect each paper&apos;s first arXiv submission.</p>
            <ol className="paper-list">
              {searchState.response.papers.map((paper) => {
                const identity = arxivSourceIdentity(paper.id);
                const saved = savedPaperFor(libraryState.papers, paper.id);
                const saveState = saveStates[identity];
                const saving = saveState?.status === "saving";
                const uncertain = saveState?.status === "uncertain";
                const disabled = Boolean(saved || saving || uncertain);
                return (
                  <li key={identity}>
                    <article className="paper-card" data-paper-identity={identity}>
                      <PaperDetails paper={paper} />
                      <div className="save-area">
                        <button type="button" className="save-button" onClick={() => void savePaper(paper)} disabled={disabled} data-save-paper={paper.id}>
                          {saving ? "Saving..." : uncertain ? "Save unconfirmed" : saved ? "Saved" : "Save to library"}
                        </button>
                        {saved && <p className="save-feedback" role="status">{saveState?.status === "saved" && !saveState.created ? "Saved — the original library record was retained." : "Saved in your library."}</p>}
                        {saveState?.status === "error" && <p className="save-feedback save-feedback--error" role="alert">{saveState.message}</p>}
                        {uncertain && <><p className="save-feedback" role="status">{saveState.message}</p><button type="button" className="reload-button" onClick={() => void loadLibrary()}>Reload library to check save</button></>}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {view === "library" && (
          <section id="library-view" className="results-panel" role="tabpanel" aria-labelledby="library-tab">
            <div className="results-heading">
              <div><p className="eyebrow">Persistent library</p><h2>Saved papers</h2></div>
              <button type="button" className="reload-button" onClick={() => void loadLibrary()} disabled={libraryState.status === "loading"}>Reload library</button>
            </div>
            {libraryState.status === "initial" && <p className="search-feedback" role="status">Library has not loaded yet.</p>}
            {libraryState.status === "loading" && <p className="search-feedback" role="status">Loading saved papers...</p>}
            {libraryState.status === "empty" && <p className="search-feedback" role="status">No saved papers yet. Save a search result to start your library.</p>}
            {libraryState.status === "error" && <p className="search-feedback search-feedback--error" role="alert">{libraryState.message}</p>}
            {removeMessage && <p role="alert" className="search-feedback search-feedback--error">{removeMessage}</p>}
            {libraryState.papers.length > 0 && <>
              <p className="results-note">{libraryState.papers.length} {libraryState.papers.length === 1 ? "saved paper" : "saved papers"}, newest first. Each has a distinct library record ID.</p>
              <ol className="paper-list">
                {libraryState.papers.map((paper) => <li key={paper.id}><article className="paper-card"><PaperDetails paper={paper} saved={paper} /><button type="button" className="reload-button" data-remove-paper={paper.id} disabled={removingId !== null} onClick={() => void removePaper(paper)}>{removingId === paper.id ? "Removing..." : "Remove from library"}</button></article></li>)}
              </ol>
            </>}
          </section>
        )}

        {view === "pdfs" && <DocumentWorkspace />}
      </div>
    </main>
  );
}

export default App;
