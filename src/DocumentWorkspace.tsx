import { useEffect, useRef, useState } from "react";
import type {
  DocumentErrorResponse,
  DocumentExtraction,
  DocumentMetadata,
  DocumentMetadataResponse,
  GetDocumentTextResponse,
  ListDocumentsResponse,
  UploadedDocument,
  UploadDocumentResponse,
} from "./worker/document-types";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 35_000;
const EXTRACTION_TIMEOUT_MS = 45_000;
const METADATA_TIMEOUT_MS = 35_000;

type ListState = {
  status: "initial" | "loading" | "empty" | "loaded" | "error";
  documents: UploadedDocument[];
  message?: string;
};

type DetailState = {
  status: "initial" | "loading" | "loaded" | "error";
  extraction: DocumentExtraction | null;
  metadata: DocumentMetadata | null;
  message?: string;
};

type ProcessingState =
  | { status: "idle" }
  | { status: "uploading"; message: string }
  | { status: "extracting"; documentId: string; message: string }
  | { status: "metadata"; documentId: string; message: string }
  | { status: "ready"; documentId: string; message: string }
  | { status: "uncertain"; documentId?: string; message: string }
  | { status: "error"; documentId?: string; message: string };

type StoredResults = { extraction: DocumentExtraction | null; metadata: DocumentMetadata | null };

class DocumentResponseError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUploadedDocument(value: unknown): value is UploadedDocument {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.filename === "string"
    && typeof value.byteCount === "number"
    && typeof value.sha256 === "string"
    && typeof value.uploadedAt === "string"
    && value.status === "stored";
}

function isListDocumentsResponse(value: unknown): value is ListDocumentsResponse {
  return isRecord(value) && Array.isArray(value.documents) && value.documents.every(isUploadedDocument);
}

function isExtraction(value: unknown): value is DocumentExtraction {
  return isRecord(value)
    && typeof value.documentId === "string"
    && typeof value.sourceSha256 === "string"
    && value.parser === "unpdf"
    && typeof value.parserVersion === "string"
    && typeof value.extractedAt === "string"
    && typeof value.pageCount === "number"
    && Array.isArray(value.pages)
    && value.pages.every((page) => isRecord(page) && typeof page.pageNumber === "number" && typeof page.text === "string");
}

function isMetadata(value: unknown): value is DocumentMetadata {
  if (!isRecord(value)
    || typeof value.documentId !== "string"
    || typeof value.sourceSha256 !== "string"
    || value.extractionParser !== "unpdf"
    || typeof value.extractionParserVersion !== "string"
    || typeof value.extractionExtractedAt !== "string"
    || !Array.isArray(value.selectedPageNumbers)
    || typeof value.sourceExcerptByteCount !== "number"
    || typeof value.sourceExcerptClipped !== "boolean"
    || typeof value.model !== "string"
    || typeof value.promptVersion !== "string"
    || typeof value.generatedAt !== "string"
    || (value.title !== null && typeof value.title !== "string")
    || (value.authors !== null && (!Array.isArray(value.authors) || !value.authors.every((author) => typeof author === "string")))
    || (value.year !== null && typeof value.year !== "number")
    || (value.abstract !== null && typeof value.abstract !== "string")
    || !Array.isArray(value.warnings)
    || !value.warnings.every((warning) => typeof warning === "string")
    || !isRecord(value.evidence)) return false;
  const evidence = value.evidence;
  return ["title", "authors", "year", "abstract"].every((field) => {
    const quotes = evidence[field];
    return Array.isArray(quotes)
      && quotes.every((quote: unknown) => isRecord(quote) && typeof quote.pageNumber === "number" && typeof quote.quote === "string");
  });
}

function documentError(value: unknown): DocumentErrorResponse["error"] | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.kind !== "string" || typeof value.error.message !== "string") return undefined;
  return value.error as DocumentErrorResponse["error"];
}

function messageForResponse(response: Response, body: unknown, fallback: string): string {
  return documentError(body)?.message ?? `${fallback} (HTTP ${response.status}).`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`;
}

function mergeDocument(documents: UploadedDocument[], next: UploadedDocument): UploadedDocument[] {
  return [...documents.filter((document) => document.id !== next.id), next]
    .sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt) || right.id.localeCompare(left.id));
}

function selectionLabel(extraction: DocumentExtraction | null, metadata: DocumentMetadata | null): string {
  if (extraction && metadata) return "Ready";
  if (extraction) return "Text extracted — metadata pending";
  return "Stored PDF — processing not started";
}

export function DocumentWorkspace() {
  const [listState, setListState] = useState<ListState>({ status: "initial", documents: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ status: "initial", extraction: null, metadata: null });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<ProcessingState>({ status: "idle" });
  const mounted = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const pipelineRequest = useRef<AbortController | null>(null);
  const listRevision = useRef(0);
  const detailRevision = useRef(0);
  const pipelineRevision = useRef(0);

  const selectedDocument = selectedId ? listState.documents.find((document) => document.id === selectedId) ?? null : null;
  const pipelineBusy = processing.status === "uploading" || processing.status === "extracting" || processing.status === "metadata";
  const processingDocumentId = processing.status === "extracting" || processing.status === "metadata" ? processing.documentId : undefined;

  function isCurrentPipeline(id: number, controller: AbortController) {
    return mounted.current && pipelineRevision.current === id && pipelineRequest.current === controller && !controller.signal.aborted;
  }

  async function readJson(response: Response): Promise<unknown> {
    return response.json().catch(() => undefined);
  }

  async function loadDocuments() {
    const revision = listRevision.current + 1;
    listRevision.current = revision;
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    if (mounted.current) setListState((current) => ({ status: "loading", documents: current.documents }));
    try {
      const response = await fetch("/api/documents", { signal: controller.signal });
      const body = await readJson(response);
      if (!response.ok) throw new Error(messageForResponse(response, body, "PDF records could not be loaded"));
      if (!isListDocumentsResponse(body)) throw new Error("PDF records returned an unexpected response. Reload the PDFs view.");
      if (!mounted.current || controller.signal.aborted || revision !== listRevision.current) return body.documents;
      const documents = [...body.documents].sort((left, right) => right.uploadedAt.localeCompare(left.uploadedAt) || right.id.localeCompare(left.id));
      setListState({ status: documents.length ? "loaded" : "empty", documents });
      return documents;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || revision !== listRevision.current) return undefined;
      setListState((current) => ({
        status: "error",
        documents: current.documents,
        message: timedOut ? "Loading PDFs took too long. Reload the list to try again." : error instanceof Error ? error.message : "PDF records could not be loaded. Reload the list to try again.",
      }));
      return undefined;
    } finally {
      window.clearTimeout(timeout);
      if (listRequest.current === controller) listRequest.current = null;
    }
  }

  async function getStoredResults(id: string, signal: AbortSignal): Promise<StoredResults> {
    const [textResponse, metadataResponse] = await Promise.all([
      fetch(`/api/documents/${encodeURIComponent(id)}/text`, { signal }),
      fetch(`/api/documents/${encodeURIComponent(id)}/metadata`, { signal }),
    ]);
    const [textBody, metadataBody] = await Promise.all([readJson(textResponse), readJson(metadataResponse)]);
    let extraction: DocumentExtraction | null = null;
    let metadata: DocumentMetadata | null = null;
    if (textResponse.ok) {
      if (!isRecord(textBody) || !isExtraction(textBody.extraction)) throw new Error("Stored text returned an unexpected response.");
      extraction = textBody.extraction;
    } else if (documentError(textBody)?.kind !== "extraction_not_found") {
      throw new Error(messageForResponse(textResponse, textBody, "Stored text could not be loaded"));
    }
    if (metadataResponse.ok) {
      if (!isRecord(metadataBody) || !isMetadata(metadataBody.metadata)) throw new Error("Stored metadata returned an unexpected response.");
      metadata = metadataBody.metadata;
    } else if (!["metadata_not_found", "extraction_not_found"].includes(documentError(metadataBody)?.kind ?? "")) {
      throw new Error(messageForResponse(metadataResponse, metadataBody, "Stored metadata could not be loaded"));
    }
    return { extraction, metadata };
  }

  async function loadDetails(id: string) {
    const revision = detailRevision.current + 1;
    detailRevision.current = revision;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    if (mounted.current) setDetailState((current) => ({ status: "loading", extraction: current.extraction, metadata: current.metadata }));
    try {
      const results = await getStoredResults(id, controller.signal);
      if (!mounted.current || controller.signal.aborted || revision !== detailRevision.current) return results;
      setDetailState({ status: "loaded", ...results });
      return results;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || revision !== detailRevision.current) return undefined;
      setDetailState((current) => ({
        status: "error",
        extraction: current.extraction,
        metadata: current.metadata,
        message: timedOut ? "Reading this PDF took too long. Select it again or reload the PDFs view." : error instanceof Error ? error.message : "This PDF could not be read.",
      }));
      return undefined;
    } finally {
      window.clearTimeout(timeout);
      if (detailRequest.current === controller) detailRequest.current = null;
    }
  }

  function selectDocument(id: string) {
    if (pipelineBusy) return;
    setSelectedId(id);
    setDetailState({ status: "loading", extraction: null, metadata: null });
    setProcessing({ status: "idle" });
    void loadDetails(id);
  }

  async function postEmpty(path: string, signal: AbortSignal): Promise<{ response: Response; body: unknown }> {
    const response = await fetch(path, { method: "POST", signal });
    const body = await readJson(response);
    if (!response.ok) throw new DocumentResponseError(messageForResponse(response, body, "Processing could not be completed"));
    return { response, body };
  }

  async function reconcilePipeline(id: string, revision: number, controller: AbortController, message: string) {
    if (!isCurrentPipeline(revision, controller)) return;
    setProcessing({ status: "uncertain", documentId: id, message });
    try {
      const results = await getStoredResults(id, controller.signal);
      if (!isCurrentPipeline(revision, controller)) return;
      setDetailState({ status: "loaded", ...results });
      if (results.extraction && results.metadata) setProcessing({ status: "ready", documentId: id, message: "Processing completed before the connection was interrupted." });
      else setProcessing({ status: "uncertain", documentId: id, message: "The request may have completed. The saved results are shown; choose Resume processing to continue missing work." });
    } catch {
      // The uncertain state already tells the user how to reconcile without a POST retry.
    }
  }

  async function resumeProcessing(document: UploadedDocument) {
    if (pipelineBusy) return;
    const revision = pipelineRevision.current + 1;
    pipelineRevision.current = revision;
    pipelineRequest.current?.abort();
    const controller = new AbortController();
    pipelineRequest.current = controller;
    let activeTimeout: number | null = null;
    const setPhaseTimeout = (milliseconds: number) => {
      if (activeTimeout !== null) window.clearTimeout(activeTimeout);
      activeTimeout = window.setTimeout(() => controller.abort(), milliseconds);
    };
    try {
      // An explicit resume first reads authoritative cached results. These GETs
      // never start extraction or metadata generation.
      setProcessing({ status: "extracting", documentId: document.id, message: "Checking saved processing results..." });
      setPhaseTimeout(READ_TIMEOUT_MS);
      let results = await getStoredResults(document.id, controller.signal);
      if (!isCurrentPipeline(revision, controller)) return;
      setDetailState({ status: "loaded", ...results });
      if (!results.extraction) {
        setProcessing({ status: "extracting", documentId: document.id, message: "Extracting text from the stored PDF..." });
        setPhaseTimeout(EXTRACTION_TIMEOUT_MS);
        const { body } = await postEmpty(`/api/documents/${encodeURIComponent(document.id)}/extract`, controller.signal);
        if (!isRecord(body) || !isExtraction(body.extraction)) throw new Error("Text extraction returned an unexpected response.");
        results = { ...results, extraction: body.extraction };
        if (!isCurrentPipeline(revision, controller)) return;
        setDetailState({ status: "loaded", ...results });
      }
      if (!results.metadata) {
        setProcessing({ status: "metadata", documentId: document.id, message: "Extracting source-grounded metadata..." });
        setPhaseTimeout(METADATA_TIMEOUT_MS);
        const { body } = await postEmpty(`/api/documents/${encodeURIComponent(document.id)}/metadata`, controller.signal);
        if (!isRecord(body) || !isMetadata(body.metadata)) throw new Error("Metadata extraction returned an unexpected response.");
        results = { ...results, metadata: body.metadata };
        if (!isCurrentPipeline(revision, controller)) return;
        setDetailState({ status: "loaded", ...results });
      }
      setProcessing({ status: "ready", documentId: document.id, message: "Ready — text and source-grounded metadata are saved." });
    } catch (error) {
      if (!isCurrentPipeline(revision, controller)) return;
      if (controller.signal.aborted || !(error instanceof DocumentResponseError)) {
        await reconcilePipeline(document.id, revision, controller, "Processing was interrupted or timed out. Checking saved results before another action.");
      } else {
        setProcessing({ status: "error", documentId: document.id, message: error instanceof Error ? error.message : "Processing could not be completed." });
      }
    } finally {
      if (activeTimeout !== null) window.clearTimeout(activeTimeout);
      if (pipelineRequest.current === controller) pipelineRequest.current = null;
    }
  }

  async function uploadAndProcess() {
    if (pipelineBusy) return;
    if (!file) {
      setFileError("Choose a PDF file before uploading.");
      return;
    }
    if (file.size < 1) {
      setFileError("Choose a nonempty PDF file.");
      return;
    }
    if (file.size > MAX_PDF_BYTES) {
      setFileError("Choose a PDF that is 10 MiB or smaller.");
      return;
    }
    const revision = pipelineRevision.current + 1;
    pipelineRevision.current = revision;
    const controller = new AbortController();
    pipelineRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, UPLOAD_TIMEOUT_MS);
    setFileError(null);
    setProcessing({ status: "uploading", message: "Uploading the original PDF..." });
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/documents", { method: "POST", body: form, signal: controller.signal });
      const body = await readJson(response);
      if (!response.ok) throw new DocumentResponseError(messageForResponse(response, body, "The PDF could not be uploaded"));
      if (!isRecord(body) || !isUploadedDocument(body.document)) throw new Error("The upload returned an unexpected response. Reload PDFs to inspect stored records before uploading again.");
      const document = body.document;
      if (!isCurrentPipeline(revision, controller)) return;
      setListState((current) => {
        const documents = mergeDocument(current.documents, document);
        return { status: "loaded", documents };
      });
      setSelectedId(document.id);
      setDetailState({ status: "initial", extraction: null, metadata: null });
      setFile(null);
      await resumeProcessing(document);
    } catch (error) {
      if (!isCurrentPipeline(revision, controller)) return;
      const uncertain = controller.signal.aborted || !(error instanceof DocumentResponseError);
      setProcessing({
        status: uncertain ? "uncertain" : "error",
        message: uncertain
          ? timedOut
            ? "Uploading took too long and may have succeeded. Reload PDFs and inspect/select a matching stored record before uploading again; no upload was retried."
            : "The upload may have been interrupted. Reload PDFs and inspect/select a matching stored record before uploading again; no upload was retried."
          : error instanceof Error ? error.message : "The PDF could not be uploaded.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (pipelineRequest.current === controller) pipelineRequest.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    void loadDocuments();
    return () => {
      mounted.current = false;
      listRequest.current?.abort();
      detailRequest.current?.abort();
      pipelineRequest.current?.abort();
    };
  }, []);

  return (
    <section id="pdfs-view" className="results-panel pdfs-panel" role="tabpanel" aria-labelledby="pdfs-tab">
      <div className="results-heading">
        <div><p className="eyebrow">Persistent documents</p><h2>PDFs</h2></div>
        <button type="button" className="reload-button" onClick={() => void loadDocuments()} disabled={listState.status === "loading" || pipelineBusy}>Reload PDFs</button>
      </div>
      <p className="results-note">Upload a PDF once, then explicitly process its saved original. Viewing, refreshing, and selecting use read-only requests only.</p>

      <form className="pdf-upload-form" onSubmit={(event) => { event.preventDefault(); void uploadAndProcess(); }} noValidate>
        <label htmlFor="pdf-upload">PDF file</label>
        <div className="upload-controls">
          <input id="pdf-upload" type="file" accept="application/pdf,.pdf" onChange={(event) => {
            const next = event.currentTarget.files?.item(0) ?? null;
            setFile(next);
            setFileError(null);
          }} disabled={pipelineBusy} aria-describedby="pdf-upload-help pdf-upload-error" />
          <button type="submit" disabled={pipelineBusy}>{processing.status === "uploading" ? "Uploading..." : "Upload and process"}</button>
        </div>
        <p id="pdf-upload-help" className="search-help">Choose one nonempty PDF up to 10 MiB. File and content validation remain authoritative on the server.</p>
        {fileError && <p id="pdf-upload-error" className="search-feedback search-feedback--error" role="alert">{fileError}</p>}
      </form>

      {processing.status !== "idle" && <p className={processing.status === "error" ? "search-feedback search-feedback--error" : "search-feedback"} role={processing.status === "error" ? "alert" : "status"}>{processing.message}</p>}
      {listState.status === "initial" && <p className="search-feedback" role="status">PDF records have not loaded yet.</p>}
      {listState.status === "loading" && <p className="search-feedback" role="status">Loading saved PDFs...</p>}
      {listState.status === "empty" && <p className="search-feedback" role="status">No PDFs have been uploaded yet.</p>}
      {listState.status === "error" && <p className="search-feedback search-feedback--error" role="alert">{listState.message}</p>}

      {listState.documents.length > 0 && <ol className="document-list" aria-label="Uploaded PDFs">
        {listState.documents.map((document) => (
          <li key={document.id}>
            <button type="button" className="document-select" data-document-id={document.id} aria-pressed={selectedId === document.id} onClick={() => selectDocument(document.id)} disabled={pipelineBusy}>
              <span>{document.filename || "Unnamed PDF"}</span>
              <small>Uploaded {formatTime(document.uploadedAt)} · {formatBytes(document.byteCount)}</small>
            </button>
          </li>
        ))}
      </ol>}

      {selectedDocument && <section className="document-detail" aria-live="polite" aria-labelledby="selected-pdf-title">
        <div className="results-heading">
          <div><p className="eyebrow">Selected PDF</p><h3 id="selected-pdf-title">{selectedDocument.filename || "Unnamed PDF"}</h3></div>
          <a className="paper-link" href={`/api/documents/${encodeURIComponent(selectedDocument.id)}/pdf`} download>Download original PDF</a>
        </div>
        <dl className="paper-metadata">
          <div><dt>Uploaded</dt><dd><time dateTime={selectedDocument.uploadedAt}>{formatTime(selectedDocument.uploadedAt)}</time></dd></div>
          <div><dt>Size</dt><dd>{formatBytes(selectedDocument.byteCount)}</dd></div>
          <div><dt>Status</dt><dd>{selectionLabel(detailState.extraction, detailState.metadata)}</dd></div>
        </dl>
        {detailState.status === "loading" && <p className="search-feedback" role="status">Reading saved text and metadata...</p>}
        {detailState.status === "error" && <p className="search-feedback search-feedback--error" role="alert">{detailState.message}</p>}
        {detailState.status !== "loading" && !(pipelineBusy && processingDocumentId === selectedDocument.id) && !(detailState.extraction && detailState.metadata) && <button type="button" className="save-button" onClick={() => void resumeProcessing(selectedDocument)}>Resume processing</button>}
        {detailState.extraction && <details className="document-text"><summary>Extracted page text ({detailState.extraction.pageCount} {detailState.extraction.pageCount === 1 ? "page" : "pages"})</summary>
          {detailState.extraction.pages.map((page) => <section key={page.pageNumber}><h4>Page {page.pageNumber}</h4><pre>{page.text || "No text was extracted from this page."}</pre></section>)}
        </details>}
        {detailState.metadata && <section className="document-metadata" aria-labelledby="document-metadata-title">
          <p className="eyebrow">Source-grounded metadata</p><h4 id="document-metadata-title">Document details</h4>
          <p className="results-note">Metadata comes from the selected opening pages of this stored PDF, not its filename or web search.</p>
          <dl className="paper-metadata">
            <div><dt>Title</dt><dd>{detailState.metadata.title ?? "Title unavailable"}</dd></div>
            <div><dt>Authors</dt><dd>{detailState.metadata.authors?.length ? detailState.metadata.authors.join(", ") : "Authors unavailable"}</dd></div>
            <div><dt>Year</dt><dd>{detailState.metadata.year ?? "Year unavailable"}</dd></div>
            <div><dt>Generated</dt><dd><time dateTime={detailState.metadata.generatedAt}>{formatTime(detailState.metadata.generatedAt)}</time></dd></div>
          </dl>
          <div className="paper-abstract"><h4>Abstract</h4><p>{detailState.metadata.abstract ?? "Abstract unavailable"}</p></div>
          {detailState.metadata.warnings.length > 0 && <section className="document-warnings" aria-labelledby="metadata-warnings-title"><h4 id="metadata-warnings-title">Warnings</h4><ul>{detailState.metadata.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}
          <details className="metadata-evidence"><summary>Page-numbered source evidence</summary>
            {(["title", "authors", "year", "abstract"] as const).map((field) => <section key={field}><h4>{field[0].toUpperCase()}{field.slice(1)}</h4>{detailState.metadata!.evidence[field].length
              ? <ol>{detailState.metadata!.evidence[field].map((quote, index) => <li key={`${quote.pageNumber}-${index}`}><strong>Page {quote.pageNumber}:</strong> {quote.quote}</li>)}</ol>
              : <p>No source quote was retained for this unavailable field.</p>}</section>)}
          </details>
        </section>}
      </section>}
    </section>
  );
}
