import { probeArxiv } from "./arxiv.js";
import { integrationFailureStatus, publicIntegrationError } from "./integration-errors.js";
import { probeOpenAi } from "./openai.js";
import type { WorkerEnv } from "./storage.js";

function enabledForLocalRequest(request: Request, env: WorkerEnv) {
  const url = new URL(request.url);
  return env.LOCAL_INTEGRATION_PROBE === "true" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

export async function handleLocalIntegrationProbe(request: Request, env: WorkerEnv): Promise<Response> {
  if (!enabledForLocalRequest(request, env)) return new Response("Not Found", { status: 404 });
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });

  const url = new URL(request.url);
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const failure = (provider: "arxiv" | "openai", error: unknown) => {
    const publicError = publicIntegrationError(error);
    return Response.json(
      {
        status: "error",
        provider,
        ...(provider === "openai" ? { model: env.OPENAI_MODEL?.trim() || "gpt-6-luna" } : {}),
        error: publicError,
      },
      { status: integrationFailureStatus(publicError.kind) },
    );
  };

  if (url.pathname === "/api/__local/integrations/arxiv") {
    try {
      return Response.json({ status: "ok", result: await probeArxiv() });
    } catch (error) {
      return failure("arxiv", error);
    }
  }
  if (url.pathname === "/api/__local/integrations/openai") {
    try {
      return Response.json({ status: "ok", result: await probeOpenAi(env) });
    } catch (error) {
      return failure("openai", error);
    }
  }

  return new Response("Not Found", { status: 404 });
}
