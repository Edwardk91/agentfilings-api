import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../index";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";

// HEAD over a real socket, through the same @hono/node-server adapter production uses.
//
// This has to be a socket test. Hono's app.request() bypasses the Node adapter, and the
// bug it guards against lives in the adapter: under @hono/node-server 1.19.14 a handler
// returning a bare c.text(body), with no status argument, answers HEAD with a 500.
// app.request() returned 200 for the same route, which is how /llms.txt shipped broken
// and was only found from a crawler's HEAD in the production logs.
//
// Crawlers and link checkers HEAD discovery files before fetching them, so every public
// GET route is covered, not just the one that broke.

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));
const PUBLIC_GET_ROUTES = [
  "/",
  "/health",
  "/probe",
  "/llms.txt",
  "/openapi.json",
  "/robots.txt",
  "/sitemap.xml",
  "/mcp/server-card",
  "/.well-known/ai-catalog.json",
];

let server: ServerType;
let base: string;

beforeAll(async () => {
  const app = createApp({ repo: new LocalJsonCorpusRepo(corpusDir) });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("HEAD over the Node adapter", () => {
  it.each(PUBLIC_GET_ROUTES)("answers HEAD %s with the same status as GET", async (path) => {
    const get = await fetch(base + path);
    const head = await fetch(base + path, { method: "HEAD" });
    expect(get.status).toBe(200);
    expect(head.status).toBe(get.status);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(await head.text()).toBe("");
  });
});
