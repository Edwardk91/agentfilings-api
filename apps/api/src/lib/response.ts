import type { ApiError, ApiSuccess, ErrorCode, ResponseMeta } from "@agentfilings/shared";

const PROBE_HINT = "Call /probe for coverage, freshness, and pricing before paying.";

export function ok<T>(data: T, meta: Partial<ResponseMeta> = {}): ApiSuccess<T> {
  return {
    data,
    meta: {
      retrieved_at: new Date().toISOString(),
      cache: "miss",
      ...meta,
    },
  };
}

export function fail(code: ErrorCode, message: string, hint: string = PROBE_HINT): ApiError {
  return { error: { code, message, hint } };
}

export type HttpErrorStatus = 400 | 402 | 404 | 429 | 500 | 503;

export function statusForCode(code: ErrorCode): HttpErrorStatus {
  switch (code) {
    case "bad_request":
      return 400;
    case "payment_required":
    case "payment_invalid":
    case "payment_replayed":
      return 402;
    case "not_found":
    case "coverage_missing":
      return 404;
    case "rate_limited":
      return 429;
    case "upstream_unavailable":
      return 503;
    default:
      return 500;
  }
}
