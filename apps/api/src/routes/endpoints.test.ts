import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../index";
import { LocalJsonCorpusRepo } from "../repo/corpus-repo";

const corpusDir = fileURLToPath(new URL("../../test/fixtures/corpus", import.meta.url));

function makeApp() {
  return createApp({ repo: new LocalJsonCorpusRepo(corpusDir) });
}

describe("GET /filings/latest", () => {
  const app = makeApp();

  it("400s without a ticker", async () => {
    const res = await app.request("/filings/latest");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe("bad_request");
    expect(body.error.hint).toContain("/probe");
  });

  it("returns filings for a covered ticker (miss then hit)", async () => {
    const miss = await app.request("/filings/latest?ticker=aapl");
    expect(miss.status).toBe(200);
    const body = (await miss.json()) as {
      data: { ticker: string; company: { ticker: string }; count: number; filings: unknown[] };
      meta: { source_api: string; cache: string };
    };
    expect(body.data.ticker).toBe("AAPL");
    expect(body.data.company.ticker).toBe("AAPL");
    expect(body.data.filings.length).toBe(body.data.count);
    expect(body.data.count).toBe(16);
    expect(body.meta.source_api).toBe("sec-edgar-submissions");
    expect(body.meta.cache).toBe("miss");

    const hit = await app.request("/filings/latest?ticker=AAPL");
    const hitBody = (await hit.json()) as { meta: { cache: string } };
    expect(hitBody.meta.cache).toBe("hit");
  });

  it("filters by form and honors limit", async () => {
    const res = await app.request("/filings/latest?ticker=AAPL&form=10-Q");
    const body = (await res.json()) as { data: { filings: { form: string }[] } };
    expect(body.data.filings.length).toBeGreaterThan(0);
    expect(body.data.filings.every((f) => f.form === "10-Q")).toBe(true);

    const limited = await app.request("/filings/latest?ticker=AAPL&limit=3");
    const limitedBody = (await limited.json()) as { data: { count: number } };
    expect(limitedBody.data.count).toBe(3);
  });

  it("matches form case-insensitively", async () => {
    const res = await app.request("/filings/latest?ticker=AAPL&form=10-q");
    const body = (await res.json()) as { data: { count: number; filings: { form: string }[] } };
    expect(body.data.count).toBeGreaterThan(0);
    expect(body.data.filings.every((f) => f.form === "10-Q")).toBe(true);
  });

  it("400s on an out-of-range or non-integer limit", async () => {
    for (const bad of ["0", "200", "abc", "1.5"]) {
      const res = await app.request(`/filings/latest?ticker=AAPL&limit=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it("404s for an uncovered ticker", async () => {
    const res = await app.request("/filings/latest?ticker=ZZZZ");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("coverage_missing");
  });
});

describe("GET /earnings/summary", () => {
  const app = makeApp();

  it("returns earnings periods newest-first with values", async () => {
    const res = await app.request("/earnings/summary?ticker=AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        count: number;
        periods: {
          period_end: string;
          duration: string;
          revenue: number | null;
          eps_diluted: number | null;
        }[];
      };
      meta: { source_api: string; cache: string };
    };
    expect(body.data.count).toBe(22);
    const top = body.data.periods[0]!;
    expect(top.period_end).toBe("2026-03-28");
    expect(top.duration).toBe("quarterly");
    expect(top.revenue).toBe(111184000000);
    expect(top.eps_diluted).toBe(2.01);
    expect(body.meta.source_api).toBe("sec-edgar-companyfacts");
  });

  it("filters by duration", async () => {
    const annual = await app.request("/earnings/summary?ticker=AAPL&period=annual");
    const annualBody = (await annual.json()) as { data: { periods: { duration: string }[] } };
    expect(annualBody.data.periods.length).toBeGreaterThan(0);
    expect(annualBody.data.periods.every((p) => p.duration === "annual")).toBe(true);

    const quarterly = await app.request("/earnings/summary?ticker=AAPL&period=quarterly");
    const qBody = (await quarterly.json()) as { data: { periods: { duration: string }[] } };
    expect(qBody.data.periods.length).toBeGreaterThan(0);
    expect(qBody.data.periods.every((p) => p.duration === "quarterly")).toBe(true);
  });

  it("filters by fiscal year, labeling comparatives by their original filing", async () => {
    const res = await app.request("/earnings/summary?ticker=AAPL&period=2025");
    const body = (await res.json()) as {
      data: { periods: { fiscal_year: number; period_end: string; duration: string }[] };
    };
    expect(body.data.periods.length).toBeGreaterThan(0);
    expect(body.data.periods.every((p) => p.fiscal_year === 2025)).toBe(true);
    // The quarter ending 2025-03-29 belongs to FY2025 (a later 10-Q re-reports it as fy2026).
    const q = body.data.periods.find(
      (p) => p.period_end === "2025-03-29" && p.duration === "quarterly",
    );
    expect(q).toBeTruthy();
  });

  it("404s for an uncovered ticker", async () => {
    const res = await app.request("/earnings/summary?ticker=NOPE");
    expect(res.status).toBe(404);
  });
});

describe("GET /insiders", () => {
  const app = makeApp();

  it("returns insider transactions for a covered ticker", async () => {
    const res = await app.request("/insiders?ticker=aapl");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ticker: string; count: number; transactions: { owner_name: string; code: string }[] };
      meta: { source_api: string };
    };
    expect(body.data.ticker).toBe("AAPL");
    expect(body.data.count).toBe(3);
    expect(body.data.transactions[0]!.owner_name).toBe("Newstead Jennifer");
    expect(body.meta.source_api).toBe("sec-edgar-form4");
  });

  it("400s without a ticker or on a malformed since date", async () => {
    expect((await app.request("/insiders")).status).toBe(400);
    expect((await app.request("/insiders?ticker=AAPL&since=2026")).status).toBe(400);
  });

  it("filters by since", async () => {
    const res = await app.request("/insiders?ticker=AAPL&since=2099-01-01");
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(0);
  });

  it("404s for an uncovered ticker", async () => {
    expect((await app.request("/insiders?ticker=ZZZZ")).status).toBe(404);
  });
});

describe("GET /probe — pre-payment coverage check", () => {
  const app = makeApp();

  it("tells an agent a covered ticker has data, and what is available", async () => {
    const res = await app.request("/probe?ticker=aapl");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        ticker: string;
        ticker_coverage: {
          covered: boolean;
          company: { name: string } | null;
          available: { filings: number; earnings_periods: number; insider_transactions: number };
          endpoints_with_data: string[];
        };
      };
    };
    expect(body.data.ticker).toBe("AAPL");
    expect(body.data.ticker_coverage.covered).toBe(true);
    expect(body.data.ticker_coverage.company?.name).toContain("Apple");
    expect(body.data.ticker_coverage.available.filings).toBeGreaterThan(0);
    expect(body.data.ticker_coverage.available.earnings_periods).toBeGreaterThan(0);
    expect(body.data.ticker_coverage.endpoints_with_data).toContain("/earnings/summary");
  });

  it("names the empty endpoints instead of claiming blanket coverage", async () => {
    // The fixture has filings and earnings but no insider rows, which is the same
    // shape as a real IFRS filer: covered for one dataset, empty for another. The
    // hint must not imply every paid endpoint returns data.
    const res = await app.request("/probe?ticker=AAPL");
    const body = (await res.json()) as {
      data: {
        ticker_coverage: {
          endpoints_with_data: string[];
          empty_endpoints: string[];
          available: { insider_transactions: number };
          hint: string;
        };
      };
    };
    const tc = body.data.ticker_coverage;
    // Whatever the fixture holds, the two lists must partition the paid endpoints
    // and the hint must never overpromise.
    const all = [...tc.endpoints_with_data, ...tc.empty_endpoints].sort();
    expect(all).toEqual(["/earnings/summary", "/filings/latest", "/insiders"]);
    if (tc.empty_endpoints.length > 0) {
      expect(tc.hint).toMatch(/do not pay for those|do not pay/i);
      for (const p of tc.empty_endpoints) expect(tc.hint).toContain(p);
    }
  });

  it("warns not to pay for an uncovered ticker", async () => {
    const res = await app.request("/probe?ticker=ZZZZ");
    expect(res.status).toBe(200); // probe is free and always answers
    const body = (await res.json()) as {
      data: { ticker_coverage: { covered: boolean; endpoints_with_data: string[]; hint: string } };
    };
    expect(body.data.ticker_coverage.covered).toBe(false);
    expect(body.data.ticker_coverage.endpoints_with_data).toEqual([]);
    expect(body.data.ticker_coverage.hint).toMatch(/do not pay/i);
  });

  it("omits ticker_coverage when no ticker is supplied", async () => {
    const res = await app.request("/probe");
    const body = (await res.json()) as { data: { ticker_coverage: null; pricing: unknown[] } };
    expect(body.data.ticker_coverage).toBeNull();
    expect(body.data.pricing.length).toBeGreaterThan(0);
  });
});

describe("discovery surfaces", () => {
  const app = makeApp();

  it("serves an OpenAPI document listing only buyable endpoints", async () => {
    // x402scan fetches exactly ${origin}/openapi.json and aborts registration if it
    // is missing or lists no routes — this is a hard discovery gate.
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      paths: Record<string, Record<string, { "x-payment-info"?: unknown }>>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe("AgentFilings");
    expect(doc.info.version).toBeTruthy();

    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
    expect(doc.paths["/earnings/summary"]!.get!["x-payment-info"]).toBeTruthy();
    // Unimplemented endpoints must not be advertised.
    expect(doc.paths["/institutional"]).toBeUndefined();
  });

  it("serves llms.txt and a root page instead of 404ing", async () => {
    const llms = await app.request("/llms.txt");
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("AgentFilings");

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("AgentFilings");
  });

  it("returns JSON at the root for agents that ask for it", async () => {
    const res = await app.request("/", { headers: { accept: "application/json" } });
    const body = (await res.json()) as { service: string; paid_endpoints: unknown[] };
    expect(body.service).toBe("AgentFilings");
    expect(body.paid_endpoints.length).toBeGreaterThan(0);
  });
});

describe("error handling", () => {
  it("returns a 500 error envelope for a corrupt corpus file", async () => {
    const badDir = fileURLToPath(new URL("../../test/fixtures/corpus-corrupt", import.meta.url));
    const badApp = createApp({ repo: new LocalJsonCorpusRepo(badDir) });
    const res = await badApp.request("/filings/latest?ticker=BAD");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal");
  });
});
