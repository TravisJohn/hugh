import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Load .env.local before anything else
// ---------------------------------------------------------------------------
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";

function result(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? `  — ${detail}` : ""}`);
  return ok;
}

function env(key: string): string {
  return process.env[key] ?? "";
}

// ---------------------------------------------------------------------------
// 1. ENV VARS
// ---------------------------------------------------------------------------
async function checkEnvVars(): Promise<boolean> {
  console.log("\n\x1b[1m[1] ENV VARS\x1b[0m");
  const required = [
    "ANTHROPIC_API_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  // OPENAI_API_KEY is optional per deployment (Notes Coach/summarize and
  // Realtime mastery fail gracefully with a 503 if it's unset), so it's
  // checked but never fails the overall gate.
  const optional = ["OPENAI_API_KEY"];
  let allOk = true;
  for (const key of required) {
    const val = env(key);
    const ok = val.length > 0;
    result(key, ok, ok ? "(set)" : "missing or empty");
    if (!ok) allOk = false;
  }
  for (const key of optional) {
    const val = env(key);
    result(key, val.length > 0, val.length > 0 ? "(set)" : "not set — optional features will 503");
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// 2. ANTHROPIC
// ---------------------------------------------------------------------------
async function checkAnthropic(): Promise<boolean> {
  console.log("\n\x1b[1m[2] ANTHROPIC\x1b[0m");
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) {
    result("API key present", false, "skipped — key missing");
    return false;
  }
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await res.json() as Record<string, unknown>;
    if (res.ok) {
      result("API key valid + model reachable", true, `HTTP ${res.status}`);
      return true;
    } else {
      const err = (body as { error?: { message?: string } }).error;
      result("API key valid + model reachable", false, `HTTP ${res.status}: ${err?.message ?? JSON.stringify(body)}`);
      return false;
    }
  } catch (e) {
    result("API key valid + model reachable", false, String(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// 4. SUPABASE
// ---------------------------------------------------------------------------
async function checkSupabase(): Promise<boolean> {
  console.log("\n\x1b[1m[4] SUPABASE\x1b[0m");
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    result("Project URL + anon key reachable", false, "skipped — env vars missing");
    return false;
  }

  // Validate URL format
  try {
    new URL(url);
  } catch {
    result("Project URL format valid", false, `Not a valid URL: ${url}`);
    return false;
  }
  result("Project URL format valid", true, url);

  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

  // REST schema endpoint requires the service role key
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });
    const ok = res.status === 200 || res.status === 404;
    let detail = `HTTP ${res.status}`;
    if (!ok) {
      try { detail += ` — ${(await res.text()).slice(0, 300)}`; } catch { /* ignore */ }
    }
    result("Service role key accepted by REST API", ok, detail);
    if (!ok) return false;
  } catch (e) {
    result("Service role key accepted by REST API", false, String(e));
    return false;
  }

  // Confirm anon key is a valid JWT (Supabase anon keys are JWTs — decode and check exp)
  try {
    const parts = anonKey.split(".");
    if (parts.length !== 3) throw new Error("Not a valid JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8")) as { role?: string; exp?: number };
    const roleOk = payload.role === "anon";
    const expOk = !payload.exp || payload.exp * 1000 > Date.now();
    result(
      "Anon key is valid JWT (role=anon, not expired)",
      roleOk && expOk,
      roleOk && expOk ? `role=${payload.role}` : `role=${payload.role}, expired=${!expOk}`
    );
    return roleOk && expOk;
  } catch (e) {
    result("Anon key is valid JWT", false, String(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\x1b[1m\n═══════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  Hugh — Pre-build Health Check\x1b[0m");
  console.log("\x1b[1m═══════════════════════════════════\x1b[0m");

  const results = await Promise.all([
    checkEnvVars(),
    checkAnthropic(),
    checkSupabase(),
  ]);

  const [envOk, anthropicOk, supabaseOk] = results;
  const allOk = envOk && anthropicOk && supabaseOk;

  console.log("\n\x1b[1m─── Summary ───────────────────────\x1b[0m");
  console.log(`  ENV VARS       ${envOk ? PASS : FAIL}`);
  console.log(`  ANTHROPIC      ${anthropicOk ? PASS : FAIL}`);
  console.log(`  SUPABASE       ${supabaseOk ? PASS : FAIL}`);
  console.log("\x1b[1m───────────────────────────────────\x1b[0m");

  if (allOk) {
    console.log("\n\x1b[32m\x1b[1m  All checks passed. Ready to scaffold.\x1b[0m\n");
    process.exit(0);
  } else {
    console.log("\n\x1b[31m\x1b[1m  One or more checks failed. Fix issues before scaffolding.\x1b[0m\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
