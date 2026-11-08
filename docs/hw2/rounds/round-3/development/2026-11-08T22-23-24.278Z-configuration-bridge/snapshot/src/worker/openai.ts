import { IntegrationError } from "./integration-errors.js";
import type { WorkerEnv } from "./storage.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 15_000;
const PROBE_PROMPT = "Reply with the word OK.";

type FetchImplementation = typeof fetch;

export interface OpenAiProbeResult {
  provider: "openai";
  model: string;
  text: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractResponseText(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (typeof payload !== "object" || payload === null) {
    throw new IntegrationError("malformed_response", "OpenAI returned an invalid JSON response.");
  }
  const record = payload as Record<string, unknown>;
  const direct = readString(record.output_text);
  if (direct) return direct;
  if (!Array.isArray(record.output)) return undefined;
  const text = record.output.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (typeof part !== "object" || part === null) return [];
      const partRecord = part as Record<string, unknown>;
      return partRecord.type === "output_text" ? [readString(partRecord.text)] : [];
    });
  }).filter((part): part is string => Boolean(part));
  return text.join("\n").trim() || undefined;
}

function errorFields(payload: unknown) {
  if (typeof payload !== "object" || payload === null) return "";
  const error = (payload as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return "";
  const record = error as Record<string, unknown>;
  return [record.code, record.type, record.message].filter((value) => typeof value === "string").join(" ").toLowerCase();
}

function classifyOpenAiFailure(status: number, payload: unknown) {
  const fields = errorFields(payload);
  if (status === 401) return "authentication" as const;
  if (status === 429) return "quota_or_rate_limit" as const;
  if (status === 403) return /model|access|permission/u.test(fields) ? "model_access" as const : "authentication" as const;
  if ((status === 400 || status === 404) && /model|not.?found|unsupported/u.test(fields)) return "model_access" as const;
  return "upstream_error" as const;
}

export async function probeOpenAi(
  env: WorkerEnv,
  fetchImplementation: FetchImplementation = fetch,
  timeoutMs = OPENAI_TIMEOUT_MS,
): Promise<OpenAiProbeResult> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new IntegrationError("missing_configuration", "OPENAI_API_KEY is not configured for local development.");
  }

  const model = env.OPENAI_MODEL?.trim() || "gpt-6-luna";
  const request: Record<string, unknown> = {
    model,
    input: PROBE_PROMPT,
    store: false,
  };
  // gpt-6-luna is the default probe model. Other configured models receive only
  // the portable Responses parameters instead of an unsupported reasoning option.
  if (model === "gpt-6-luna") {
    request.reasoning = { effort: "none" };
    request.max_output_tokens = 256;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    // One deliberate Responses request. There is no automatic retry.
    response = await fetchImplementation(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new IntegrationError("timeout", `OpenAI did not respond within ${timeoutMs}ms.`);
    }
    throw new IntegrationError("network_failure", "Could not reach the OpenAI API.");
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IntegrationError("malformed_response", "OpenAI returned a non-JSON response.", response.status);
  }
  if (!response.ok) {
    const kind = classifyOpenAiFailure(response.status, payload);
    throw new IntegrationError(kind, `OpenAI returned HTTP ${response.status}.`, response.status);
  }

  const record = payload as Record<string, unknown>;
  if (record.status !== "completed") {
    throw new IntegrationError("malformed_response", "OpenAI did not return a completed response.");
  }
  const text = extractResponseText(payload);
  if (!text) {
    throw new IntegrationError("malformed_response", "OpenAI completed without usable text.");
  }
  return { provider: "openai", model, text };
}
