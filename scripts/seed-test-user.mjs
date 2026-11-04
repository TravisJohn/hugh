// Seed (and optionally reset) a local test user so you can always walk the whole
// app as a freshly-approved learner.
//
//   node scripts/seed-test-user.mjs           → ensure the user exists,
//                                                email-confirmed + approved.
//                                                Non-destructive, idempotent.
//   node scripts/seed-test-user.mjs --reset    → the above, then wipe the user's
//                                                learning data (goals + tracks →
//                                                milestones) so /home shows the
//                                                empty "new learner" dashboard.
//
// Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
// The service-role key bypasses RLS and email confirmation — dev/test only,
// never ship this flow to the client.
//
// Also needs HUGH_TEST_USER_PASSWORD in .env.local. This repo is public, so the
// password lives only there, and each run sets the account's password to it.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { requireTestUserPassword } from "./testUserPassword.mjs";

const EMAIL    = "test_user@testmail.com";
const RESET    = process.argv.includes("--reset");

// ── Load .env.local (no dotenv dependency) ──────────────────────────────────
function loadEnv() {
  const env = {};
  let raw;
  try {
    raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    throw new Error(".env.local not found in project root");
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[m[1]] = val;
  }
  return env;
}

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}
const PASSWORD = requireTestUserPassword(env);

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Find an auth user by email (admin API has no direct getByEmail) ─────────
async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) break; // last page
  }
  return null;
}

async function main() {
  // 1. Ensure the auth user exists, is email-confirmed, and has the password.
  let user = await findUserByEmail(EMAIL);

  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    user = data.user;
    console.log(`✓ Created auth user  ${EMAIL}`);
  } else {
    // Reset password + force-confirm in case it was created differently before.
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`✓ Auth user already existed — password reset + confirmed`);
  }

  // 2. Approve the profile (the signup trigger created it with approved=false).
  //    Upsert guards against the rare race where the trigger hasn't run yet.
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ user_id: user.id, approved: true, is_blocked: false }, { onConflict: "user_id" });
  if (pErr) throw pErr;
  console.log(`✓ Profile approved`);

  // 3. Optional reset → back to a clean "new learner".
  if (RESET) {
    // tracks.goal_id is ON DELETE SET NULL, so deleting goals leaves orphan
    // tracks behind — delete tracks explicitly (milestones cascade from tracks).
    const { error: tErr } = await admin.from("tracks").delete().eq("user_id", user.id);
    if (tErr) throw tErr;
    const { error: gErr } = await admin.from("learning_goals").delete().eq("user_id", user.id);
    if (gErr) throw gErr;
    console.log(`✓ Reset — learning goals + tracks wiped (fresh new-learner state)`);
  }

  console.log("\nReady. Sign in at /login with:");
  console.log(`   email:    ${EMAIL}`);
  console.log("   password: the value of HUGH_TEST_USER_PASSWORD in .env.local");
  if (!RESET) {
    console.log("\nTip: re-run with --reset to return this user to a blank dashboard.");
  }
}

main().catch(err => {
  console.error("\n✗ Failed:", err.message ?? err);
  process.exit(1);
});
