// Response contract (handoff §4). Every paid response carries { data, meta };
// every error carries a machine-readable code, an agent-readable message, and a
// pointer back to /probe.

export interface ResponseMeta {
  /** Accession number of the SEC filing this data came from, if applicable. */
  source_accession?: string;
  /** SEC API this data came from, if not tied to a single accession. */
  source_api?: string;
  /** When the underlying filing was filed (ISO 8601), if known. */
  filed_at?: string | null;
  /** When this service assembled the response (ISO 8601). */
  retrieved_at: string;
  cache: "hit" | "miss";
}

export interface ApiSuccess<T> {
  data: T;
  meta: ResponseMeta;
}

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "coverage_missing"
  | "payment_required"
  | "payment_invalid"
  | "payment_replayed"
  /** An API key was supplied but is unknown, revoked, or past due. */
  | "unauthorized"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal";

export interface ApiError {
  error: {
    code: ErrorCode;
    /** Human/agent-readable explanation. */
    message: string;
    /** Actionable pointer, e.g. to /probe or the docs. */
    hint: string;
    details?: unknown;
  };
}
