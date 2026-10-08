import {
  deleteProbe,
  deleteProbeObject,
  insertProbe,
  putProbeObject,
  readProbe,
  readProbeObject,
  type WorkerEnv,
} from "./storage.js";

export async function handleLocalProbe(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  // Absent by default. Enable only in the isolated local verification process.
  if (
    env.LOCAL_STORAGE_PROBE !== "true" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) {
    return new Response("Forbidden", { status: 403 });
  }

  const id = url.pathname.slice("/api/__local/storage-probe/".length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    return new Response("Invalid probe ID", { status: 400 });
  }

  try {
    if (request.method === "PUT") {
      let input: { value?: unknown; bytes?: unknown };
      try {
        input = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      if (
        !input || typeof input.value !== "string" || input.value.length > 1024 ||
        !Array.isArray(input.bytes) || input.bytes.length > 1024 ||
        !input.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ) {
        return new Response("Expected a small value and byte array", { status: 400 });
      }
      // INSERT deliberately refuses an existing ID. Verification must never reseed.
      await insertProbe(env, id, input.value);
      await putProbeObject(env, id, new Uint8Array(input.bytes));
      return new Response(null, { status: 201 });
    }
    if (request.method === "GET") {
      const [row, bytes] = await Promise.all([readProbe(env, id), readProbeObject(env, id)]);
      // Return both independently so cleanup verification detects partial leftovers.
      return Response.json({ row, bytes }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "DELETE") {
      await Promise.all([deleteProbe(env, id), deleteProbeObject(env, id)]);
      return new Response(null, { status: 204 });
    }
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, PUT, DELETE" } });
  } catch {
    return Response.json({ error: "probe_operation_failed" }, { status: 503 });
  }
}
