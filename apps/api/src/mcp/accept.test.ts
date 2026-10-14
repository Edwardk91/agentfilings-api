import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../index";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";
import { withJsonAccept } from "./accept";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));
const URL_ = "https://api.example.com/mcp";
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
});

function post(accept: string | null, body = INIT): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (accept !== null) headers.accept = accept;
  return new Request(URL_, { method: "POST", headers, body });
}

describe("withJsonAccept", () => {
  it("leaves a spec-conformant request untouched", () => {
    const req = post("application/json, text/event-stream");
    expect(withJsonAccept(req)).toBe(req);
  });

  it.each([["*/*"], ["application/json"], ["application/*"], [null], ["text/html, */*;q=0.8"]])(
    "widens Accept for a client that takes JSON (%s)",
    (accept) => {
      expect(withJsonAccept(post(accept)).headers.get("accept")).toBe(
        "application/json, text/event-stream",
      );
    },
  );

  it.each([["text/event-stream"], ["text/html"]])(
    "does not force JSON on a client that refuses it (%s)",
    (accept) => {
      const req = post(accept);
      expect(withJsonAccept(req)).toBe(req);
    },
  );

  it("preserves the request body when it rewrites the headers", async () => {
    expect(await withJsonAccept(post("*/*")).text()).toBe(INIT);
  });

  it("ignores non-POST requests", () => {
    const req = new Request(URL_, { method: "GET", headers: { accept: "*/*" } });
    expect(withJsonAccept(req)).toBe(req);
  });
});

describe("/mcp over HTTP", () => {
  const app = createApp({ repo: new LocalJsonCorpusRepo(corpusDir) });

  it("answers GET with 405, not a hanging SSE stream or a 406", async () => {
    const res = await app.request("/mcp", { method: "GET", headers: { accept: "*/*" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("serves a client that sends a default Accept header", async () => {
    const res = await app.request(post("*/*"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { serverInfo?: { name: string } } };
    expect(body.result?.serverInfo?.name).toBe("agentfilings");
  });

  it("still returns 406 to a client that will not take JSON", async () => {
    const res = await app.request(post("text/html"));
    expect(res.status).toBe(406);
  });
});
