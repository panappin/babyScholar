import assert from "node:assert/strict";
import { probeArxiv } from "../.wrangler/check-worker/arxiv.js";
import { IntegrationError } from "../.wrangler/check-worker/integration-errors.js";
import { probeOpenAi } from "../.wrangler/check-worker/openai.js";

async function expectKind(operation, kind) {
  await assert.rejects(operation, (error) => error instanceof IntegrationError && error.kind === kind);
}

let openAiFetchCalled = false;
await expectKind(
  () => probeOpenAi({ OPENAI_MODEL: "gpt-6-luna" }, async () => {
    openAiFetchCalled = true;
    throw new Error("A missing key must fail before fetch.");
  }),
  "missing_configuration",
);
assert.equal(openAiFetchCalled, false);

const arxivErrorFeed = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Error</title><summary>diagnostic upstream failure</summary></entry></feed>`;
await expectKind(
  () => probeArxiv(async () => new Response(arxivErrorFeed, { status: 200 }), 100),
  "upstream_error",
);

await expectKind(
  () => probeArxiv(async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  }), 10),
  "timeout",
);

const noSecretTestKey = "x".repeat(24);
let defaultRequest;
await probeOpenAi(
  { OPENAI_API_KEY: noSecretTestKey, OPENAI_MODEL: "gpt-6-luna" },
  async (_url, init) => {
    defaultRequest = JSON.parse(init.body);
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    });
  },
);
assert.deepEqual(defaultRequest, {
  model: "gpt-6-luna",
  input: "Reply with the word OK.",
  store: false,
  reasoning: { effort: "none" },
  max_output_tokens: 256,
});

let configuredModelRequest;
await probeOpenAi(
  { OPENAI_API_KEY: noSecretTestKey, OPENAI_MODEL: "a-configured-model" },
  async (_url, init) => {
    configuredModelRequest = JSON.parse(init.body);
    return Response.json({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "usable" }] }],
    });
  },
);
assert.deepEqual(configuredModelRequest, {
  model: "a-configured-model",
  input: "Reply with the word OK.",
  store: false,
});

console.log("Offline integration checks: missing key, arXiv error feed, timeout, and Responses request shapes: PASS");
