/**
 * API integration test — calls all 4 interview routes via HTTP.
 * Uses the dev auth bypass (SUPABASE_SERVICE_ROLE_KEY in Authorization header).
 * Run with: npx tsx scripts/test-api.ts
 */
import fs from "fs";
import path from "path";

// ── Load .env.local ───────────────────────────────────────────────────────
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

const BASE = "http://localhost:3000";
const AUTH_HEADER = `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`;

const PASS = "\x1b[32m✓ PASS\x1b[0m";
const FAIL = "\x1b[31m✗ FAIL\x1b[0m";

function log(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? `\n         ${detail}` : ""}`);
  return ok;
}

async function apiPost(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": AUTH_HEADER,
    },
    body: JSON.stringify(body),
  });
}

// ── Test 1: check-similarity ──────────────────────────────────────────────
async function testCheckSimilarity(): Promise<boolean> {
  console.log("\n\x1b[1m[1] POST /api/interview/check-similarity\x1b[0m");

  const res = await apiPost("/api/interview/check-similarity", {
    bestAnswer:
      "A fault-tolerant pipeline should use idempotent operations, checkpointing, " +
      "dead-letter queues for failed records, and retry logic with exponential backoff. " +
      "Monitoring and alerting on data quality metrics is also critical.",
    transcript:
      "I would make the pipeline idempotent so re-runs don't cause duplicates, " +
      "add dead-letter queues for bad records, and use checkpointing to resume from failures.",
  });

  const ok = res.ok;
  const json = await res.json() as Record<string, unknown>;
  console.log("  Raw response:", JSON.stringify(json, null, 2));
  log(`HTTP ${res.status}`, ok);
  log(
    "Response shape valid",
    typeof json.usedBestAnswer === "boolean" && typeof json.alignmentScore === "number",
    `usedBestAnswer=${json.usedBestAnswer}, alignmentScore=${json.alignmentScore}`
  );
  return ok;
}

// ── Test 2: generate-question (intro Q1) ──────────────────────────────────
async function testGenerateQuestion(): Promise<boolean> {
  console.log("\n\x1b[1m[2] POST /api/interview/generate-question (intro, index 0)\x1b[0m");

  const res = await apiPost("/api/interview/generate-question", {
    room:              "data_engineering",
    questionType:      "intro",
    questionIndex:     0,
    previousQuestions: [],
    // sessionId omitted → skips DB save
  });

  const ok = res.ok;
  const json = await res.json() as Record<string, unknown>;
  console.log("  Raw response:", JSON.stringify(json, null, 2));
  log(`HTTP ${res.status}`, ok);
  log(
    "Response shape valid",
    typeof json.question === "string" && typeof json.bestAnswer === "string",
    `question length=${(json.question as string)?.length}, bestAnswer length=${(json.bestAnswer as string)?.length}`
  );
  return ok;
}

// ── Test 3: generate-question (domain) ────────────────────────────────────
async function testGenerateQuestionDomain(): Promise<boolean> {
  console.log("\n\x1b[1m[3] POST /api/interview/generate-question (domain)\x1b[0m");

  const res = await apiPost("/api/interview/generate-question", {
    room:              "data_engineering",
    questionType:      "domain",
    questionIndex:     2,
    previousQuestions: ["Tell me about yourself and your background."],
    // sessionId omitted → skips DB save
  });

  const ok = res.ok;
  const json = await res.json() as Record<string, unknown>;
  console.log("  Raw response:", JSON.stringify(json, null, 2));
  log(`HTTP ${res.status}`, ok);
  log(
    "Response shape valid",
    typeof json.question === "string" && typeof json.bestAnswer === "string"
  );
  return ok;
}

// ── Test 4: generate-feedback ─────────────────────────────────────────────
async function testGenerateFeedback(): Promise<boolean> {
  console.log("\n\x1b[1m[4] POST /api/interview/generate-feedback\x1b[0m");

  const res = await apiPost("/api/interview/generate-feedback", {
    question:
      "How would you design a fault-tolerant data pipeline?",
    bestAnswer:
      "Use idempotent operations, checkpointing, dead-letter queues, " +
      "and retry logic with exponential backoff. Monitor data quality metrics throughout.",
    transcript:
      "I'd add retry logic and make sure operations are idempotent to avoid duplicate data.",
    viewedBestAnswer: false,
    usedBestAnswer:   false,
    // questionId omitted → skips DB save
  });

  const ok = res.ok;
  const json = await res.json() as Record<string, unknown>;
  console.log("  Raw response:", JSON.stringify(json, null, 2));
  log(`HTTP ${res.status}`, ok);
  log(
    "Response shape valid",
    typeof json.feedback === "string" && (json.feedback as string).length > 0,
    `feedback length=${(json.feedback as string)?.length}`
  );
  return ok;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log("\x1b[1m\n══════════════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  Hugh — API Route Integration Tests\x1b[0m");
  console.log("\x1b[1m══════════════════════════════════════════\x1b[0m");

  const results = [
    await testCheckSimilarity(),
    await testGenerateQuestion(),
    await testGenerateQuestionDomain(),
    await testGenerateFeedback(),
  ];

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log(`\n\x1b[1m── Result: ${passed}/${total} passed ──────────────────────\x1b[0m`);
  if (passed === total) {
    console.log("\x1b[32m\x1b[1m  All routes operational.\x1b[0m\n");
    process.exit(0);
  } else {
    console.log("\x1b[31m\x1b[1m  Some routes failed. Check output above.\x1b[0m\n");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
