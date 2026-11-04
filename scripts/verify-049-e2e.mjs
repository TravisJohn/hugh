// End-to-end check that a REAL request reaches migration 049 through
// lib/usage.ts, rather than silently falling back to the pre-049 sum.
//
// Signs the test learner in for a genuine session cookie and drives a gated
// route against a running dev server (npm run dev on :3000).
//
// The refusal case is exercised first by setting the learner's token_limit to 0,
// which proves the whole path - profile read, tokenLimitFor, reserve_usage,
// messageForDenial, 429 - while spending nothing at all. The learner's original
// token_limit is restored at the end and the restoration is confirmed.
//
//   node scripts/verify-049-e2e.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requireTestUserPassword } from "./testUserPassword.mjs";

const EMAIL    = "test_user@testmail.com";
const BASE     = "http://localhost:3000";
const ROUTE    = "/api/dashboard/classify-topic";

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
const PASSWORD = requireTestUserPassword(env);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else    { failed++; console.log(`  FAIL  ${name}`);
            if (detail !== undefined) console.log(`        ${JSON.stringify(detail)}`); }
}

/** Build the sb-<ref>-auth-token cookie @supabase/ssr 0.12 expects. */
function sessionCookie(session) {
  const ref   = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const name  = `sb-${ref}-auth-token`;
  const value = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64");

  // ssr chunks anything over ~3180 chars into name.0, name.1, ...
  const LIMIT = 3180;
  if (value.length <= LIMIT) return `${name}=${value}`;
  const parts = [];
  for (let i = 0, n = 0; i < value.length; i += LIMIT, n++) {
    parts.push(`${name}.${n}=${value.slice(i, i + LIMIT)}`);
  }
  return parts.join("; ");
}

function periodStart() {
  const d = new Date();
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Poll until tokens_spent stops changing, so a fire-and-forget write cannot
 *  be attributed to the next request. */
async function settledSpend(userId) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const now = Number((await counterRow(userId))?.tokens_spent ?? 0);
    if (now === last) return now;
    last = now;
    await new Promise(r => setTimeout(r, 400));
  }
  return last;
}

async function counterRow(userId) {
  const { data } = await admin
    .from("usage_counters")
    .select("*")
    .eq("user_id", userId)
    .eq("period_start", periodStart())
    .maybeSingle();
  return data;
}

async function main() {
  // ── Sign in for a real session ───────────────────────────────────────────
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signIn, error: signInErr } =
    await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);
  const userId = signIn.user.id;
  const cookie = sessionCookie(signIn.session);
  console.log(`signed in as ${userId}\n`);

  const post = (body) => fetch(BASE + ROUTE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });

  // Remember the learner's real settings so they can be put back.
  const { data: before } = await admin
    .from("profiles").select("token_limit, plan, is_admin")
    .eq("user_id", userId).single();
  const originalLimit = before?.token_limit ?? null;
  console.log(`original token_limit: ${originalLimit}, plan: ${before?.plan}, admin: ${before?.is_admin}\n`);

  if (before?.is_admin || before?.plan === "pro") {
    console.log("NOTE: test learner is pro/admin, so the token cap is not enforced");
    console.log("      for them by design. The refusal below is therefore driven");
    console.log("      by the rate limit instead.\n");
  }

  // ── 1. The session is genuinely authenticated ────────────────────────────
  console.log("1. The request authenticates as a real learner");
  const probe = await post({ topic: "window functions in SQL" });
  check("gated route does not answer 401", probe.status !== 401, { status: probe.status });
  check("gated route does not crash", probe.status !== 500, { status: probe.status });

  const afterProbe = await counterRow(userId);
  check("a usage_counters row now exists for the current period",
    afterProbe !== null,
    { note: "null here means lib/usage.ts fell back to the pre-049 path" });
  check("the reservation actually reached the counter",
    afterProbe && (Number(afterProbe.reserved_tokens) > 0 || Number(afterProbe.tokens_spent) > 0),
    afterProbe && { reserved: afterProbe.reserved_tokens, spent: afterProbe.tokens_spent });
  check("the rate window recorded the request",
    afterProbe && Number(afterProbe.rate_count) > 0,
    afterProbe && { rate_count: afterProbe.rate_count });

  // ── 2. An exhausted budget refuses, through the real gate ────────────────
  console.log("\n2. An exhausted budget refuses with 429, spending nothing");
  await admin.from("profiles")
    .update({ token_limit: 0, plan: "free", is_admin: false })
    .eq("user_id", userId);

  // logUsage is fire-and-forget, so the previous request's spend can still be
  // in flight. Wait for the counter to stop moving before taking a baseline,
  // or this measures request 1's tokens and blames them on request 2.
  const spentBefore = await settledSpend(userId);
  const refused = await post({ topic: "window functions in SQL" });
  const refusedBody = await refused.json().catch(() => ({}));

  check("returns 429, not 403 and not 200", refused.status === 429,
    { status: refused.status, body: refusedBody });
  check("carries the monthly-limit sentence, not the generic one",
    typeof refusedBody.error === "string" && /Monthly usage limit/i.test(refusedBody.error),
    refusedBody);

  const spentAfter = await settledSpend(userId);
  check("no tokens were spent on a refused request", spentAfter === spentBefore,
    { before: spentBefore, after: spentAfter });

  // ── 3. Restore ───────────────────────────────────────────────────────────
  console.log("\n3. Restore the learner's settings");
  await admin.from("profiles")
    .update({
      token_limit: originalLimit,
      plan:        before?.plan ?? "free",
      is_admin:    before?.is_admin ?? false,
    })
    .eq("user_id", userId);

  const { data: after } = await admin
    .from("profiles").select("token_limit, plan, is_admin")
    .eq("user_id", userId).single();
  check("token_limit restored", (after?.token_limit ?? null) === originalLimit,
    { got: after?.token_limit, expected: originalLimit });
  check("plan restored", after?.plan === before?.plan, { got: after?.plan });
  check("is_admin restored", after?.is_admin === before?.is_admin, { got: after?.is_admin });

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log("\nNOTE: the counter row for the current period is REAL usage by the");
  console.log("      test learner and is deliberately left in place.");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error("\nverification aborted:", err.message);
  process.exit(1);
});
