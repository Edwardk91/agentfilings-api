import type { x402ResourceServer } from "@x402/core/server";
import { createPaymentWrapper } from "@x402/mcp";
import {
  USDC_CONTRACT,
  USDC_EIP712_DOMAIN,
  usdToAtomicUsdc,
  X402_NETWORKS,
  X402_SCHEME,
  type X402Network,
} from "@agentfilings/shared";
import type { Env } from "../env";

function resolveNetwork(network: string): X402Network {
  if (network === X402_NETWORKS.baseMainnet || network === X402_NETWORKS.baseSepolia) {
    return network;
  }
  throw new Error(`Unsupported X402_NETWORK "${network}".`);
}

/**
 * Returns a wrapper factory that gates an MCP tool handler behind x402 payment,
 * reusing the SAME resource server (and its replay-guard extension) as the HTTP path.
 * Applied only when x402 is enabled; unwrapped in dev.
 *
 * The tool name MUST be passed: without it every paid tool advertises the same
 * placeholder resource (`mcp://tool/paid_tool`). That is not cosmetic — the replay
 * guard binds a payment to its resource identifier, so identical identifiers make a
 * $0.01 tool and a $0.02 tool indistinguishable to the guard, which is precisely the
 * cross-resource substitution it exists to block.
 */
export function createMcpPaidWrapper(env: Env, resourceServer: x402ResourceServer) {
  const network = resolveNetwork(env.X402_NETWORK);
  const asset = USDC_CONTRACT[network];
  const payTo = env.X402_RECEIVING_ADDRESS;
  if (!payTo) {
    throw new Error("X402_RECEIVING_ADDRESS is required to wrap paid MCP tools.");
  }

  return (priceUsd: number, toolName: string, description: string) =>
    createPaymentWrapper(resourceServer, {
      accepts: [
        {
          scheme: X402_SCHEME,
          network,
          asset,
          amount: usdToAtomicUsdc(priceUsd),
          payTo,
          maxTimeoutSeconds: 60,
          // Token EIP-712 domain — the paying client needs it to sign.
          extra: USDC_EIP712_DOMAIN[network],
        },
      ],
      resource: {
        url: `mcp://tool/${toolName}`,
        description,
        mimeType: "application/json",
        serviceName: "AgentFilings",
        tags: ["sec", "edgar", "filings"],
      },
    });
}

export type McpPaidWrapper = ReturnType<typeof createMcpPaidWrapper>;
