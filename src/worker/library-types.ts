import type { PaperSearchResult } from "./paper-search-types.js";

export interface SavePaperRequest {
  paper: PaperSearchResult;
}

export interface SavedPaper extends Omit<PaperSearchResult, "id"> {
  /** Independent application UUID, never an arXiv identifier. */
  id: string;
  source: "arxiv";
  /** Normalized provider identifier, with any vN suffix removed. */
  arxivId: string;
  /** Server-assigned UTC ISO 8601 timestamp from the first successful save. */
  savedAt: string;
}

export interface SavePaperResponse {
  paper: SavedPaper;
  created: boolean;
}

export interface ListPapersResponse {
  papers: SavedPaper[];
}

export type LibraryErrorKind = "invalid_request" | "unsupported_media_type" | "body_too_large"
  | "request_timeout" | "method_not_allowed" | "storage_unavailable" | "database_failure";

export interface LibraryErrorResponse {
  error: { kind: LibraryErrorKind; message: string };
}
