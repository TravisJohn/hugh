/**
 * Ask Claude Code about Hugh's own login — through the same cleaned
 * environment and the same folder Hugh's calls use, so a login that passes
 * here is the one those calls will find. Shared by `dev-subscription.ts` and
 * `subscription-login.ts`; the decisions themselves live in
 * `lib/claude/subscription/launch.ts`, where they are tested.
 */
import { spawnSync } from "node:child_process";
import { subscriptionConfigDir } from "@/lib/claude/client";
import { childEnv } from "@/lib/claude/subscription/cliArgs";
import { loginProblem, MISSING_CLAUDE, parseLoginStatus, type LoginStatus } from "@/lib/claude/subscription/launch";

export interface HughLogin {
  configDir: string;
  status:    LoginStatus | null;
  /** Why plan mode can't use this login, or null when it can. */
  problem:   string | null;
}

/** The environment Claude Code gets from Hugh: the OS basics and the login folder, no keys. */
export function hughLoginEnv(configDir: string): NodeJS.ProcessEnv {
  // Next.js declares NODE_ENV as always present on a process environment; this
  // one leaves it out on purpose, exactly as runClaudeCli's does.
  return childEnv(process.env, configDir, {}) as NodeJS.ProcessEnv;
}

export function checkHughLogin(): HughLogin {
  const configDir = subscriptionConfigDir();
  const run = spawnSync("claude", ["auth", "status", "--json"], {
    env: hughLoginEnv(configDir),
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.error) return { configDir, status: null, problem: `${MISSING_CLAUDE} (${run.error.message})` };
  const status = parseLoginStatus(run.stdout);
  return { configDir, status, problem: loginProblem(status, configDir) };
}

/** Print the reasons and stop. A CLI's reader wants the sentence, not a stack trace. */
export function fail(lines: readonly string[]): never {
  console.error("");
  for (const line of lines) console.error(line);
  console.error("");
  process.exit(1);
}
