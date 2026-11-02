// Verify migration 049 (usage_counters + reserve_usage + record_usage) against
// the real database.
//
// Runs entirely against the test learner and on SYNTHETIC period_start values
// ('2099-01-01' for the controlled tests, '2000-01-01' for the seeding proof),
// so it cannot disturb a real month's counter. Every row it creates is deleted
// at the end and the deletion is confirmed.
//
//   node scripts/verify-049.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EMAIL = "test_user@testmail.com";

// Synthetic periods. Far future: nothing in usage_logs is >= it, so the counter
// seeds from zero and every number below is fully controlled.
const FUTURE = "2099-01-01T00:00:00.000Z";
// Far past: seeds from EVERY usage_logs row the learner has, which is a sum this
// script can compute independently and compare against.
const PAST = "2000-01-01T00:00:00.000Z";

function loadEnv() {
  const env = {};
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
  return env;
}

const env = loadEnv();
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
  }
}

async function findTestUser() {
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`listUsers failed: ${error.message}`);
  const user = data.users.find(u => u.email?.toLowerCase() === EMAIL);
  if (!user) throw new Error(`test learner ${EMAIL} not found - run scripts/seed-test-user.mjs`);
  return user.id;
}

async function reserve(userId, period, opts = {}) {
  const { data, error } = await db.rpc("reserve_usage", {
    p_user_id:       userId,
    p_period_start:  period,
    p_estimate:      opts.estimate ?? 1000,
    p_token_limit:   opts.limit === undefined ? 100000 : opts.limit,
    p_max_requests:  opts.maxRequests ?? 1000,
    p_rate_window_s: opts.rateWindow ?? 60,
    p_reserve_ttl_s: opts.ttl ?? 150,
    ...(opts.now ? { p_now: opts.now } : {}),
  });
  if (error) throw new Error(`reserve_usage: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function counterRow(userId, period) {
  const { data, error } = await db
    .from("usage_counters")
    .select("*")
    .eq("user_id", userId)
    .eq("period_start", period)
    .maybeSingle();
  if (error) throw new Error(`read counter: ${error.message}`);
  return data;
}

async function wipe(userId, period) {
  const { error } = await db
    .from("usage_counters")
    .delete()
    .eq("user_id", userId)
    .eq("period_start", period);
  if (error) throw new Error(`cleanup: ${error.message}`);
}

async function main() {
  const userId = await findTestUser();
  console.log(`test learner: ${userId}\n`);

  // Start from a clean slate on both synthetic periods.
  await wipe(userId, FUTURE);
  await wipe(userId, PAST);

  // ── 1. The table and both functions exist and are callable ────────────────
  console.log("1. Schema is reachable");
  const first = await reserve(userId, FUTURE, { estimate: 0, limit: null });
  check("reserve_usage returns a row", first && typeof first.granted === "boolean", first);
  const created = await counterRow(userId, FUTURE);
  check("usage_counters row was created", created !== null);
  check("row has the 049 columns", created
    && "tokens_spent" in created
    && "reserved_tokens" in created
    && "reserve_window_start" in created
    && "rate_window_start" in created
    && "rate_count" in created, created && Object.keys(created));

  // ── 2. Seeding from usage_logs ────────────────────────────────────────────
  console.log("\n2. A new period seeds from usage_logs, not from zero");
  const { data: logs, error: logErr } = await db
    .from("usage_logs")
    .select("tokens_in, tokens_out")
    .eq("user_id", userId)
    .gte("created_at", PAST);
  if (logErr) throw new Error(`read usage_logs: ${logErr.message}`);
  const expectedSeed = (logs ?? []).reduce(
    (s, r) => s + (r.tokens_in ?? 0) + (r.tokens_out ?? 0), 0);

  await reserve(userId, PAST, { estimate: 0, limit: null });
  const seeded = await counterRow(userId, PAST);
  check(`seeds tokens_spent from existing logs (expected ${expectedSeed})`,
    Number(seeded.tokens_spent) === expectedSeed,
    { got: seeded.tokens_spent, expected: expectedSeed });
  check("this is the row that stops a fresh allowance on deploy day",
    expectedSeed === 0 || Number(seeded.tokens_spent) > 0,
    { note: "test learner had no logged spend; seeding path still exercised" });

  // ── 3. The cap holds under CONCURRENT requests (the actual defect) ────────
  console.log("\n3. The cap holds when requests are concurrent");
  await wipe(userId, FUTURE);
  const LIMIT = 10_000;
  const EST   = 1_000;
  const FIRED = 25;
  // 25 requests fired at once against a 10,000 cap at 1,000 each. Pre-049 this
  // is exactly the shape that let all 25 through: every one read the same
  // pre-spend total of zero.
  const results = await Promise.all(
    Array.from({ length: FIRED }, () =>
      reserve(userId, FUTURE, { estimate: EST, limit: LIMIT, maxRequests: 10_000 })),
  );
  const granted = results.filter(r => r.granted).length;
  const refused = results.filter(r => !r.granted && r.reason === "limit_reached").length;
  check(`exactly ${LIMIT / EST} of ${FIRED} concurrent requests granted`,
    granted === LIMIT / EST, { granted, refused, fired: FIRED });
  check("the rest were refused as limit_reached", refused === FIRED - LIMIT / EST,
    { granted, refused });

  const afterRace = await counterRow(userId, FUTURE);
  check("reserved_tokens never exceeded the cap",
    Number(afterRace.reserved_tokens) <= LIMIT,
    { reserved: afterRace.reserved_tokens, limit: LIMIT });

  // ── 4. record_usage adds real spend ──────────────────────────────────────
  console.log("\n4. record_usage adds actual spend to the running total");
  await wipe(userId, FUTURE);
  await reserve(userId, FUTURE, { estimate: 500, limit: null });
  const { error: recErr } = await db.rpc("record_usage", {
    p_user_id: userId, p_period_start: FUTURE, p_tokens: 1234,
  });
  if (recErr) throw new Error(`record_usage: ${recErr.message}`);
  const recorded = await counterRow(userId, FUTURE);
  check("tokens_spent increased by the real amount",
    Number(recorded.tokens_spent) === 1234, { got: recorded.tokens_spent });
  check("reserved_tokens was left alone (a log naming no feature releases nothing)",
    Number(recorded.reserved_tokens) === 500, { got: recorded.reserved_tokens });

  // record_usage must never be able to hand budget back.
  await db.rpc("record_usage", { p_user_id: userId, p_period_start: FUTURE, p_tokens: -5000 });
  const clamped = await counterRow(userId, FUTURE);
  check("a negative token count cannot refund budget",
    Number(clamped.tokens_spent) === 1234, { got: clamped.tokens_spent });

  // ── 5. The cap counts spent + in-flight together ─────────────────────────
  console.log("\n5. The ceiling is spent + reserved, not either alone");
  await wipe(userId, FUTURE);
  await reserve(userId, FUTURE, { estimate: 6_000, limit: 10_000 });
  await db.rpc("record_usage", { p_user_id: userId, p_period_start: FUTURE, p_tokens: 3_000 });
  // spent 3,000 + reserved 6,000 = 9,000. A 2,000 claim would reach 11,000.
  const overflow = await reserve(userId, FUTURE, { estimate: 2_000, limit: 10_000 });
  check("a claim that would breach the cap on the COMBINED total is refused",
    overflow.granted === false && overflow.reason === "limit_reached", overflow);

  // ── 6. Reservations expire on the TTL ────────────────────────────────────
  console.log("\n6. An in-flight reservation expires rather than leaking");
  const past = await counterRow(userId, FUTURE);
  const later = new Date(new Date(past.reserve_window_start).getTime() + 200_000).toISOString();
  const afterTtl = await reserve(userId, FUTURE, {
    estimate: 2_000, limit: 10_000, now: later, ttl: 150,
  });
  check("the same claim is granted once the reservation window has passed",
    afterTtl.granted === true, afterTtl);
  const expired = await counterRow(userId, FUTURE);
  check("expired reservations were cleared, not accumulated",
    Number(expired.reserved_tokens) === 2_000, { got: expired.reserved_tokens });

  // ── 7. The rate limit ────────────────────────────────────────────────────
  console.log("\n7. The rate limit trips and then resets");
  await wipe(userId, FUTURE);
  const MAX = 5;
  const rate = [];
  for (let i = 0; i < MAX + 2; i++) {
    rate.push(await reserve(userId, FUTURE, {
      estimate: 0, limit: null, maxRequests: MAX, rateWindow: 60,
    }));
  }
  check(`the first ${MAX} are granted`, rate.slice(0, MAX).every(r => r.granted),
    rate.map(r => r.granted));
  check("the next is refused as rate_limited",
    rate[MAX].granted === false && rate[MAX].reason === "rate_limited", rate[MAX]);
  check("a rate refusal carries a Retry-After value",
    typeof rate[MAX].retry_after === "number" && rate[MAX].retry_after > 0, rate[MAX]);
  check("hammering the refusal does not reset the window",
    rate[MAX + 1].granted === false, rate[MAX + 1]);

  const rateRow = await counterRow(userId, FUTURE);
  const nextWindow = new Date(
    new Date(rateRow.rate_window_start).getTime() + 61_000).toISOString();
  const afterWindow = await reserve(userId, FUTURE, {
    estimate: 0, limit: null, maxRequests: MAX, rateWindow: 60, now: nextWindow,
  });
  check("the window rolls and the next request is granted",
    afterWindow.granted === true, afterWindow);

  // ── 8. A null limit is not enforced (pro/admin posture) ──────────────────
  console.log("\n8. A null token limit is not enforced");
  await wipe(userId, FUTURE);
  const unlimited = await reserve(userId, FUTURE, { estimate: 5_000_000, limit: null });
  check("a huge claim is granted when the limit is null",
    unlimited.granted === true, unlimited);
  const rateStillApplies = await reserve(userId, FUTURE, {
    estimate: 0, limit: null, maxRequests: 1,
  });
  check("but the RATE limit still applies to an uncapped plan",
    rateStillApplies.granted === false && rateStillApplies.reason === "rate_limited",
    rateStillApplies);

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log("\n9. Cleanup");
  await wipe(userId, FUTURE);
  await wipe(userId, PAST);
  check("synthetic FUTURE counter deleted", (await counterRow(userId, FUTURE)) === null);
  check("synthetic PAST counter deleted",   (await counterRow(userId, PAST))   === null);

  const { count } = await db
    .from("usage_counters")
    .select("*", { count: "exact", head: true })
    .in("period_start", [FUTURE, PAST]);
  check("no synthetic rows left for any user", (count ?? 0) === 0, { count });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("\nverification aborted:", err.message);
  process.exit(1);
});
