/**
 * Automated QA for the Case Lab worked notebook.
 *
 *   node scripts/verify-notebooks.mjs              → every case that has a notebook
 *   node scripts/verify-notebooks.mjs --case=id    → just one case
 *   node scripts/verify-notebooks.mjs --headed     → watch it happen
 *   node scripts/verify-notebooks.mjs --slow       → also test the hang timeout (+~30s)
 *
 * WHY THIS EXISTS
 * The pure invalidation rules are unit-tested (lib/case-lab/notebook.test.ts) and
 * the cell Python can be checked headlessly, but neither touches the part that
 * actually breaks: Pyodide booting in a real worker, the CSV binding as `df`,
 * pandas rendering to HTML, and the UI honouring the stale/halt/session-loss
 * rules. That gap is what a human was doing by hand, one case at a time.
 *
 * It drives a real browser against a real dev server, so a pass here means the
 * thing genuinely works — not that a mock agreed with itself.
 *
 * WHAT IT DOES NOT COVER
 * Looks. Spacing, colour, and whether the reasoning above each cell reads well
 * are human judgements and stay human. This checks behaviour and results.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { requireTestUserPassword } from "./testUserPassword.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES_DIR = join(ROOT, "public", "case-lab");

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE_URL = flag("base-url", "http://localhost:3000").replace(/\/$/, "");

// Case Lab case pages call verifyUserAccess(), so this needs a real session.
// Defaults to the user scripts/seed-test-user.mjs keeps, whose password lives in
// .env.local; override for a different local user.
const ENV_FILE = join(ROOT, ".env.local");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const QA_EMAIL = process.env.QA_EMAIL ?? flag("email", "test_user@testmail.com");
const QA_PASSWORD = process.env.QA_PASSWORD ?? flag("password") ?? requireTestUserPassword(process.env);
const ONLY_CASE = flag("case");
const HEADED = has("headed");
const SLOW = has("slow");

// Pyodide + pandas is ~20MB from a CDN on the first case. Everything after it is
// served from the browser cache, which is why one context is reused throughout.
const BOOT_TIMEOUT_MS = 240_000;
const RUN_TIMEOUT_MS = 120_000;
// The client kills a cell at 20s; allow for the respawn and the UI settling.
const HANG_TIMEOUT_MS = 45_000;

// ── Reporting ───────────────────────────────────────────────────────────────

const results = [];
let currentCase = "—";

function record(name, ok, detail = "") {
  results.push({ case: currentCase, name, ok, detail });
  const mark = ok ? "[32mPASS[0m" : "[31mFAIL[0m";
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function check(name, condition, detail = "") {
  record(name, Boolean(condition), condition ? "" : detail);
  return Boolean(condition);
}

// ── Case discovery ──────────────────────────────────────────────────────────

/** Every case that ships a notebook. Cases without one are correctly skipped. */
function discoverCases() {
  const found = [];
  for (const id of readdirSync(CASES_DIR)) {
    const file = join(CASES_DIR, id, "case.json");
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.error(`  ! ${id}/case.json is not valid JSON — ${err.message}`);
      process.exitCode = 1;
      continue;
    }
    if (parsed?.notebook?.cells?.length) {
      found.push({ id: parsed.id ?? id, cells: parsed.notebook.cells.length });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

// ── Dev server ──────────────────────────────────────────────────────────────

async function serverIsUp() {
  try {
    const res = await fetch(`${BASE_URL}/cases/lab`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok || res.status === 307 || res.status === 308;
  } catch {
    return false;
  }
}

/**
 * Starts `npm run dev` only if nothing is answering. Returns a stop function, so
 * a server the operator already had running is never killed out from under them.
 */
async function ensureServer() {
  if (await serverIsUp()) {
    console.log(`Using the server already running at ${BASE_URL}\n`);
    return () => {};
  }

  console.log(`No server at ${BASE_URL} — starting one (this takes a moment)…`);
  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    shell: true,
    stdio: "ignore",
    detached: false,
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await serverIsUp()) {
      console.log("Server is up.\n");
      return () => stopServer(child);
    }
    if (child.exitCode !== null) break;
  }
  stopServer(child);
  throw new Error("The dev server did not come up. Start it yourself and re-run.");
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  // next dev spawns children; killing only the shell leaves the port held.
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

// ── Authentication ──────────────────────────────────────────────────────────

/**
 * Signs in once per run. The cookies live on the browser context, so every case
 * page afterwards is already authenticated.
 *
 * Case Lab looked public — only /interview is gated in proxy.ts — but each case
 * page calls verifyUserAccess() itself and redirects to /login without a session.
 */
async function signIn(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.fill("#email", QA_EMAIL);
  await page.fill("#password", QA_PASSWORD);
  await page.click('button[type="submit"]');

  try {
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 45_000 });
  } catch {
    const message = await page
      .locator(".text-red-400")
      .first()
      .innerText()
      .catch(() => "");
    throw new Error(
      `Could not sign in as ${QA_EMAIL}${message ? ` — "${message.trim()}"` : ""}. ` +
        `Seed the local test user with: node scripts/seed-test-user.mjs`,
    );
  }
  console.log(`Signed in as ${QA_EMAIL}.
`);
}

// ── Page helpers ────────────────────────────────────────────────────────────

const statuses = (page) =>
  page.$$eval('[data-testid="nb-cell"]', (els) =>
    els.map((el) => el.getAttribute("data-status")),
  );

/** Waits until no cell is mid-run — the notebook is idle again. */
async function settle(page, timeout = RUN_TIMEOUT_MS) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[data-testid="nb-cell"]')].some(
        (el) => el.getAttribute("data-status") === "running",
      ),
    null,
    { timeout },
  );
}

async function runAll(page) {
  await page.click('[data-testid="nb-run-all"]');
  // Give the first cell a beat to flip to running before waiting for quiet.
  await page.waitForTimeout(400);
  await settle(page);
}

async function runCell(page, index) {
  await page.locator('[data-testid="nb-run-cell"]').nth(index).click();
  await page.waitForTimeout(400);
  await settle(page);
}

/** Replaces one CodeMirror cell's source. */
async function setCellCode(page, index, code) {
  const editor = page.locator('[data-testid="nb-cell"]').nth(index).locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
  await page.waitForTimeout(200);
}

async function resetNotebook(page) {
  await page.click("button:has-text('Reset')");
  await page.waitForTimeout(300);
}

/** Opens the notebook and waits for `df` to be bound. */
async function openNotebook(page, caseId) {
  await page.goto(`${BASE_URL}/cases/lab/${caseId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  const section = page.locator('[data-testid="nb-section"]');
  await section.waitFor({ timeout: 30_000 });

  if (!check("notebook starts collapsed", (await section.getAttribute("data-status")) === "closed"))
    return false;

  await page.click('[data-testid="nb-open"]');

  try {
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="nb-section"]')?.getAttribute("data-status") ===
        "ready",
      null,
      { timeout: BOOT_TIMEOUT_MS },
    );
  } catch {
    const status = await section.getAttribute("data-status");
    const message = await section.innerText().catch(() => "");
    check("Python boots and binds df", false, `stuck at "${status}" — ${message.slice(0, 200)}`);
    return false;
  }

  const summary = await section.innerText();
  const bound = /df\s+is loaded — ([\d,]+) rows/.exec(summary);
  check("Python boots and binds df", Boolean(bound), "no row count rendered");
  if (bound) console.log(`        df = ${bound[1]} rows`);
  return true;
}

// ── The content check, run for every case ───────────────────────────────────

async function verifyCase(page, entry) {
  currentCase = entry.id;
  console.log(`\n[1m${entry.id}[0m (${entry.cells} cells)`);

  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  if (!(await openNotebook(page, entry.id))) return;

  await runAll(page);

  const after = await statuses(page);
  check(
    "every cell runs clean",
    after.every((s) => s === "done"),
    `statuses: ${after.join(", ")}`,
  );

  // A cell that "succeeds" but renders nothing is a broken cell with good manners.
  const empties = await page.$$eval('[data-testid="nb-cell"]', (els) =>
    els
      .map((el, i) => ({ i, text: el.querySelector("pre, table") ? "" : "empty" }))
      .filter((c) => c.text)
      .map((c) => c.i + 1),
  );
  check("every cell produces output", empties.length === 0, `silent cells: ${empties.join(", ")}`);

  const progress = await page.locator('[data-testid="nb-progress"]').first();
  const done = Number(await progress.getAttribute("data-done"));
  const total = Number(await progress.getAttribute("data-total"));
  check("progress counter agrees", done === total && total === entry.cells, `${done}/${total}`);

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  page.removeAllListeners("pageerror");
}

// ── The behaviour checks, run once ──────────────────────────────────────────

async function verifyBehaviour(page, entry) {
  currentCase = `${entry.id} [rules]`;
  console.log(`\n[1mNotebook rules[0m (on ${entry.id})`);

  if (entry.cells < 3) {
    record("behaviour suite", false, "needs a notebook of 3+ cells; skipped");
    return;
  }

  // Re-running an earlier cell moves the shared namespace on, so every output
  // below it is no longer trustworthy and must say so.
  await runCell(page, 0);
  let s = await statuses(page);
  check(
    "re-running a cell stales the ones below it",
    s[0] === "done" && s.slice(1).every((x) => x === "stale"),
    s.join(", "),
  );

  // Editing invalidates the edited cell too — its own output no longer matches
  // the code sitting above it on screen.
  await resetNotebook(page);
  await runAll(page);
  await setCellCode(page, 2, "df.shape");
  s = await statuses(page);
  check(
    "editing a cell stales itself and below",
    s.slice(0, 2).every((x) => x === "done") && s.slice(2).every((x) => x === "stale"),
    s.join(", "),
  );

  // With one shared namespace, carrying on past an error buries it under a pile
  // of NameErrors from every cell that depended on it.
  await resetNotebook(page);
  await setCellCode(page, 1, "df.no_such_column_exists");
  await runAll(page);
  s = await statuses(page);
  check(
    "run all halts at the first error",
    s[0] === "done" && s[1] === "error" && s.slice(2).every((x) => x === "idle"),
    s.join(", "),
  );

  const errorText = await page
    .locator('[data-testid="nb-cell"]')
    .nth(1)
    .locator("pre")
    .first()
    .innerText()
    .catch(() => "");
  check(
    "the error is shown to the learner",
    /AttributeError|no_such_column_exists/.test(errorText),
    errorText.slice(0, 120) || "no error text rendered",
  );

  await resetNotebook(page);

  if (!SLOW) {
    console.log("  [90mSKIP[0m  hung-cell recovery (pass --slow to include it)");
    return;
  }

  // A hang costs the whole namespace. The client clears every output AND reports
  // the timeout on the offending cell — the outputs go, but the learner is told
  // why, rather than finding a silently empty notebook.
  await setCellCode(page, 0, "while True:\n    pass");
  await page.locator('[data-testid="nb-run-cell"]').nth(0).click();
  try {
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="nb-cell"]')].every(
          (el) => el.getAttribute("data-status") !== "running",
        ),
      null,
      { timeout: HANG_TIMEOUT_MS },
    );
  } catch {
    check("a hung cell is stopped", false, "the cell never stopped running");
    return;
  }

  s = await statuses(page);
  check(
    "a hung cell is stopped and every output cleared",
    s[0] === "error" && s.slice(1).every((x) => x === "idle"),
    s.join(", "),
  );

  const hangText = await page
    .locator('[data-testid="nb-cell"]')
    .nth(0)
    .locator("pre")
    .first()
    .innerText()
    .catch(() => "");
  check(
    "the restart is explained, not silent",
    /session restarted/i.test(hangText),
    hangText.slice(0, 120) || "no message rendered",
  );

  // The point of respawning and re-binding the CSV is that the learner can carry
  // on. The restart message says "run from the top", so running from the top has
  // to actually work — and the session status stays "ready" the whole time, so
  // nothing on screen tells the learner to wait. Measure how long it really takes.
  await resetNotebook(page);
  const deadline = Date.now() + 90_000;
  let recovered = false;
  let firstError = "";
  let waited = 0;
  while (Date.now() < deadline) {
    await runAll(page);
    s = await statuses(page);
    if (s.every((x) => x === "done")) {
      recovered = true;
      break;
    }
    if (!firstError) {
      firstError = await page
        .locator('[data-testid="nb-cell"]')
        .nth(0)
        .locator("pre")
        .first()
        .innerText()
        .catch(() => "");
    }
    await page.waitForTimeout(3000);
    waited += 3;
    await resetNotebook(page);
  }
  check(
    "the notebook still works after a restart",
    recovered,
    `never recovered; first error: ${firstError.slice(0, 160)}`,
  );
  if (recovered && waited > 0) {
    record(
      "recovery is immediate",
      false,
      `took ~${waited}s of retrying — the session says "ready" while it is still re-binding. ` +
        `First error: ${firstError.slice(0, 120)}`,
    );
  } else if (recovered) {
    record("recovery is immediate", true);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  let cases = discoverCases();
  if (ONLY_CASE) cases = cases.filter((c) => c.id === ONLY_CASE);

  const total = readdirSync(CASES_DIR).filter((d) =>
    existsSync(join(CASES_DIR, d, "case.json")),
  ).length;

  if (cases.length === 0) {
    console.log(ONLY_CASE ? `No notebook on case "${ONLY_CASE}".` : "No case has a notebook yet.");
    return;
  }

  console.log(
    `Case Lab notebook QA — ${cases.length} of ${total} cases carry a notebook.\n`,
  );

  const stop = await ensureServer();
  const browser = await chromium.launch({ headless: !HEADED });
  // One context throughout: the first case pays for the Pyodide download, the
  // rest are served from cache. Fresh contexts would re-download 20MB each time.
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await signIn(page);
    for (const entry of cases) {
      await verifyCase(page, entry);
    }
    await verifyBehaviour(page, cases[0]);
  } finally {
    await browser.close();
    stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(64)}`);
  if (failed.length === 0) {
    console.log(`[32mAll ${results.length} checks passed.[0m`);
  } else {
    console.log(`[31m${failed.length} of ${results.length} checks failed:[0m`);
    for (const f of failed) console.log(`  • [${f.case}] ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n[31mQA run could not complete:[0m ${err.message}`);
  process.exitCode = 1;
});
