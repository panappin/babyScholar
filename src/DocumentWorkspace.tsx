import { useEffect, useRef, useState } from "react";
import type {
  DocumentErrorResponse,
  DocumentExtraction,
  DocumentMetadata,
  DocumentMetadataResponse,
  DocumentQuestionAnswerPart,
  DocumentQuestionEvidenceQuote,
  DocumentQuestionRecord,
  DocumentQuestionResponse,
  DocumentSummary,
  DocumentSummaryEvidenceQuote,
  DocumentSummaryItem,
  DocumentSummaryPageRange,
  DocumentSummaryResponse,
  GetDocumentTextResponse,
  ListDocumentQuestionsResponse,
  ListDocumentsResponse,
  UploadedDocument,
  UploadDocumentResponse,
} from "./worker/document-types";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 35_000;
const EXTRACTION_TIMEOUT_MS = 45_000;
const METADATA_TIMEOUT_MS = 35_000;
const SUMMARY_TIMEOUT_MS = 35_000;
const QUESTION_TIMEOUT_MS = 35_000;
const DOWNLOAD_TIMEOUT_MS = 35_000;
const PREPARED_DOWNLOAD_LIFETIME_MS = 60_000;
const MAX_QUESTION_BYTES = 2 * 1024;

type ListState = {
  status: "initial" | "loading" | "empty" | "loaded" | "error";
  documents: UploadedDocument[];
  message?: string;
};

type DetailState = {
  status: "initial" | "loading" | "loaded" | "error";
  extraction: DocumentExtraction | null;
  metadata: DocumentMetadata | null;
  summary: SummaryState;
  questions: QuestionState;
  message?: string;
};

type SummaryState = {
  status: "initial" | "loading" | "not_generated" | "missing_extraction" | "generating" | "in_progress" | "loaded" | "error" | "uncertain";
  summary: DocumentSummary | null;
  message?: string;
};

type QuestionState = {
  status: "initial" | "loading" | "empty" | "missing_extraction" | "asking" | "in_progress" | "loaded" | "error" | "uncertain";
  questions: DocumentQuestionRecord[];
  message?: string;
  submittedQuestion?: string;
  /** A gateway/session response, rather than the documented Worker contract. */
  accessDenied?: boolean;
};

type DownloadState = {
  status: "idle" | "preparing" | "ready" | "error";
  documentId?: string;
  message?: string;
  objectUrl?: string;
  filename?: string;
};

type ProcessingState =
  | { status: "idle" }
  | { status: "uploading"; message: string }
  | { status: "extracting"; documentId: string; message: string }
  | { status: "metadata"; documentId: string; message: string }
  | { status: "ready"; documentId: string; message: string }
  | { status: "uncertain"; documentId?: string; message: string }
  | { status: "error"; documentId?: string; message: string };

type StoredResults = { extraction: DocumentExtraction | null; metadata: DocumentMetadata | null; summary: SummaryState; questions: QuestionState };

class DocumentResponseError extends Error {}

function initialQuestionState(): QuestionState {
  return { status: "initial", questions: [] };
}

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

function isSummaryEvidenceQuote(value: unknown): value is DocumentSummaryEvidenceQuote {
  return isRecord(value) && typeof value.pageNumber === "number" && typeof value.quote === "string";
}

function isSummaryItem(value: unknown): value is DocumentSummaryItem {
  return isRecord(value) && typeof value.text === "string" && Array.isArray(value.evidence) && value.evidence.every(isSummaryEvidenceQuote);
}

function isSummaryPageRange(value: unknown): value is DocumentSummaryPageRange {
  return isRecord(value) && typeof value.startPage === "number" && typeof value.endPage === "number";
}

function isSummary(value: unknown): value is DocumentSummary {
  if (!isRecord(value)
    || typeof value.documentId !== "string"
    || typeof value.sourceSha256 !== "string"
    || value.extractionParser !== "unpdf"
    || typeof value.extractionParserVersion !== "string"
    || typeof value.extractionExtractedAt !== "string"
    || typeof value.totalPageCount !== "number"
    || !Array.isArray(value.includedPageNumbers) || !value.includedPageNumbers.every((page) => typeof page === "number")
    || !Array.isArray(value.includedPageRanges) || !value.includedPageRanges.every(isSummaryPageRange)
    || typeof value.sourceExcerptByteCount !== "number"
    || typeof value.sourceExcerptTruncated !== "boolean"
    || typeof value.sourceCoverageWarning !== "string"
    || typeof value.model !== "string"
    || typeof value.promptVersion !== "string"
    || typeof value.schemaVersion !== "string"
    || typeof value.createdAt !== "string"
    || !isSummaryItem(value.overview)
    || ![value.contributions, value.methods, value.findings, value.limitations].every((items) => Array.isArray(items) && items.every(isSummaryItem))
    || !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")) return false;
  return true;
}

function isSummaryResponse(value: unknown): value is DocumentSummaryResponse {
  return isRecord(value) && isSummary(value.summary) && (value.created === undefined || typeof value.created === "boolean");
}

function isQuestionEvidenceQuote(value: unknown): value is DocumentQuestionEvidenceQuote {
  return isRecord(value) && typeof value.pageNumber === "number" && typeof value.quote === "string";
}

function isQuestionAnswerPart(value: unknown): value is DocumentQuestionAnswerPart {
  return isRecord(value) && typeof value.text === "string" && Array.isArray(value.evidence) && value.evidence.every(isQuestionEvidenceQuote);
}

function isQuestion(value: unknown): value is DocumentQuestionRecord {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.documentId !== "string"
    || typeof value.question !== "string"
    || typeof value.normalizedQuestion !== "string"
    || typeof value.sourceSha256 !== "string"
    || value.extractionParser !== "unpdf"
    || typeof value.extractionParserVersion !== "string"
    || typeof value.extractionExtractedAt !== "string"
    || typeof value.extractionFingerprint !== "string"
    || typeof value.totalPageCount !== "number"
    || !Array.isArray(value.includedPageNumbers) || !value.includedPageNumbers.every((page) => typeof page === "number")
    || !Array.isArray(value.includedPageRanges) || !value.includedPageRanges.every(isSummaryPageRange)
    || typeof value.sourceExcerptByteCount !== "number"
    || typeof value.sourceExcerptTruncated !== "boolean"
    || typeof value.sourceCoverageWarning !== "string"
    || typeof value.model !== "string"
    || typeof value.promptVersion !== "string"
    || typeof value.schemaVersion !== "string"
    || !Array.isArray(value.answerParts) || !value.answerParts.every(isQuestionAnswerPart)
    || (value.insufficientSourceReason !== null && typeof value.insufficientSourceReason !== "string")
    || !Array.isArray(value.warnings) || !value.warnings.every((warning) => typeof warning === "string")
    || typeof value.createdAt !== "string") return false;
  return (value.outcome === "answered" && value.answerParts.length > 0 && value.insufficientSourceReason === null)
    || (value.outcome === "insufficient_source" && value.answerParts.length === 0 && typeof value.insufficientSourceReason === "string");
}

function isListQuestionsResponse(value: unknown): value is ListDocumentQuestionsResponse {
  return isRecord(value) && Array.isArray(value.questions) && value.questions.every(isQuestion);
}

function isQuestionResponse(value: unknown): value is DocumentQuestionResponse {
  return isRecord(value) && isQuestion(value.question) && (value.created === undefined || typeof value.created === "boolean");
}

function documentError(value: unknown): DocumentErrorResponse["error"] | undefined {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.kind !== "string" || typeof value.error.message !== "string") return undefined;
  return value.error as DocumentErrorResponse["error"];
}

function messageForResponse(response: Response, body: unknown, fallback: string): string {
  return documentError(body)?.message ?? `${fallback} (HTTP ${response.status}).`;
}

function nonApplicationQuestionAccessMessage(response: Response, body: unknown): string | null {
  // The Worker does not issue 401/403 from the question contract. Do not show
  // a gateway's HTML/body; keep the submitted question for explicit recovery.
  if ((response.status === 401 || response.status === 403) && !documentError(body)) {
    return `The private site denied access to Q&A (HTTP ${response.status}) before the application could confirm this question. Use the site's normal sign-in flow, then reload question history. No question was retried.`;
  }
  return null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time unavailable" : date.toLocaleString();
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`;
}

function safeDownloadFilename(filename: string): string {
  const safe = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/\s+/gu, " ").trim().replace(/[. ]+$/u, "");
  const base = safe || "original.pdf";
  return /\.pdf$/iu.test(base) ? base : `${base}.pdf`;
}

async function readBoundedPdf(response: Response): Promise<Blob> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType && contentType !== "application/pdf") throw new Error("The original download did not return a PDF file.");
  if (!response.body) throw new Error("The original download had no file body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > MAX_PDF_BYTES) throw new Error("The original download exceeded the 10 MiB PDF limit.");
      chunks.push(chunk.value);
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(byteCount));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([bytes.buffer], { type: "application/pdf" });
}

function formatPageRanges(ranges: DocumentSummaryPageRange[]): string {
  return ranges.map((range) => range.startPage === range.endPage ? `Page ${range.startPage}` : `Pages ${range.startPage}-${range.endPage}`).join(", ");
}

function normalizedQuestion(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function questionInputError(value: string): string | null {
  if (!value || value !== value.trim()) return "Enter a trimmed, nonempty question.";
  if (new TextEncoder().encode(value).byteLength > MAX_QUESTION_BYTES) return "Use a question of 2 KiB UTF-8 or fewer.";
  return null;
}

function mergeQuestions(questions: DocumentQuestionRecord[], next: DocumentQuestionRecord): DocumentQuestionRecord[] {
  return [next, ...questions.filter((question) => question.id !== next.id)]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
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

function SummaryQuotes({ evidence }: { evidence: DocumentSummaryEvidenceQuote[] }) {
  return <details className="summary-evidence">
    <summary>Supporting quotes ({evidence.length})</summary>
    <ol>{evidence.map((quote, index) => <li key={`${quote.pageNumber}-${index}`}><strong>Page {quote.pageNumber}:</strong> {quote.quote}</li>)}</ol>
  </details>;
}

function SummaryItems({ title, items, emptyCopy }: { title: string; items: DocumentSummaryItem[]; emptyCopy: string }) {
  return <section className="summary-section">
    <h5>{title}</h5>
    {items.length ? <ol>{items.map((item, index) => <li key={`${item.text}-${index}`}><p>{item.text}</p><SummaryQuotes evidence={item.evidence} /></li>)}</ol> : <p>{emptyCopy}</p>}
  </section>;
}

function SummaryContent({ summary }: { summary: DocumentSummary }) {
  const coverage = formatPageRanges(summary.includedPageRanges);
  return <>
    <p className={summary.sourceExcerptTruncated ? "summary-coverage summary-coverage--partial" : "summary-coverage"}>
      <strong>{summary.sourceExcerptTruncated ? "Partial source coverage." : "Full source coverage."}</strong>{" "}
      {summary.sourceCoverageWarning} Included extracted pages: {coverage || "none"} of {summary.totalPageCount}. {summary.sourceExcerptTruncated ? "Text outside the source budget was omitted." : "No extracted page text was omitted by the summary source budget."}
    </p>
    <p className="results-note">Supporting quotes show that cited text occurs on the listed source page. They do not prove every paraphrased summary claim.</p>
    <section className="summary-overview" aria-labelledby="summary-overview-title">
      <h5 id="summary-overview-title">Overview</h5>
      <p>{summary.overview.text}</p>
      <SummaryQuotes evidence={summary.overview.evidence} />
    </section>
    <SummaryItems title="Contributions" items={summary.contributions} emptyCopy="No contributions were returned; see the summary warnings." />
    <SummaryItems title="Methods" items={summary.methods} emptyCopy="No methods were returned; see the summary warnings." />
    <SummaryItems title="Findings" items={summary.findings} emptyCopy="No findings were returned; see the summary warnings." />
    <SummaryItems title="Stated limitations" items={summary.limitations} emptyCopy="No stated limitations were returned; see the summary warnings." />
    {summary.warnings.length > 0 && <section className="document-warnings summary-warnings" aria-labelledby="summary-warnings-title"><h5 id="summary-warnings-title">Warnings</h5><ul>{summary.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}
  </>;
}

function QuestionQuotes({ evidence }: { evidence: DocumentQuestionEvidenceQuote[] }) {
  return <details className="summary-evidence question-evidence">
    <summary>Supporting quotes ({evidence.length})</summary>
    <ol>{evidence.map((quote, index) => <li key={`${quote.pageNumber}-${index}`}><strong>Page {quote.pageNumber}:</strong> {quote.quote}</li>)}</ol>
  </details>;
}

function QuestionCard({ question }: { question: DocumentQuestionRecord }) {
  const coverage = formatPageRanges(question.includedPageRanges);
  return <article className="question-card" data-question-id={question.id}>
    <div className="question-card-heading">
      <h5>{question.question}</h5>
      <time dateTime={question.createdAt}>{formatTime(question.createdAt)}</time>
    </div>
    <p className={question.sourceExcerptTruncated ? "summary-coverage summary-coverage--partial" : "summary-coverage"}>
      <strong>{question.sourceExcerptTruncated ? "Partial source coverage." : "Full source coverage."}</strong>{" "}
      {question.sourceCoverageWarning} Included extracted pages: {coverage || "none"} of {question.totalPageCount}. {question.sourceExcerptTruncated ? "Text outside the included excerpt was omitted." : "No extracted page text was omitted by the question source budget."}
    </p>
    {question.outcome === "insufficient_source" ? <section className="question-insufficient" aria-label="Insufficient source result">
      <h6>Insufficient source</h6><p>{question.insufficientSourceReason}</p>
    </section> : <section className="question-answered" aria-label="Source-grounded answer">
      <h6>Answer</h6>
      <ol>{question.answerParts.map((part, index) => <li key={`${part.text}-${index}`}><p>{part.text}</p><QuestionQuotes evidence={part.evidence} /></li>)}</ol>
    </section>}
    <p className="results-note">Supporting quotes show that cited text occurs on the listed source page. They do not prove every paraphrased answer claim.</p>
    {question.warnings.length > 0 && <section className="document-warnings question-warnings" aria-labelledby={`question-warnings-${question.id}`}><h6 id={`question-warnings-${question.id}`}>Warnings</h6><ul>{question.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></section>}
  </article>;
}

export function DocumentWorkspace() {
  const [listState, setListState] = useState<ListState>({ status: "initial", documents: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ status: "initial", extraction: null, metadata: null, summary: { status: "initial", summary: null }, questions: initialQuestionState() });
  const [questionInput, setQuestionInput] = useState("");
  const [questionInputMessage, setQuestionInputMessage] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState>({ status: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<ProcessingState>({ status: "idle" });
  const mounted = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const pipelineRequest = useRef<AbortController | null>(null);
  const summaryRequest = useRef<AbortController | null>(null);
  const questionRequest = useRef<AbortController | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadObjectUrl = useRef<string | null>(null);
  const downloadObjectUrlExpiry = useRef<number | null>(null);
  const listRevision = useRef(0);
  const detailRevision = useRef(0);
  const pipelineRevision = useRef(0);
  const summaryRevision = useRef(0);
  const questionRevision = useRef(0);
  const downloadRevision = useRef(0);

  const selectedDocument = selectedId ? listState.documents.find((document) => document.id === selectedId) ?? null : null;
  const pipelineBusy = processing.status === "uploading" || processing.status === "extracting" || processing.status === "metadata";
  const processingDocumentId = processing.status === "extracting" || processing.status === "metadata" ? processing.documentId : undefined;
  const summaryBusy = detailState.summary.status === "generating";
  const questionBusy = detailState.questions.status === "asking";

  function isCurrentPipeline(id: number, controller: AbortController) {
    return mounted.current && pipelineRevision.current === id && pipelineRequest.current === controller && !controller.signal.aborted;
  }

  function ownsSummaryRequest(id: number, documentId: string, controller: AbortController) {
    return mounted.current && selectedId === documentId && summaryRevision.current === id && summaryRequest.current === controller;
  }

  function isCurrentSummary(id: number, documentId: string, controller: AbortController) {
    return ownsSummaryRequest(id, documentId, controller) && !controller.signal.aborted;
  }

  function ownsQuestionRequest(id: number, documentId: string, controller: AbortController) {
    return mounted.current && selectedId === documentId && questionRevision.current === id && questionRequest.current === controller;
  }

  function isCurrentQuestion(id: number, documentId: string, controller: AbortController) {
    return ownsQuestionRequest(id, documentId, controller) && !controller.signal.aborted;
  }

  function ownsDownloadRequest(id: number, documentId: string, controller: AbortController) {
    return mounted.current && selectedId === documentId && downloadRevision.current === id && downloadRequest.current === controller;
  }

  function revokeDownloadObjectUrl() {
    if (downloadObjectUrlExpiry.current !== null) {
      window.clearTimeout(downloadObjectUrlExpiry.current);
      downloadObjectUrlExpiry.current = null;
    }
    if (downloadObjectUrl.current) {
      URL.revokeObjectURL(downloadObjectUrl.current);
      downloadObjectUrl.current = null;
    }
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

  async function getStoredSummary(id: string, signal: AbortSignal): Promise<SummaryState> {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/summary`, { signal });
      const body = await readJson(response);
      if (response.ok) {
        if (!isSummaryResponse(body) || body.summary.documentId !== id) {
          return { status: "error", summary: null, message: "Saved summary returned an unexpected response. Reload summary to try again." };
        }
        return { status: "loaded", summary: body.summary };
      }
      const error = documentError(body);
      if (error?.kind === "summary_not_found") return { status: "not_generated", summary: null };
      if (error?.kind === "extraction_not_found") return { status: "missing_extraction", summary: null };
      return { status: "error", summary: null, message: messageForResponse(response, body, "Saved summary could not be loaded") };
    } catch (error) {
      return { status: "error", summary: null, message: error instanceof Error ? `Saved summary could not be loaded: ${error.message}` : "Saved summary could not be loaded. Reload summary to try again." };
    }
  }

  async function getStoredQuestions(id: string, signal: AbortSignal): Promise<QuestionState> {
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(id)}/questions`, { signal });
      const body = await readJson(response);
      if (response.ok) {
        if (!isListQuestionsResponse(body) || body.questions.some((question) => question.documentId !== id)) {
          return { status: "error", questions: [], message: "Saved questions returned an unexpected response. Reload question history to try again." };
        }
        return { status: body.questions.length ? "loaded" : "empty", questions: body.questions };
      }
      const error = documentError(body);
      if (error?.kind === "extraction_not_found") return { status: "missing_extraction", questions: [] };
      const accessMessage = nonApplicationQuestionAccessMessage(response, body);
      if (accessMessage) return { status: "error", questions: [], message: accessMessage, accessDenied: true };
      return { status: "error", questions: [], message: messageForResponse(response, body, "Saved questions could not be loaded") };
    } catch (error) {
      return { status: "error", questions: [], message: error instanceof Error ? `Saved questions could not be loaded: ${error.message}` : "Saved questions could not be loaded. Reload question history to try again." };
    }
  }

  async function getStoredResults(id: string, signal: AbortSignal): Promise<StoredResults> {
    const [textResponse, metadataResponse, summary, questions] = await Promise.all([
      fetch(`/api/documents/${encodeURIComponent(id)}/text`, { signal }),
      fetch(`/api/documents/${encodeURIComponent(id)}/metadata`, { signal }),
      getStoredSummary(id, signal),
      getStoredQuestions(id, signal),
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
    return { extraction, metadata, summary, questions };
  }

  async function loadDetails(id: string) {
    const revision = detailRevision.current + 1;
    detailRevision.current = revision;
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    if (mounted.current) setDetailState((current) => ({ status: "loading", extraction: current.extraction, metadata: current.metadata, summary: { status: "loading", summary: current.summary.summary }, questions: { status: "loading", questions: current.questions.questions } }));
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
        summary: current.summary,
        questions: current.questions,
        message: timedOut ? "Reading this PDF took too long. Select it again or reload the PDFs view." : error instanceof Error ? error.message : "This PDF could not be read.",
      }));
      return undefined;
    } finally {
      window.clearTimeout(timeout);
      if (detailRequest.current === controller) detailRequest.current = null;
    }
  }

  function selectDocument(id: string) {
    if (pipelineBusy || summaryBusy) return;
    summaryRevision.current += 1;
    summaryRequest.current?.abort();
    questionRevision.current += 1;
    questionRequest.current?.abort();
    downloadRevision.current += 1;
    downloadRequest.current?.abort();
    revokeDownloadObjectUrl();
    setDownloadState({ status: "idle" });
    setSelectedId(id);
    setDetailState({ status: "loading", extraction: null, metadata: null, summary: { status: "loading", summary: null }, questions: { status: "loading", questions: [] } });
    setQuestionInput("");
    setQuestionInputMessage(null);
    setProcessing({ status: "idle" });
    void loadDetails(id);
  }

  async function prepareOriginalDownload(document: UploadedDocument) {
    const revision = downloadRevision.current + 1;
    downloadRevision.current = revision;
    downloadRequest.current?.abort();
    revokeDownloadObjectUrl();
    const controller = new AbortController();
    downloadRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, DOWNLOAD_TIMEOUT_MS);
    setDownloadState({ status: "preparing", documentId: document.id, message: "Preparing the original PDF for a fresh download click..." });
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/pdf`, {
        headers: { accept: "application/pdf" },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await readJson(response);
        throw new DocumentResponseError(messageForResponse(response, body, "The original PDF could not be downloaded"));
      }
      const blob = await readBoundedPdf(response);
      if (!ownsDownloadRequest(revision, document.id, controller)) return;
      const objectUrl = URL.createObjectURL(blob);
      const filename = safeDownloadFilename(document.filename);
      downloadObjectUrl.current = objectUrl;
      downloadObjectUrlExpiry.current = window.setTimeout(() => {
        const ownsPreparedUrl = downloadObjectUrl.current === objectUrl;
        if (ownsPreparedUrl) revokeDownloadObjectUrl();
        if (ownsPreparedUrl && mounted.current && selectedId === document.id) {
          setDownloadState({ status: "idle", documentId: document.id, message: "The prepared PDF link expired. Prepare it again to download the original." });
        }
      }, PREPARED_DOWNLOAD_LIFETIME_MS);
      setDownloadState({
        status: "ready",
        documentId: document.id,
        objectUrl,
        filename,
        message: "The PDF is ready. Select the prepared download link below. The application cannot confirm whether your browser saved the file.",
      });
    } catch (error) {
      if (!ownsDownloadRequest(revision, document.id, controller)) return;
      setDownloadState({
        status: "error",
        documentId: document.id,
        message: controller.signal.aborted
          ? timedOut
            ? "Preparing the original PDF download took too long. Try again or use the new-tab fallback."
            : "Preparing the original PDF download was interrupted. Try again or use the new-tab fallback."
          : error instanceof Error ? error.message : "The original PDF could not be downloaded.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (downloadRequest.current === controller) downloadRequest.current = null;
    }
  }

  function activatePreparedDownload(document: UploadedDocument, objectUrl: string) {
    if (selectedId !== document.id || downloadObjectUrl.current !== objectUrl) return;
    setDownloadState((current) => current.status === "ready" && current.documentId === document.id && current.objectUrl === objectUrl
      ? { ...current, message: "The prepared download link was activated. Check your browser's download controls, or use the new-tab fallback if no file appears." }
      : current);
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

  async function loadSummary(id: string) {
    if (summaryBusy) return;
    const revision = summaryRevision.current + 1;
    summaryRevision.current = revision;
    summaryRequest.current?.abort();
    const controller = new AbortController();
    summaryRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    setDetailState((current) => current.status === "initial" ? current : {
      ...current,
      summary: { status: "loading", summary: current.summary.summary },
    });
    try {
      const summary = await getStoredSummary(id, controller.signal);
      if (!ownsSummaryRequest(revision, id, controller)) return;
      setDetailState((current) => ({ ...current, summary: timedOut && summary.status === "error"
        ? { status: "error", summary: current.summary.summary, message: "Loading the saved summary took too long. Reload summary to try again." }
        : summary.status === "error"
          ? { ...summary, summary: current.summary.summary }
          : summary }));
    } finally {
      window.clearTimeout(timeout);
      if (summaryRequest.current === controller) summaryRequest.current = null;
    }
  }

  async function reconcileSummary(id: string, revision: number, controller: AbortController, message: string) {
    if (!ownsSummaryRequest(revision, id, controller)) return;
    setDetailState((current) => ({ ...current, summary: { status: "uncertain", summary: current.summary.summary, message } }));
    const reconciliation = new AbortController();
    summaryRequest.current = reconciliation;
    const timeout = window.setTimeout(() => reconciliation.abort(), READ_TIMEOUT_MS);
    try {
      const saved = await getStoredSummary(id, reconciliation.signal);
      if (!isCurrentSummary(revision, id, reconciliation)) return;
      if (saved.status === "loaded") {
        setDetailState((current) => ({ ...current, summary: saved }));
      } else {
        setDetailState((current) => ({
          ...current,
          summary: {
            status: "uncertain",
            summary: current.summary.summary,
            message: saved.status === "error"
              ? `${message} The saved summary could not be confirmed; reload summary before generating again.`
              : `${message} No saved summary was found. Reload summary before choosing another explicit generation attempt.`,
          },
        }));
      }
    } finally {
      window.clearTimeout(timeout);
      if (summaryRequest.current === reconciliation) summaryRequest.current = null;
    }
  }

  async function generateSummary(document: UploadedDocument) {
    if (!detailState.extraction || summaryBusy || pipelineBusy) return;
    const revision = summaryRevision.current + 1;
    summaryRevision.current = revision;
    summaryRequest.current?.abort();
    const controller = new AbortController();
    summaryRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, SUMMARY_TIMEOUT_MS);
    setDetailState((current) => ({ ...current, summary: { status: "generating", summary: current.summary.summary, message: "Generating a source-grounded summary from saved extracted text..." } }));
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/summary`, { method: "POST", signal: controller.signal });
      const body = await readJson(response);
      if (!isCurrentSummary(revision, document.id, controller)) return;
      if (!response.ok) {
        const error = documentError(body);
        if (error?.kind === "summary_in_progress") {
          setDetailState((current) => ({ ...current, summary: { status: "in_progress", summary: current.summary.summary, message: error.message } }));
        } else {
          setDetailState((current) => ({ ...current, summary: { status: "error", summary: current.summary.summary, message: messageForResponse(response, body, "Summary generation could not be completed") } }));
        }
        return;
      }
      if (!isSummaryResponse(body) || body.summary.documentId !== document.id) {
        await reconcileSummary(document.id, revision, controller, "Summary generation returned an unexpected response. Checking saved summary without generating again.");
        return;
      }
      setDetailState((current) => ({ ...current, summary: { status: "loaded", summary: body.summary } }));
    } catch {
      await reconcileSummary(
        document.id,
        revision,
        controller,
        timedOut
          ? "Summary generation took too long and may have completed. Checking saved summary without generating again."
          : "Summary generation may have been interrupted. Checking saved summary without generating again.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (summaryRequest.current === controller) summaryRequest.current = null;
    }
  }

  async function loadQuestions(id: string) {
    if (questionBusy) return;
    const revision = questionRevision.current + 1;
    questionRevision.current = revision;
    questionRequest.current?.abort();
    const controller = new AbortController();
    questionRequest.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, READ_TIMEOUT_MS);
    setDetailState((current) => current.status === "initial" ? current : {
      ...current,
      questions: { status: "loading", questions: current.questions.questions, submittedQuestion: current.questions.submittedQuestion },
    });
    try {
      const questions = await getStoredQuestions(id, controller.signal);
      if (!ownsQuestionRequest(revision, id, controller)) return;
      setDetailState((current) => ({
        ...current,
        questions: timedOut && questions.status === "error"
          ? { status: "error", questions: current.questions.questions, message: "Loading saved questions took too long. Reload question history to try again." }
          : questions.status === "error"
            ? { ...questions, questions: current.questions.questions }
            : questions,
      }));
    } finally {
      window.clearTimeout(timeout);
      if (questionRequest.current === controller) questionRequest.current = null;
    }
  }

  async function reconcileQuestion(
    id: string,
    revision: number,
    submittedQuestion: string,
    status: "in_progress" | "uncertain",
    message: string,
  ) {
    if (selectedId !== id || questionRevision.current !== revision || !mounted.current) return;
    setDetailState((current) => ({ ...current, questions: { status, questions: current.questions.questions, message, submittedQuestion } }));
    const controller = new AbortController();
    questionRequest.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    try {
      const saved = await getStoredQuestions(id, controller.signal);
      if (!isCurrentQuestion(revision, id, controller)) return;
      if (saved.status === "loaded" || saved.status === "empty") {
        const matching = saved.questions.some((question) => normalizedQuestion(question.question) === normalizedQuestion(submittedQuestion));
        if (matching) {
          setDetailState((current) => ({ ...current, questions: saved }));
        } else {
          setDetailState((current) => ({
            ...current,
            questions: {
              status,
              questions: saved.questions,
              submittedQuestion,
              message: `${message} No matching saved result was found. Reload question history before another explicit attempt.`,
            },
          }));
        }
      } else {
        setDetailState((current) => ({
          ...current,
          questions: {
            status,
            questions: current.questions.questions,
            submittedQuestion,
            message: `${message} The saved question history could not be read. Reload question history before another explicit attempt.`,
          },
        }));
      }
    } finally {
      window.clearTimeout(timeout);
      if (questionRequest.current === controller) questionRequest.current = null;
    }
  }

  async function askQuestion(document: UploadedDocument) {
    if (!detailState.extraction || questionBusy || detailState.questions.status === "in_progress" || pipelineBusy) return;
    const validationError = questionInputError(questionInput);
    if (validationError) {
      setQuestionInputMessage(validationError);
      return;
    }
    const submittedQuestion = questionInput;
    const revision = questionRevision.current + 1;
    questionRevision.current = revision;
    questionRequest.current?.abort();
    const controller = new AbortController();
    questionRequest.current = controller;
    let timedOut = false;
    let receivedResponse = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, QUESTION_TIMEOUT_MS);
    setQuestionInputMessage(null);
    setDetailState((current) => ({
      ...current,
      questions: { status: "asking", questions: current.questions.questions, submittedQuestion, message: "Asking from this PDF's saved extracted text..." },
    }));
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(document.id)}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: submittedQuestion }),
        signal: controller.signal,
      });
      receivedResponse = true;
      const body = await readJson(response);
      if (!isCurrentQuestion(revision, document.id, controller)) return;
      if (!response.ok) {
        const error = documentError(body);
        if (error?.kind === "question_in_progress") {
          await reconcileQuestion(document.id, revision, submittedQuestion, "in_progress", `${error.message} Checking saved question history without generating again.`);
        } else {
          const accessMessage = nonApplicationQuestionAccessMessage(response, body);
          setDetailState((current) => ({
            ...current,
            questions: {
              status: "error",
              questions: current.questions.questions,
              submittedQuestion,
              accessDenied: Boolean(accessMessage),
              message: accessMessage ?? messageForResponse(response, body, "Question could not be completed"),
            },
          }));
        }
        return;
      }
      if (!isQuestionResponse(body) || body.question.documentId !== document.id) {
        await reconcileQuestion(document.id, revision, submittedQuestion, "uncertain", "Questioning returned an unexpected response. Checking saved question history without generating again.");
        return;
      }
      setDetailState((current) => ({ ...current, questions: { status: "loaded", questions: mergeQuestions(current.questions.questions, body.question) } }));
      setQuestionInput("");
    } catch {
      if (!mounted.current || questionRevision.current !== revision || selectedId !== document.id) return;
      await reconcileQuestion(
        document.id,
        revision,
        submittedQuestion,
        "uncertain",
        timedOut || !receivedResponse
          ? "Questioning was interrupted or timed out and may have completed. Checking saved question history without generating again."
          : "Questioning could not be completed. Checking saved question history without generating again.",
      );
    } finally {
      window.clearTimeout(timeout);
      if (questionRequest.current === controller) questionRequest.current = null;
    }
  }

  async function resumeProcessing(document: UploadedDocument) {
    if (pipelineBusy || summaryBusy) return;
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
        // The earlier read can only report `extraction_not_found` before this
        // successful extraction. It is now safe to present the same absent
        // summary as not generated; this does not start a summary request.
        results = {
          ...results,
          extraction: body.extraction,
          summary: results.summary.status === "missing_extraction" ? { status: "not_generated", summary: null } : results.summary,
          questions: results.questions.status === "missing_extraction"
            ? await getStoredQuestions(document.id, controller.signal)
            : results.questions,
        };
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
      setDetailState({ status: "initial", extraction: null, metadata: null, summary: { status: "initial", summary: null }, questions: initialQuestionState() });
      setQuestionInput("");
      setQuestionInputMessage(null);
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
      summaryRequest.current?.abort();
      questionRequest.current?.abort();
      downloadRequest.current?.abort();
      revokeDownloadObjectUrl();
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
          <button
            type="button"
            className="paper-link"
            data-download-original
            onClick={() => void prepareOriginalDownload(selectedDocument)}
            disabled={downloadState.status === "preparing" && downloadState.documentId === selectedDocument.id}
          >
            {downloadState.status === "preparing" && downloadState.documentId === selectedDocument.id ? "Preparing download..." : "Prepare original PDF download"}
          </button>
        </div>
        {downloadState.documentId === selectedDocument.id && downloadState.message && <p className={downloadState.status === "error" ? "search-feedback search-feedback--error" : "search-feedback"} role={downloadState.status === "error" ? "alert" : "status"}>{downloadState.message}</p>}
        <div className="download-actions" aria-label="Original PDF download options">
          {downloadState.status === "ready" && downloadState.documentId === selectedDocument.id && downloadState.objectUrl && downloadState.filename && <a
            className="paper-link"
            data-download-prepared
            href={downloadState.objectUrl}
            download={downloadState.filename}
            onClick={() => activatePreparedDownload(selectedDocument, downloadState.objectUrl ?? "")}
          >
            Download prepared PDF
          </a>}
          <a
            className="paper-link"
            data-download-new-tab
            href={`/api/documents/${encodeURIComponent(selectedDocument.id)}/pdf`}
            target="_blank"
            rel="noopener"
          >
            Open original PDF in a new tab
          </a>
        </div>
        <p className="results-note download-note">The prepared link remains available for one minute and uses a fresh browser click. The new-tab fallback uses your normal signed-in session; its viewer may offer its own save control.</p>
        <dl className="paper-metadata">
          <div><dt>Uploaded</dt><dd><time dateTime={selectedDocument.uploadedAt}>{formatTime(selectedDocument.uploadedAt)}</time></dd></div>
          <div><dt>Size</dt><dd>{formatBytes(selectedDocument.byteCount)}</dd></div>
          <div><dt>Status</dt><dd>{selectionLabel(detailState.extraction, detailState.metadata)}</dd></div>
        </dl>
        {detailState.status === "loading" && <p className="search-feedback" role="status">Reading saved text, metadata, and summary...</p>}
        {detailState.status === "error" && <p className="search-feedback search-feedback--error" role="alert">{detailState.message}</p>}
        {detailState.status !== "loading" && !(pipelineBusy && processingDocumentId === selectedDocument.id) && !(detailState.extraction && detailState.metadata) && <button type="button" className="save-button" onClick={() => void resumeProcessing(selectedDocument)}>Resume processing</button>}
        <section className="document-summary" aria-labelledby="document-summary-title">
          <div className="summary-heading">
            <div><p className="eyebrow">Source-grounded summary</p><h4 id="document-summary-title">Summary</h4></div>
            <button type="button" className="reload-button" data-summary-reload onClick={() => void loadSummary(selectedDocument.id)} disabled={detailState.summary.status === "loading" || summaryBusy}>Reload summary</button>
          </div>
          {detailState.status === "loading" && <p className="search-feedback" role="status">Loading saved summary...</p>}
          {detailState.status !== "loading" && !detailState.extraction && <p className="search-feedback" role="status">Text extraction is required before a summary can be generated.</p>}
          {detailState.status !== "loading" && detailState.extraction && detailState.summary.status === "initial" && <p className="search-feedback" role="status">Summary status has not loaded yet.</p>}
          {detailState.extraction && detailState.summary.status === "loading" && <p className="search-feedback" role="status">Loading saved summary...</p>}
          {detailState.extraction && detailState.summary.status === "missing_extraction" && <p className="search-feedback" role="status">Text extraction is required before a summary can be generated.</p>}
          {detailState.extraction && detailState.summary.status === "not_generated" && <>
            <p className="results-note">No summary has been generated. Generation is explicit and uses saved extracted text; metadata is not required.</p>
            <button type="button" className="save-button" data-generate-summary onClick={() => void generateSummary(selectedDocument)} disabled={pipelineBusy || summaryBusy}>Generate summary</button>
          </>}
          {detailState.extraction && detailState.summary.status === "generating" && <p className="search-feedback" role="status">{detailState.summary.message}</p>}
          {detailState.extraction && detailState.summary.status === "in_progress" && <p className="search-feedback" role="status">{detailState.summary.message} Reload summary to check for the saved result.</p>}
          {detailState.extraction && detailState.summary.status === "error" && <>
            <p className="search-feedback search-feedback--error" role="alert">{detailState.summary.message}</p>
            <button type="button" className="save-button" data-generate-summary onClick={() => void generateSummary(selectedDocument)} disabled={pipelineBusy || summaryBusy}>Generate summary</button>
          </>}
          {detailState.extraction && detailState.summary.status === "uncertain" && <>
            <p className="search-feedback search-feedback--error" role="alert">{detailState.summary.message}</p>
            <button type="button" className="save-button" data-generate-summary onClick={() => void generateSummary(selectedDocument)} disabled={pipelineBusy || summaryBusy}>Generate summary again</button>
          </>}
          {detailState.summary.summary && <SummaryContent summary={detailState.summary.summary} />}
        </section>
        <section className="document-questions" aria-labelledby="document-questions-title">
          <div className="summary-heading">
            <div><p className="eyebrow">Source-grounded PDF questions</p><h4 id="document-questions-title">Questions and answers</h4></div>
            <button type="button" className="reload-button" data-question-reload onClick={() => void loadQuestions(selectedDocument.id)} disabled={detailState.questions.status === "loading" || questionBusy}>Reload question history</button>
          </div>
          <p className="results-note">Each question is answered independently from this PDF&apos;s saved extracted text. Previous answers are not conversational context; metadata and summaries are not required.</p>
          {detailState.status === "loading" && <p className="search-feedback" role="status">Loading saved questions...</p>}
          {detailState.status !== "loading" && !detailState.extraction && <p className="search-feedback" role="status">Text extraction is required before asking a question.</p>}
          {detailState.extraction && <form className="question-form" onSubmit={(event) => { event.preventDefault(); void askQuestion(selectedDocument); }} noValidate>
            <label htmlFor="document-question-input">Question about this PDF</label>
            <div className="question-controls">
              <textarea id="document-question-input" value={questionInput} onChange={(event) => { setQuestionInput(event.target.value); setQuestionInputMessage(null); }} aria-describedby="document-question-help document-question-error" aria-invalid={questionInputMessage ? true : undefined} placeholder="Ask about the saved extracted text" rows={3} disabled={questionBusy || detailState.questions.status === "in_progress"} />
              <button type="submit" className="save-button" data-question-submit disabled={questionBusy || detailState.questions.status === "in_progress" || pipelineBusy}>{questionBusy ? "Asking..." : "Ask"}</button>
            </div>
            <p id="document-question-help" className="search-help">Use a trimmed question of up to 2 KiB UTF-8. Asking is explicit and is never retried automatically.</p>
            {questionInputMessage && <p id="document-question-error" className="search-feedback search-feedback--error" role="alert">{questionInputMessage}</p>}
          </form>}
          {detailState.extraction && detailState.questions.status === "initial" && <p className="search-feedback" role="status">Question history has not loaded yet.</p>}
          {detailState.extraction && detailState.questions.status === "loading" && <p className="search-feedback" role="status">Loading saved questions...</p>}
          {detailState.extraction && detailState.questions.status === "missing_extraction" && <p className="search-feedback" role="status">Text extraction is required before asking a question.</p>}
          {detailState.extraction && detailState.questions.status === "empty" && <p className="search-feedback" role="status">No saved questions yet. Ask an explicit question to create one.</p>}
          {detailState.extraction && detailState.questions.status === "asking" && <p className="search-feedback" role="status">{detailState.questions.message}</p>}
          {detailState.extraction && detailState.questions.status === "in_progress" && <p className="search-feedback" role="status">{detailState.questions.message} Reload question history to check for the saved result.</p>}
          {detailState.extraction && detailState.questions.status === "uncertain" && <p className="search-feedback search-feedback--error" role="alert">{detailState.questions.message} The submitted question remains in the input; no additional question was sent.</p>}
          {detailState.extraction && detailState.questions.status === "error" && <>
            <p className="search-feedback search-feedback--error" role="alert">{detailState.questions.message}</p>
            {detailState.questions.accessDenied && <div className="question-access-recovery">
              <p className="results-note">After signing in again through the private site&apos;s normal access flow, use this read-only reload to confirm saved questions. It will not ask the question again.</p>
              <button type="button" className="reload-button" data-question-access-reload onClick={() => void loadQuestions(selectedDocument.id)} disabled={questionBusy}>Reload question history</button>
            </div>}
          </>}
          {detailState.questions.questions.length > 0 && <>
            <p className="results-note">Saved questions, newest first. A reload uses GET only and does not ask a question.</p>
            <ol className="question-list">{detailState.questions.questions.map((question) => <li key={question.id}><QuestionCard question={question} /></li>)}</ol>
          </>}
        </section>
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
