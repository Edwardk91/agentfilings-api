import { describe, expect, it } from "vitest";
import { app } from "../index";
import { ENDPOINTS } from "@agentfilings/shared";

describe("GET /probe", () => {
  it("returns pricing for every endpoint and echoes the ticker", async () => {
    const res = await app.request("/probe?ticker=aapl");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ticker: string; pricing: unknown[] };
      meta: { retrieved_at: string; cache: string };
    };
    expect(body.data.ticker).toBe("AAPL");
    // Only endpoints that are actually implemented are advertised with a price;
    // planned routes are listed separately and are never payable.
    expect(body.data.pricing).toHaveLength(ENDPOINTS.filter((e) => e.available).length);
    expect(body.meta.cache).toBe("miss");
    expect(typeof body.meta.retrieved_at).toBe("string");
  });

  it("keeps /health and /probe free", async () => {
    const res = await app.request("/probe");
    const body = (await res.json()) as {
      data: { pricing: { id: string; price_usd: number }[] };
    };
    const free = body.data.pricing.filter((p) => ["health", "probe"].includes(p.id));
    expect(free.every((p) => p.price_usd === 0)).toBe(true);
  });
});
