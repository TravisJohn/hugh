// Guards on the routes, read from disk, for local subscription mode
// (docs/claude-subscription-local-mode.md). The point of that mode is that
// exploring on the owner's Claude plan spends no money; these fail the build
// when a route would quietly break that, rather than leaving it to be found
// on a bill.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** Every `route.ts` under app/api, as repo-relative POSIX paths. */
function apiRouteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") out.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  walk(join(ROOT, "app/api"));
  return out;
}

const routes = apiRouteFiles().map(file => ({ file, src: readFileSync(join(ROOT, file), "utf8") }));

/**
 * Routes that pay a provider the Claude plan doesn't cover. A route that pays
 * one through a `lib` module instead of reading the key itself is not seen
 * here — today every paid route reads its own key.
 */
const PAID_KEYS = /process\.env\.(OPENAI_API_KEY|ELEVENLABS_API_KEY)\b/;

/**
 * Claude routes whose failures are deliberately not shown to the learner.
 * Each needs a reason a reviewer can check.
 */
const PLAN_FAILURE_EXEMPT: Record<string, string> = {
  // Any failure hands the learner a ready-made sample drill instead, and the
  // usage gate's own refusal does the same.
  "app/api/code/generate-drill/route.ts": "falls back to a sample drill by design",
};

describe("subscription mode — route guards", () => {
  it("finds the routes it guards, so an empty scan cannot pass for a clean one", () => {
    expect(routes.filter(r => PAID_KEYS.test(r.src)).length).toBeGreaterThanOrEqual(5);
    // Twelve since narrow Learn PR D took three routes off Claude: refine and
    // document extract are retired, and goal creation only builds courses.
    expect(routes.filter(r => r.src.includes("claudeClient()")).length).toBeGreaterThanOrEqual(12);
  });

  it("switches off every route that pays OpenAI or ElevenLabs, before it reserves anything", () => {
    const unguarded = routes
      .filter(r => PAID_KEYS.test(r.src))
      .filter(r => {
        const off = r.src.indexOf("paidServiceOffResponse(");
        const gate = r.src.search(/enforceUsageGate\(|checkUsageAllowed\(/);
        return off < 0 || (gate >= 0 && gate < off);
      })
      .map(r => r.file);
    expect(unguarded).toEqual([]);
  });

  it("tells the learner why a plan-served Claude call failed, on every Claude route", () => {
    const silent = routes
      .filter(r => r.src.includes("claudeClient()") && !(r.file in PLAN_FAILURE_EXEMPT))
      .filter(r => !r.src.includes("textBudgetResponse(") && !r.src.includes("planFailureResponse("))
      .map(r => r.file);
    expect(silent).toEqual([]);
  });

  it("keeps every exemption pointing at a real Claude route", () => {
    for (const file of Object.keys(PLAN_FAILURE_EXEMPT)) {
      expect(routes.find(r => r.file === file)?.src).toContain("claudeClient()");
    }
  });
});
