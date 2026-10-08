export interface PaperSearchResult {
  /** Stable arXiv identifier without a version suffix, for example `2401.01234` or `cond-mat/0011267`. */
  id: string;
  title: string;
  authors: string[];
  /** The year in Atom `published` (the paper's first submission), not Atom `updated`. */
  year: number | null;
  abstract: string;
  /** Canonical HTTPS abstract URL when arXiv provided a trusted alternate link. */
  url: string | null;
  /** Canonical HTTPS PDF URL when arXiv provided a trusted PDF link. */
  pdfUrl: string | null;
}

export interface PaperSearchResponse {
  provider: "arxiv";
  /** The normalized plain-text query supplied by the caller, not the arXiv query expression. */
  query: string;
  papers: PaperSearchResult[];
}

export type PaperSearchFailureKind = "invalid_query" | "timeout" | "upstream";

export interface PaperSearchErrorPayload {
  kind: PaperSearchFailureKind;
  message: string;
}

export interface PaperSearchFailureResponse {
  error: PaperSearchErrorPayload;
}
