export type IntegrationFailureKind =
  | "missing_configuration"
  | "authentication"
  | "quota_or_rate_limit"
  | "model_access"
  | "malformed_response"
  | "network_failure"
  | "timeout"
  | "upstream_error";

export class IntegrationError extends Error {
  constructor(
    readonly kind: IntegrationFailureKind,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function publicIntegrationError(error: unknown) {
  if (error instanceof IntegrationError) {
    return {
      kind: error.kind,
      message: error.message,
      ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
    };
  }

  return {
    kind: "network_failure" as const,
    message: "The integration request failed unexpectedly.",
  };
}

export function integrationFailureStatus(kind: IntegrationFailureKind) {
  if (kind === "missing_configuration") return 424;
  if (kind === "authentication" || kind === "model_access") return 502;
  if (kind === "quota_or_rate_limit") return 429;
  return 502;
}
