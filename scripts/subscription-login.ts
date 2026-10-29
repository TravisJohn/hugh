/**
 * npm run subscription:login — sign Hugh's own Claude Code login in to your
 * Claude plan (docs/claude-subscription-local-mode.md §4.6).
 *
 * Runs Claude Code's own sign-in, in the browser it opens, against Hugh's
 * login folder rather than your everyday one. You sign in yourself. The token
 * stays in that folder, where Claude Code keeps it; Hugh never reads, stores
 * or passes it.
 */
import { spawnSync } from "node:child_process";
import { subscriptionConfigDir } from "@/lib/claude/client";
import { MISSING_CLAUDE } from "@/lib/claude/subscription/launch";
import { checkHughLogin, fail, hughLoginEnv } from "./lib/claudeLogin";

const configDir = subscriptionConfigDir();
console.log(`\nSigning Hugh's own Claude Code login (${configDir}) in to your Claude plan.\n`);

// `--claudeai` is the plan sign-in, never the pay-per-use Console one; and the
// cleaned environment means no API key in this shell can stand in for it.
const signIn = spawnSync("claude", ["auth", "login", "--claudeai"], { env: hughLoginEnv(configDir), stdio: "inherit" });
if (signIn.error) fail([`${MISSING_CLAUDE} (${signIn.error.message})`]);
if (signIn.status !== 0) fail(["Claude Code's sign-in didn't finish. Run npm run subscription:login to try again."]);

const login = checkHughLogin();
if (login.problem) fail([login.problem]);
console.log(`\nSigned in (plan: ${login.status?.subscriptionType ?? "unknown"}). Start Hugh on it with npm run dev:subscription.\n`);
