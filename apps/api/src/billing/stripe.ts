import Stripe from "stripe";
import { SUBSCRIPTION } from "@agentfilings/shared";
import type { Env } from "../env";
import { generateApiKey, type ApiKeyStore, type KeyStatus } from "./keys";

// Stripe wiring for the flat monthly tier.
//
// The product and price are created lazily on first use and then reused, rather than
// being configured by hand in the dashboard and pasted into an env var. One less
// secret to manage, and the price lives in code next to everything else that derives
// from the pricing table.

export interface StripeDeps {
  stripe: Stripe;
  keys: ApiKeyStore;
  publicBaseUrl: string;
}

export function stripeEnabled(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export function createStripeClient(env: Env): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is required to enable the subscription rail.");
  // Pinned explicitly rather than left to the account default: an account-level
  // version bump in the dashboard must not silently change response shapes here.
  return new Stripe(key, { apiVersion: "2026-06-24.dahlia" });
}

const LOOKUP_KEY = `agentfilings_${SUBSCRIPTION.id}`;

/**
 * Find (or create) the recurring price, keyed by a stable lookup_key.
 *
 * Idempotent by design: restarting the service, or running several instances, must
 * not produce a second product that some customers are billed against. The lookup
 * key is the deduplication anchor.
 */
export async function resolvePrice(stripe: Stripe): Promise<Stripe.Price> {
  const existing = await stripe.prices.list({
    lookup_keys: [LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  const found = existing.data[0];
  if (found) return found;

  const product = await stripe.products.create({
    name: SUBSCRIPTION.name,
    description: SUBSCRIPTION.summary,
  });
  return stripe.prices.create({
    product: product.id,
    lookup_key: LOOKUP_KEY,
    unit_amount: SUBSCRIPTION.priceUsdPerMonth * 100,
    currency: "usd",
    recurring: { interval: "month" },
  });
}

export async function createCheckoutSession(
  deps: StripeDeps,
  opts: { email?: string } = {},
): Promise<Stripe.Checkout.Session> {
  const price = await resolvePrice(deps.stripe);
  const base = deps.publicBaseUrl.replace(/\/$/, "");
  return deps.stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: price.id, quantity: 1 }],
    // {CHECKOUT_SESSION_ID} is substituted by Stripe on redirect. The success page
    // exchanges it for the freshly minted key.
    success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/?checkout=cancelled`,
    ...(opts.email ? { customer_email: opts.email } : {}),
    // Lets a customer cancel without emailing a human — which is the whole point,
    // since there is no human to email.
    subscription_data: { metadata: { service: "agentfilings" } },
    allow_promotion_codes: true,
  });
}

/**
 * Mint the key for a completed checkout, or return the existing one's metadata.
 *
 * Called from BOTH the webhook and the success page, because either can arrive
 * first and neither is guaranteed to arrive at all. Keyed on the subscription id,
 * which the unique index enforces — a double call cannot produce two live keys for
 * one subscription.
 *
 * The raw key is returned ONLY when this call is the one that created it. A second
 * call gets `raw: null`, because the raw value no longer exists anywhere. That is
 * the intended behaviour: refreshing the success page must not be able to re-reveal
 * a credential, and a webhook retry must not mint a second one.
 */
export async function provisionKeyForSession(
  deps: StripeDeps,
  session: Stripe.Checkout.Session,
): Promise<{ raw: string | null; keyPrefix: string; alreadyProvisioned: boolean }> {
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!subscriptionId) {
    throw new Error("checkout session has no subscription to provision against");
  }

  const generated = generateApiKey();
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

  try {
    const record = await deps.keys.insert({
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subscriptionId,
      email: session.customer_details?.email ?? session.customer_email ?? null,
    });
    return { raw: generated.raw, keyPrefix: record.keyPrefix, alreadyProvisioned: false };
  } catch (err) {
    // Unique violation on stripe_subscription_id: a key already exists for this
    // subscription (webhook and success page raced, or Stripe retried). Not an error.
    if (isUniqueViolation(err)) {
      return { raw: null, keyPrefix: "", alreadyProvisioned: true };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** Map a Stripe subscription status onto our three-state key status. */
export function keyStatusFor(subscriptionStatus: Stripe.Subscription.Status): KeyStatus {
  switch (subscriptionStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      // canceled, incomplete_expired, paused — no further access.
      return "canceled";
  }
}

/**
 * Apply a verified Stripe event to the key store.
 *
 * Returns a short description for the log. Unrecognised event types are ignored
 * rather than treated as errors, so enabling extra events in the dashboard later
 * cannot start failing webhook deliveries.
 */
export async function applyStripeEvent(deps: StripeDeps, event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode !== "subscription") return `ignored non-subscription checkout`;
      const result = await provisionKeyForSession(deps, session);
      return result.alreadyProvisioned
        ? "key already provisioned for this subscription"
        : `provisioned key ${result.keyPrefix}…`;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const status = keyStatusFor(sub.status);
      const n = await deps.keys.setStatusBySubscription(sub.id, status);
      return `set ${n} key(s) to ${status} for ${sub.id}`;
    }
    default:
      return `ignored ${event.type}`;
  }
}
