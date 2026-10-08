import type { LibraryErrorResponse, ListPapersResponse, SavedPaper, SavePaperResponse } from "./library-types.js";
import type { PaperSearchResult } from "./paper-search-types.js";
import type { WorkerEnv } from "./storage.js";
import { LibraryError, readSavePaper } from "./library-validation.js";

interface PaperRow {
  id: string;
  source: "arxiv";
  arxiv_id: string;
  title: string;
  authors_json: string;
  year: number | null;
  abstract: string;
  url: string | null;
  pdf_url: string | null;
  saved_at: string;
}

const COLUMNS = "id, source, arxiv_id, title, authors_json, year, abstract, url, pdf_url, saved_at";

function savedPaper(row: PaperRow): SavedPaper {
  const authors: unknown = JSON.parse(row.authors_json);
  if (!Array.isArray(authors) || !authors.every((author) => typeof author === "string")) {
    throw new Error("Invalid stored author metadata");
  }
  return {
    id: row.id, source: row.source, arxivId: row.arxiv_id,
    title: row.title, authors, year: row.year, abstract: row.abstract,
    url: row.url, pdfUrl: row.pdf_url, savedAt: row.saved_at,
  };
}

async function savePaper(db: D1Database, paper: PaperSearchResult): Promise<SavePaperResponse> {
  // Unique source identity resolves races in D1. A batch is transactional, so
  // every caller reads the same first-saved row without overwriting metadata.
  const [insert, existing] = await db.batch<PaperRow>([
    db.prepare(`INSERT INTO papers (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source, arxiv_id) DO NOTHING`).bind(
      crypto.randomUUID(), "arxiv", paper.id, paper.title, JSON.stringify(paper.authors),
      paper.year, paper.abstract, paper.url, paper.pdfUrl, new Date().toISOString(),
    ),
    db.prepare(`SELECT ${COLUMNS} FROM papers WHERE source = ? AND arxiv_id = ?`).bind("arxiv", paper.id),
  ]);
  if (!insert.success || !existing.success || existing.results.length !== 1) throw new Error("Paper save failed");
  return { paper: savedPaper(existing.results[0]), created: insert.meta.changes === 1 };
}

async function listPapers(db: D1Database): Promise<ListPapersResponse> {
  const rows = await db.prepare(`SELECT ${COLUMNS} FROM papers ORDER BY saved_at DESC, id DESC`).all<PaperRow>();
  if (!rows.success) throw new Error("Paper list failed");
  return { papers: rows.results.map(savedPaper) };
}

export async function handleLibrary(request: Request, env: WorkerEnv): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": "no-store" };
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      headers.Allow = "GET, POST";
      throw new LibraryError("method_not_allowed", 405, "Use GET or POST for the paper library.");
    }
    // Validate even duplicates before any query. Client IDs/source/timestamps
    // cannot be supplied or override the server-assigned library fields.
    const body = request.method === "POST" ? await readSavePaper(request) : undefined;
    if (!env.DB) throw new LibraryError("storage_unavailable", 503, "The paper library database is unavailable.");
    if (body) {
      const result = await savePaper(env.DB, body.paper);
      return Response.json(result, { status: result.created ? 201 : 200, headers });
    }
    return Response.json(await listPapers(env.DB), { headers });
  } catch (error) {
    const failure = error instanceof LibraryError ? error
      : new LibraryError("database_failure", 503, "The paper library database operation failed.");
    const body: LibraryErrorResponse = { error: { kind: failure.kind, message: failure.message } };
    return Response.json(body, { status: failure.status, headers });
  }
}
