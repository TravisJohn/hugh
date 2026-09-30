// Verify migration 054 on the production test learner only. Uses a synthetic
// future period and removes its counter (and cascading reservations) afterward.
// Run after applying 054; no provider calls or real billing period are touched.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "test_user@testmail.com";
const PERIOD = "2099-01-01T00:00:00.000Z";
const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  raw.split(/\r?\n/)
    .map(line => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map(match => [match[1], match[2].replace(/^["']|["']$/g, "").trim()]),
);
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Production Supabase configuration is required");
}
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function assert(condition, label) {
  if (!condition) throw new Error(label);
  console.log("PASS", label);
}
async function reserve(userId, estimate, limit, now) {
  const { data, error } = await db.rpc("reserve_usage", {
    p_user_id: userId,
    p_period_start: PERIOD,
    p_estimate: estimate,
    p_token_limit: limit,
    p_max_requests: 100,
    p_rate_window_s: 60,
    p_reserve_ttl_s: 150,
    p_now: now,
  });
  if (error) throw new Error("reserve_usage: " + error.message);
  return data[0];
}
async function clear(userId) {
  const { error } = await db.from("usage_counters")
    .delete().eq("user_id", userId).eq("period_start", PERIOD);
  if (error) throw new Error("synthetic cleanup: " + error.message);
}

const { data: users, error: usersError } = await db.auth.admin.listUsers({
  page: 1, perPage: 1000,
});
if (usersError) throw new Error("test learner lookup: " + usersError.message);
const userId = users.users.find(user => user.email?.toLowerCase() === EMAIL)?.id;
if (!userId) throw new Error("Production test learner not found");

await clear(userId);
try {
  const base = Date.now();
  const at = seconds => new Date(base + seconds * 1000).toISOString();
  assert((await reserve(userId, 0, 6000, at(0))).granted,
    "zero-cost request starts the counter");
  assert((await reserve(userId, 6000, 6000, at(149))).granted,
    "late-window claim is admitted");
  const boundary = await reserve(userId, 6000, 6000, at(150));
  assert(!boundary.granted && boundary.reason === "limit_reached",
    "claim survives the former shared expiry boundary");
  const beforeExpiry = await reserve(userId, 6000, 6000, at(298));
  assert(!beforeExpiry.granted && beforeExpiry.reason === "limit_reached",
    "claim remains counted before its own expiry");
  assert((await reserve(userId, 6000, 6000, at(299))).granted,
    "claim expires at its own TTL");
} finally {
  await clear(userId);
}
console.log("S4 production synthetic-period verification passed");
