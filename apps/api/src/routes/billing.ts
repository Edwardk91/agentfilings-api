import { Hono } from "hono";
import type Stripe from "stripe";
import { SUBSCRIPTION } from "@agentfilings/shared";
import type { Env } from "../env";
import { fail } from "../lib/response";
import { extractApiKey, hashKey, type ApiKeyStore } from "../billing/keys";
import {
  applyStripeEvent,
  createCheckoutSession,
  createStripeClient,
  provisionKeyForSession,
  type StripeDeps,
} from "../billing/stripe";

// Self-serve billing. Every route here is reachable without a human on our side:
// a buyer subscribes, receives a key, and can verify it, without anyone being
// emailed. That is a hard requirement, not a nicety — there is nobody to email.

export function billing(env: Env, keys: ApiKeyStore, publicBaseUrl: string) {
  const router = new Hono();
  const stripe = createStripeClient(env);
  const deps: StripeDeps = { stripe, keys, publicBaseUrl };

  // Start checkout. GET so a plain link works from the pricing page and from an
  // agent that only knows how to follow URLs; POST returns JSON for programmatic use.
  router.get("/subscribe", async (c) => {
    const session = await createCheckoutSession(deps, { email: c.req.query("email") });
    if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
    return c.redirect(session.url, 303);
  });

  router.post("/checkout", async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
    const session = await createCheckoutSession(deps, { email: body.email });
    return c.json({ checkout_url: session.url, price_usd_per_month: SUBSCRIPTION.priceUsdPerMonth });
  });

  // Where Stripe redirects after payment. This is the ONLY place the raw key is ever
  // shown, and only on the first load — see provisionKeyForSession.
  router.get("/success", async (c) => {
    const sessionId = c.req.query("session_id");
    if (!sessionId) {
      return c.json(fail("bad_request", "Missing session_id.", "Start at /billing/subscribe."), 400);
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return c.html(page("Payment not complete", "<p>This checkout is not complete yet.</p>"), 402);
    }

    const result = await provisionKeyForSession(deps, session);
    if (result.raw) {
      return c.html(keyPage(result.raw, publicBaseUrl));
    }
    // Already provisioned — the webhook won the race, or this page was refreshed.
    // We cannot re-show a key we never stored, and should not pretend otherwise.
    return c.html(
      page(
        "Subscription active",
        `<p>Your subscription is active, but the API key was already issued and is shown only once.</p>
         <p>If you did not save it, cancel and resubscribe, or rotate from the
         <a href="/billing/portal">billing portal</a>.</p>`,
      ),
    );
  });

  // Stripe's own customer portal: cancel, update card, view invoices. Removes the
  // entire "email support to cancel" surface, which we could not staff anyway.
  router.get("/portal", async (c) => {
    const presented = extractApiKey({
      authorization: c.req.header("authorization"),
      apiKey: c.req.header("x-api-key"),
    });
    if (!presented) {
      return c.json(
        fail("unauthorized", "An API key is required to open the billing portal.", "Send it as x-api-key."),
        401,
      );
    }
    const record = await keys.findActiveByHash(hashKey(presented));
    if (!record?.stripeCustomerId) {
      return c.json(fail("unauthorized", "Unknown or inactive API key.", "Check the key."), 401);
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: record.stripeCustomerId,
      return_url: publicBaseUrl,
    });
    return c.redirect(portal.url, 303);
  });

  // Lets a subscriber confirm a key works without spending anything. Free and
  // deliberately boring: the first thing anyone does with a new key is test it, and
  // that test should not cost money or hit a paid endpoint.
  router.get("/me", async (c) => {
    const presented = extractApiKey({
      authorization: c.req.header("authorization"),
      apiKey: c.req.header("x-api-key"),
    });
    if (!presented) {
      return c.json(fail("unauthorized", "No API key supplied.", "Send Authorization: Bearer af_live_… or x-api-key."), 401);
    }
    const record = await keys.findActiveByHash(hashKey(presented));
    if (!record) {
      return c.json(fail("unauthorized", "Unknown, revoked, or past-due API key.", "Resubscribe at /billing/subscribe."), 401);
    }
    return c.json({
      data: {
        key_prefix: record.keyPrefix,
        status: record.status,
        created_at: record.createdAt,
        plan: { name: SUBSCRIPTION.name, price_usd_per_month: SUBSCRIPTION.priceUsdPerMonth },
        note: "This key authenticates every paid endpoint and MCP tool. No per-call charge.",
      },
    });
  });

  // Webhook. Signature verification is mandatory: without it anyone who learns this
  // URL can mint themselves a subscription by POSTing a fake checkout.session.completed.
  router.post("/webhook", async (c) => {
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error("stripe webhook received but STRIPE_WEBHOOK_SECRET is unset — rejecting");
      return c.json(fail("internal", "Webhook not configured.", "Contact the operator."), 500);
    }
    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json(fail("bad_request", "Missing stripe-signature.", ""), 400);

    // Must be the raw, unparsed body — any re-serialisation breaks the HMAC.
    const raw = await c.req.text();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(raw, signature, secret);
    } catch (err) {
      console.error("stripe webhook signature verification failed:", err);
      return c.json(fail("unauthorized", "Invalid webhook signature.", ""), 400);
    }

    try {
      const outcome = await applyStripeEvent(deps, event);
      console.log(`stripe webhook ${event.type}: ${outcome}`);
    } catch (err) {
      // 500 so Stripe retries. Returning 200 on a failed provision would strand a
      // paying customer with no key and no retry.
      console.error(`stripe webhook ${event.type} failed:`, err);
      return c.json(fail("internal", "Webhook processing failed.", ""), 500);
    }
    return c.json({ received: true });
  });

  return router;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — AgentFilings</title>
<style>:root{color-scheme:light dark}
body{font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:44rem;margin:0 auto;padding:3rem 1.25rem}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:#8881;padding:1rem;border-radius:8px;overflow-x:auto;user-select:all}
.warn{border-left:3px solid #d97706;padding-left:1rem}
a{color:inherit}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

function keyPage(rawKey: string, base: string): string {
  return page(
    "Your API key",
    `<p class="warn"><strong>Copy this now.</strong> It is shown once and never again —
     we store only a hash, so it cannot be recovered or re-sent.</p>
<pre>${rawKey}</pre>
<p>Use it on any paid endpoint or MCP tool:</p>
<pre>curl -H "x-api-key: ${rawKey}" \\
  "${base}/earnings/summary?ticker=AAPL"</pre>
<p>Verify it any time at <a href="/billing/me">/billing/me</a> (free).
Manage or cancel at <a href="/billing/portal">/billing/portal</a>.</p>
<p>No per-call charges while this key is active.</p>`,
  );
}
