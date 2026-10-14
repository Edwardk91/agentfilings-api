// Accept-header leniency for POST /mcp.
//
// The streamable-HTTP spec says a client MUST list both application/json and
// text/event-stream, and the SDK transport enforces that with a 406. But this server
// runs with `enableJsonResponse: true` and never streams: every reply is plain JSON.
// A client that sends `*/*`, `application/json`, or no Accept header at all will be
// served exactly what it asked for, so rejecting it helps no one.
//
// It was costing us: an uptime monitor POSTed every 10 minutes with a default Accept
// and logged 235 consecutive 406s — which a directory reads as "server down".
//
// A client that genuinely refuses JSON (say, `text/event-stream` alone) still gets the
// SDK's 406, because JSON is the only thing we will send it.

const REQUIRED = "application/json, text/event-stream";

function acceptsJson(accept: string): boolean {
  if (accept.trim() === "") return true;
  return accept
    .split(",")
    .map((part) => part.split(";")[0]!.trim().toLowerCase())
    .some((type) => type === "application/json" || type === "application/*" || type === "*/*");
}

export function withJsonAccept(req: Request): Request {
  if (req.method !== "POST") return req;
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return req;
  if (!acceptsJson(accept)) return req;

  const headers = new Headers(req.headers);
  headers.set("accept", REQUIRED);
  return new Request(req, { headers });
}
