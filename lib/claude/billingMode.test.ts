import { describe, it, expect } from "vitest";
import {
  resolveClaudeBilling,
  mayUseClaude,
  usageModelFor,
  servableByPlan,
  SubscriptionModeError,
  SUBSCRIPTION_FLAG,
  SUBSCRIPTION_OWNER_VAR,
  SUBSCRIPTION_RATE_SUFFIX,
} from "./billingMode";
import { MODEL_RATES } from "@/lib/pricing";

/**
 * Subscription mode serves Claude calls from the owner's own plan. Anthropic
 * allows that for the owner on their own machine and nowhere else, so these
 * tests guard the two failures that matter: the mode leaking into production
 * or to another user, and a misconfiguration quietly billing the API key.
 */
const OWNER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const local = { [SUBSCRIPTION_FLAG]: "1", [SUBSCRIPTION_OWNER_VAR]: OWNER, NODE_ENV: "development" };

describe("resolveClaudeBilling", () => {
  it("stays on the API when the flag is unset, empty or 0, so plain `npm run dev` is unchanged", () => {
    expect(resolveClaudeBilling({})).toEqual({ kind: "api" });
    expect(resolveClaudeBilling({ [SUBSCRIPTION_FLAG]: "" })).toEqual({ kind: "api" });
    expect(resolveClaudeBilling({ [SUBSCRIPTION_FLAG]: "0" })).toEqual({ kind: "api" });
  });

  it("serves the named owner from the plan when the flag is 1 in local dev", () => {
    expect(resolveClaudeBilling(local)).toEqual({ kind: "subscription", ownerUserId: OWNER });
  });

  it("refuses any flag value other than 1, so a typo never silently bills the API", () => {
    expect(() => resolveClaudeBilling({ ...local, [SUBSCRIPTION_FLAG]: "true" })).toThrow(SubscriptionModeError);
    expect(() => resolveClaudeBilling({ ...local, [SUBSCRIPTION_FLAG]: "yes" })).toThrow(SubscriptionModeError);
  });

  it("refuses a production build, so `next build` and `next start` fail loudly with the flag set", () => {
    expect(() => resolveClaudeBilling({ ...local, NODE_ENV: "production" })).toThrow(/production/);
  });

  it("refuses on Vercel, previews included, even when NODE_ENV says otherwise", () => {
    expect(() => resolveClaudeBilling({ ...local, VERCEL: "1" })).toThrow(/VERCEL/);
    expect(() => resolveClaudeBilling({ ...local, VERCEL_ENV: "preview" })).toThrow(/VERCEL_ENV/);
  });

  it("ignores production markers when the flag is off, so deployed Hugh is untouched", () => {
    expect(resolveClaudeBilling({ NODE_ENV: "production", VERCEL: "1" })).toEqual({ kind: "api" });
  });

  it("refuses to start without a valid owner, because a plan with nobody to serve is a misconfiguration", () => {
    expect(() => resolveClaudeBilling({ ...local, [SUBSCRIPTION_OWNER_VAR]: undefined })).toThrow(SubscriptionModeError);
    expect(() => resolveClaudeBilling({ ...local, [SUBSCRIPTION_OWNER_VAR]: "travis" })).toThrow(SubscriptionModeError);
  });

  it("normalises the owner id so a pasted upper-case id still matches Supabase's lower-case one", () => {
    const billing = resolveClaudeBilling({ ...local, [SUBSCRIPTION_OWNER_VAR]: `  ${OWNER.toUpperCase()} ` });
    expect(billing).toEqual({ kind: "subscription", ownerUserId: OWNER });
  });
});

describe("mayUseClaude", () => {
  const plan = resolveClaudeBilling(local);

  it("lets every user through on the API, exactly as today", () => {
    expect(mayUseClaude({ kind: "api" }, "anyone")).toBe(true);
  });

  it("lets only the owner spend on the plan, so no other account ever rides it", () => {
    expect(mayUseClaude(plan, OWNER)).toBe(true);
    expect(mayUseClaude(plan, OWNER.toUpperCase())).toBe(true);
    expect(mayUseClaude(plan, "0b1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f")).toBe(false);
  });
});

describe("usageModelFor", () => {
  it("logs the route's own model on the API, so production rows are unchanged", () => {
    expect(usageModelFor({ kind: "api" }, "claude-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("labels plan-served calls as a rate class, so they are priced at $0 rather than API rates", () => {
    expect(usageModelFor(resolveClaudeBilling(local), "claude-sonnet-4-6")).toBe("claude-sonnet-4-6@subscription");
  });

  it("never relabels another provider's row, because a Claude plan does not pay for OpenAI", () => {
    expect(usageModelFor(resolveClaudeBilling(local), "gpt-4o")).toBe("gpt-4o");
  });

  it("has a $0 rate class for every Claude model Hugh prices, so a new model can't be logged at the fallback rate", () => {
    for (const model of Object.keys(MODEL_RATES).filter(id => servableByPlan(id) && !id.endsWith(SUBSCRIPTION_RATE_SUFFIX))) {
      expect(MODEL_RATES[usageModelFor(resolveClaudeBilling(local), model)], model).toEqual({ input: 0, output: 0 });
    }
  });
});
