// Minimal local-only reproduction: no application imports, storage, or providers.
const LIMIT = 262_144;

export default {
  async fetch(request) {
    if (request.method === "GET") return Response.json({ status: "ok" });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "missing_body" }, { status: 400 });
    const mode = new URL(request.url).searchParams.get("mode") ?? "cancel";
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 10_000);
    });
    let bytes = 0;
    let complete = false;
    let status = 200;
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline]);
        if (chunk.done) { complete = true; break; }
        bytes += chunk.value.byteLength;
        if (bytes > LIMIT) { status = 413; break; }
      }
    } catch {
      status = 408;
    } finally {
      if (!complete && mode === "cancel") {
        await Promise.race([reader.cancel(), deadline]).catch(() => undefined);
      }
      clearTimeout(timer);
      reader.releaseLock();
    }
    return Response.json({ status: status === 200 ? "ok" : "rejected", bytes }, {
      status, headers: { "cache-control": "no-store" },
    });
  },
};
