import { describe, expect, it } from "vitest";
import { USDC_CONTRACT, X402_NETWORKS, usdToAtomicUsdc } from "./x402";

describe("usdToAtomicUsdc", () => {
  it("converts USD to 6-decimal atomic USDC units (Bazaar-compliant string)", () => {
    expect(usdToAtomicUsdc(0.01)).toBe("10000");
    expect(usdToAtomicUsdc(0.02)).toBe("20000");
    expect(usdToAtomicUsdc(0.05)).toBe("50000");
    expect(usdToAtomicUsdc(1)).toBe("1000000");
  });
});

describe("network constants", () => {
  it("uses CAIP-2 ids and native USDC (not v1 short names / bridged USDbC)", () => {
    expect(X402_NETWORKS.baseMainnet).toBe("eip155:8453");
    expect(USDC_CONTRACT[X402_NETWORKS.baseMainnet]).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
  });
});
