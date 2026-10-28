/**
 * npm run dev:subscription — Hugh on your own Claude plan, on this computer
 * only (docs/claude-subscription-local-mode.md §4.6).
 *
 * The one place HUGH_CLAUDE_SUBSCRIPTION is ever set. It checks the
 * configuration and Hugh's Claude login first, so a problem is one clear line
 * here instead of a refusal on every route, then starts `next dev` bound to
 * 127.0.0.1 with the flag set.
 *
 *   npm run dev:subscription              start
 *   npm run dev:subscription -- --check   run the checks, start nothing
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { SubscriptionModeError } from "@/lib/claude/billingMode";
import { launchProblems, planDevArgs, planDevEnv, PLAN_DEV_HOST } from "@/lib/claude/subscription/launch";
import { loadEnvLocal } from "./lib/env";
import { checkHughLogin, fail } from "./lib/claudeLogin";

// The server gets the shell's environment, not this script's copy of
// .env.local: Next reads that file itself, exactly as it does for npm run dev.
const shell = { ...process.env };
loadEnvLocal();

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

const problems = launchProblems(process.env);
if (problems.length > 0) fail(problems);

let devArgs: string[];
try {
  devArgs = planDevArgs(args.filter(arg => arg !== "--check"));
} catch (error) {
  if (!(error instanceof SubscriptionModeError)) throw error;
  fail([error.message]);
}

const login = checkHughLogin();
if (login.problem) fail([login.problem]);

console.log([
  "",
  `Hugh on your Claude plan (${login.status?.subscriptionType ?? "plan"}), listening on ${PLAN_DEV_HOST} only.`,
  "  Claude calls use your plan's limits, not the API key.",
  "  Only the owner account can use Claude here.",
  "  Off: the Coach, Notes summaries, spoken and Realtime voice, the architecture assistant.",
  "",
].join("\n"));

if (checkOnly) process.exit(0);

// Started through node rather than the `next` shim, which on Windows is a .cmd
// that cannot be spawned without a shell.
const nextBin = createRequire(join(process.cwd(), "package.json")).resolve("next/dist/bin/next");
const server = spawn(process.execPath, [nextBin, ...devArgs], { stdio: "inherit", env: planDevEnv(shell) });
server.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
