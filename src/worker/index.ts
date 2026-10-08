import { bucketStatus, databaseStatus, type WorkerEnv } from "./storage.js";
import { handleLocalProbe } from "./local-probe.js";
import { handleLocalIntegrationProbe } from "./local-integration-probe.js";

const healthResponse = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

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

    if (url.pathname.startsWith("/api/__local/storage-probe/")) {
      return handleLocalProbe(request, env);
    }

    if (url.pathname.startsWith("/api/__local/integrations/")) {
      return handleLocalIntegrationProbe(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};
