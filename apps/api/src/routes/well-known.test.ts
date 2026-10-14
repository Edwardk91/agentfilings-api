import { ENDPOINTS } from "@agentfilings/shared";
import { describe, expect, it } from "vitest";
import { x402Manifest } from "./well-known";

const BASE = "https://api.example.com/";

describe("/.well-known/x402 manifest", () => {
  it("is absent while the x402 rail is off", async () => {
    // Otherwise it would tell agents to pay for routes that are not collecting payment.
    const res = await x402Manifest(BASE, false).request("/");
    expect(res.status).toBe(404);
  });

  it("serves a draft-conformant resource-server manifest", async () => {
    const res = await x402Manifest(BASE, true).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // The draft asks that cross-origin GETs be permitted.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    expect(body.kind).toBe("resource-server");
    expect(body.docs).toBe("https://api.example.com/llms.txt");
    // Facilitator fields belong to facilitators; `updated` would go stale; `contact`
    // would publish a personal address.
    expect(body).not.toHaveProperty("facilitator");
    expect(body).not.toHaveProperty("updated");
    expect(body).not.toHaveProperty("contact");
  });

  it("lists exactly the paid, servable routes — never a free or unbuilt one", async () => {
    const body = (await (await x402Manifest(BASE, true).request("/")).json()) as {
      resources: { url: string; method: string; description: string }[];
    };
    const expected = ENDPOINTS.filter((e) => e.available && e.priceUsd > 0);
    expect(body.resources.map((r) => r.url).sort()).toEqual(
      expected.map((e) => `https://api.example.com${e.path}`).sort(),
    );
    expect(body.resources.some((r) => r.url.endsWith("/health"))).toBe(false);
    expect(body.resources.some((r) => r.url.endsWith("/probe"))).toBe(false);
    for (const r of body.resources) expect(r.description).toMatch(/\$\d+\.\d{2} USDC per call\.$/);
  });
});
