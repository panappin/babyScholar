import { DocumentError } from "./document-validation.js";
import { IntegrationError } from "./integration-errors.js";

type Stage = "metadata" | "summary" | "question";
export const GENERATION_DEADLINE_MS = 25_000;
export const CORRECTIVE_INSTRUCTION = "The previous attempt returned an invalid or empty result. Produce a fresh complete response in the requested format and keep it concise. For bibliographic fields that are absent or ambiguous, use null. State uncertainty clearly when needed.";

/** One claim, one overall budget, at most one correction of a known invalid output. */
export async function generateWithRecovery<T>(
  stage: Stage,
  request: (remainingMs: number, correction: string) => Promise<{ model: string; output: unknown }>,
  validate: (output: unknown) => T,
  assertOwner: () => Promise<void>,
  budgetMs = GENERATION_DEADLINE_MS,
): Promise<{ model: string; output: T }> {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await assertOwner();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new IntegrationError("timeout", "The generation deadline expired.");
    try {
      const provider = await request(remaining, attempt === 2 ? CORRECTIVE_INSTRUCTION : "");
      const output = validate(provider.output);
      if (Date.now() >= deadline) throw new IntegrationError("timeout", "The generation deadline expired.");
      console.info(JSON.stringify({ event: "generation_completed", stage, attempts: attempt }));
      return { model: provider.model, output };
    } catch (error) {
      const recoverable = (error instanceof IntegrationError && error.kind === "malformed_response"
        && (error.upstreamStatus === undefined || error.upstreamStatus < 400))
        || (error instanceof DocumentError && error.kind === `${stage}_invalid_response`);
      console.warn(JSON.stringify({ event: "generation_attempt_failed", stage, attempt,
        kind: error instanceof IntegrationError || error instanceof DocumentError ? error.kind : "internal_failure",
        correctiveAttempt: recoverable && attempt === 1 && Date.now() < deadline }));
      if (!recoverable) throw error;
      if (attempt === 2) throw new DocumentError(`${stage}_invalid_response`, 502,
        `The ${stage} result failed format validation after two attempts. Your PDF and text remain available. You can explicitly retry this stage.`);
    }
  }
  throw new IntegrationError("timeout", "The generation deadline expired.");
}
