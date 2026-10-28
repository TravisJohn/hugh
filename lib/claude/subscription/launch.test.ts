import { describe, it, expect } from "vitest";
import {
  launchProblems,
  loginProblem,
  parseLoginStatus,
  planDevArgs,
  planDevEnv,
  PLAN_DEV_HOST,
  type LoginStatus,
} from "./launch";

const OWNER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DIR = "C:\\Users\\owner\\.claude-hugh";
const signedIn: LoginStatus = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", configDirectory: DIR };

/** The checks that keep plan mode local, owned and on the plan — before anything starts. */
describe("launchProblems", () => {
  it("lets plan mode start with an owner named and nothing marking production", () => {
    expect(launchProblems({ HUGH_SUBSCRIPTION_OWNER_ID: OWNER })).toEqual([]);
  });

  it("refuses when the flag already lives in .env.local, where plain npm run dev would pick it up", () => {
    const problems = launchProblems({ HUGH_SUBSCRIPTION_OWNER_ID: OWNER, HUGH_CLAUDE_SUBSCRIPTION: "1" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Remove it/);
  });

  it("refuses without an owner, because a plan with nobody it may serve is a misconfiguration", () => {
    expect(launchProblems({})[0]).toMatch(/HUGH_SUBSCRIPTION_OWNER_ID/);
  });

  it("refuses anywhere a production marker is set", () => {
    for (const marker of [{ NODE_ENV: "production" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" }]) {
      expect(launchProblems({ HUGH_SUBSCRIPTION_OWNER_ID: OWNER, ...marker })).toHaveLength(1);
    }
  });
});

describe("planDevArgs", () => {
  it("binds the dev server to this computer only", () => {
    expect(planDevArgs([])).toEqual(["dev", "-H", PLAN_DEV_HOST]);
    expect(PLAN_DEV_HOST).toBe("127.0.0.1");
  });

  it("passes other next dev options through", () => {
    expect(planDevArgs(["-p", "3001"])).toEqual(["dev", "-H", "127.0.0.1", "-p", "3001"]);
  });

  it("refuses any attempt to listen elsewhere, in every spelling", () => {
    for (const extra of [["-H", "0.0.0.0"], ["--hostname", "0.0.0.0"], ["--hostname=0.0.0.0"], ["-H0.0.0.0"]]) {
      expect(() => planDevArgs(extra)).toThrow(/127\.0\.0\.1/);
    }
  });
});

describe("planDevEnv", () => {
  it("adds the flag and keeps the shell's environment otherwise as it was", () => {
    expect(planDevEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin", HUGH_CLAUDE_SUBSCRIPTION: "1" });
  });
});

describe("parseLoginStatus", () => {
  it("reads the fields Hugh needs from claude auth status --json, and nothing more", () => {
    const stdout = JSON.stringify({ ...signedIn, apiProvider: "firstParty", email: "someone@example.com" });
    expect(parseLoginStatus(stdout)).toEqual(signedIn);
  });

  it("returns null for anything that isn't a status report", () => {
    expect(parseLoginStatus("Not logged in")).toBeNull();
    expect(parseLoginStatus("[]")).toBeNull();
  });
});

describe("loginProblem", () => {
  it("accepts a plan login in Hugh's own folder", () => {
    expect(loginProblem(signedIn, DIR)).toBeNull();
  });

  it("matches the folder whatever the letter case, as Windows does", () => {
    expect(loginProblem({ ...signedIn, configDirectory: DIR.toLowerCase() }, DIR)).toBeNull();
  });

  it("says when Claude Code looked in a different folder, since that reads exactly like signed out", () => {
    expect(loginProblem({ ...signedIn, configDirectory: "C:\\Users\\owner\\.claude" }, DIR)).toMatch(/not Hugh's login folder/);
  });

  it("sends a signed-out login to the login command", () => {
    expect(loginProblem({ ...signedIn, loggedIn: false, authMethod: "none" }, DIR)).toMatch(/npm run subscription:login/);
  });

  it("refuses a pay-per-use Console login, which would bill rather than use the plan", () => {
    expect(loginProblem({ ...signedIn, authMethod: "console" }, DIR)).toMatch(/billed per use/);
  });

  it("refuses when the status could not be read at all", () => {
    expect(loginProblem(null, DIR)).toMatch(/Couldn't read/);
  });
});
