-- Subscription API keys — the Stripe rail alongside x402.
--
-- Raw keys are NEVER stored. We keep a SHA-256 hash for lookup and a short
-- non-secret prefix for display and support ("the key ending in ..."). A key is
-- shown to the buyer exactly once, on the checkout success page. If they lose it
-- they rotate; we cannot recover it, and that is the correct trade.
--
-- Lookup is by hash, which is unique and indexed, so authenticating a request is a
-- single point read on the primary key path.

create table if not exists api_keys (
  id bigint generated always as identity primary key,
  -- sha256(raw key), hex. Unique so a collision surfaces as an insert failure
  -- rather than two customers silently sharing an identity.
  key_hash text not null unique,
  -- Non-secret leading segment, e.g. "af_live_9f3c". Safe to log and display.
  key_prefix text not null,
  stripe_customer_id text,
  -- One key per subscription: the webhook is keyed off this on cancel/renew, and a
  -- duplicate would leave an orphaned key live after a cancellation.
  stripe_subscription_id text unique,
  email text,
  -- active | past_due | canceled. Only 'active' authenticates.
  status text not null default 'active',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz,
  request_count bigint not null default 0
);

create index if not exists api_keys_customer_idx on api_keys (stripe_customer_id);
create index if not exists api_keys_status_idx on api_keys (status);

-- Same posture as the corpus tables: RLS on with no policies, so Supabase's
-- auto-generated anon/PostgREST API exposes nothing. Keys are reachable only
-- through our own server, which connects as `postgres` and bypasses RLS.
alter table api_keys enable row level security;
