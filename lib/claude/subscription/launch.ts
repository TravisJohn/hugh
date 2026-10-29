/**
 * What `npm run dev:subscription` and `npm run subscription:login` check, and
 * what they say (docs/claude-subscription-local-mode.md §4.6).
 *
 * The two scripts own the processes; this module owns the decisions, so they
 * are tested here and in CI. No `server-only`: the scripts run under `tsx`,
 * outside Next.
 */
import { resolve } from "node:path";
import { resolveClaudeBilling, SUBSCRIPTION_FLAG, SubscriptionModeError } from "../billingMode";

type Env = Readonly<Record<string, string | undefined>>;

/** Plan mode listens on this computer only, never the local network. */
export const PLAN_DEV_HOST = "127.0.0.1";

/** The plan sign-in. `claude auth status` reports "console" for a pay-per-use login. */
const PLAN_AUTH_METHOD = "claude.ai";

const LOGIN_COMMAND = "npm run subscription:login";

/** Said when `claude` cannot be started at all. */
export const MISSING_CLAUDE =
  "Couldn't start `claude`. Hugh starts it without a shell, which on Windows finds the native claude.exe " +
  "but not an npm-installed claude.cmd. Install Claude Code's native build, then try again.";

/**
 * Why plan mode must not start with this configuration, one sentence each;
 * empty when it may. `env` is the shell's environment plus `.env.local`.
 */
export function launchProblems(env: Env): string[] {
  const problems: string[] = [];
  if ((env[SUBSCRIPTION_FLAG]?.trim() ?? "") !== "") {
    // If it lived in .env.local, plain `npm run dev` would start on the plan
    // too — listening on the whole network, without these checks.
    problems.push(
      `${SUBSCRIPTION_FLAG} is already set, in .env.local or your shell. Remove it: only ` +
      "npm run dev:subscription sets it, so npm run dev can never start on your plan by accident.",
    );
  }
  try {
    resolveClaudeBilling({ ...env, [SUBSCRIPTION_FLAG]: "1" });
  } catch (error) {
    if (!(error instanceof SubscriptionModeError)) throw error;
    problems.push(error.message);
  }
  return problems;
}

/** `next dev`'s arguments: the caller's own, but never a different host. */
export function planDevArgs(extra: readonly string[]): string[] {
  const host = extra.find(arg => arg.startsWith("-H") || arg.startsWith("--hostname"));
  if (host) {
    throw new SubscriptionModeError(`Plan mode always listens on ${PLAN_DEV_HOST} only; remove "${host}".`);
  }
  return ["dev", "-H", PLAN_DEV_HOST, ...extra];
}

/** The dev server's environment: the shell's, plus the flag. Nothing else sets it. */
export function planDevEnv<E extends Env>(shell: E): E & Record<typeof SUBSCRIPTION_FLAG, string> {
  return { ...shell, [SUBSCRIPTION_FLAG]: "1" };
}

export interface LoginStatus {
  loggedIn:         boolean;
  authMethod:       string;
  subscriptionType: string | null;
  configDirectory:  string | null;
}

/** `claude auth status --json`, read defensively; null when the output isn't that. */
export function parseLoginStatus(stdout: string): LoginStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || !("loggedIn" in raw)) return null;
  const s = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    loggedIn:         s.loggedIn === true,
    authMethod:       text(s.authMethod) ?? "unknown",
    subscriptionType: text(s.subscriptionType),
    configDirectory:  text(s.configDirectory),
  };
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** Why this login can't serve Hugh on the plan, or null when it can. */
export function loginProblem(status: LoginStatus | null, configDir: string): string | null {
  if (!status) return `Couldn't read Claude Code's login status for ${configDir}.`;
  // The trap stage 1 fell into: a mistyped folder reads exactly like signed out.
  if (status.configDirectory && !samePath(status.configDirectory, configDir)) {
    return `Claude Code checked ${status.configDirectory}, not Hugh's login folder ${configDir}.`;
  }
  if (!status.loggedIn) return `Hugh's Claude login (${configDir}) is signed out. Run ${LOGIN_COMMAND}.`;
  if (status.authMethod !== PLAN_AUTH_METHOD) {
    return `Hugh's Claude login (${configDir}) uses "${status.authMethod}", which is billed per use rather than ` +
      `covered by your plan. Run ${LOGIN_COMMAND} to sign in with your Claude plan.`;
  }
  return null;
}
