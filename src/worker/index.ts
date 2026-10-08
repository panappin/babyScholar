import { bucketStatus, databaseStatus, type WorkerEnv } from "./storage.js";
import { handleLocalProbe } from "./local-probe.js";
import { handleLocalIntegrationProbe } from "./local-integration-probe.js";
import { paperSearchFailureStatus, publicPaperSearchError, searchArxivPapers } from "./arxiv.js";
import { handleLibrary } from "./library.js";

const healthResponse = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

export async function handlePaperSearchRequest(
  request: Request,
  search: typeof searchArxivPapers = searchArxivPapers,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
  }
  const url = new URL(request.url);
  try {
    return Response.json(await search(url.searchParams.get("q")), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: publicPaperSearchError(error) }, {
      status: paperSearchFailureStatus(error),
      headers: { "cache-control": "no-store" },
    });
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return healthResponse();
    }

    if (request.method === "GET" && url.pathname === "/api/storage/status") {
      const [d1, r2] = await Promise.all([databaseStatus(env), bucketStatus(env)]);
      const ok = d1.status === "ok" && r2.status === "ok";
      return Response.json(
        { status: ok ? "ok" : "error", d1, r2 },
        { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/api/papers/search") {
      return handlePaperSearchRequest(request);
    }

    if (url.pathname === "/api/library/papers") {
      return handleLibrary(request, env);
    }

    if (url.pathname.startsWith("/api/__local/storage-probe/")) {
      return handleLocalProbe(request, env);
    }

    if (url.pathname.startsWith("/api/__local/integrations/")) {
      return handleLocalIntegrationProbe(request, env);
    }

    // Sites supplies static assets beside the Worker; local Vite serves them itself.
    if (!url.pathname.startsWith("/api/") && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
