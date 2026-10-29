// The production stops for local subscription mode
// (docs/claude-subscription-local-mode.md §4.6), pinned so CI fails if one is
// quietly removed.
//
// Two stops are tested where they live: the refusal in a production build or
// on Vercel (billingMode.test.ts, client.test.ts) and the owner lock
// (usage.test.ts). These are the ones that live in the shape of the
// repository rather than in a function: who may set the flag, and where a
// plan-mode server listens.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { planDevArgs } from "./launch";

const ROOT = process.cwd();
const FLAG = "HUGH_CLAUDE_SUBSCRIPTION";

/** Non-test source files under the code folders, plus the root config Next reads. */
function sourceFiles(): string[] {
  const out: string[] = ["proxy.ts", "next.config.ts"].filter(f => existsSync(join(ROOT, f)));
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".next") walk(full);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  for (const dir of ["app", "lib", "components", "hooks", "utils", "types", "scripts", "tools"]) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  }
  return out;
}

const sources = sourceFiles().map(file => ({ file, src: readFileSync(join(ROOT, file), "utf8") }));
const packageScripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

describe("subscription mode — production stops", () => {
  it("scans real source, so an empty scan cannot pass for a clean one", () => {
    expect(sources.some(s => s.file === "lib/claude/billingMode.ts")).toBe(true);
    expect(sources.length).toBeGreaterThan(100);
  });

  it("names the flag in code only where it is defined and where it is set", () => {
    const naming = sources.filter(s => s.src.includes(FLAG)).map(s => s.file).sort();
    expect(naming).toEqual(["lib/claude/billingMode.ts", "scripts/dev-subscription.ts"]);
  });

  it("sets the flag only in the plan-mode launcher, never by writing to process.env", () => {
    const setters = sources
      .filter(s => s.src.includes("planDevEnv(") && s.file !== "lib/claude/subscription/launch.ts")
      .map(s => s.file);
    expect(setters).toEqual(["scripts/dev-subscription.ts"]);
    expect(sources.filter(s => /process\.env\[SUBSCRIPTION_FLAG\]\s*=[^=]/.test(s.src))).toEqual([]);
  });

  it("starts the launcher from one npm script, which no build or start step reaches", () => {
    const launching = Object.entries(packageScripts).filter(([, cmd]) => cmd.includes("dev-subscription")).map(([name]) => name);
    expect(launching).toEqual(["dev:subscription"]);
    for (const cmd of Object.values(packageScripts)) expect(cmd).not.toContain(FLAG);
  });

  it("keeps the flag out of .env.example, so no copied .env.local turns it on", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(example).not.toMatch(new RegExp(`^\\s*${FLAG}\\s*=`, "m"));
  });

  it("listens on this computer only", () => {
    expect(planDevArgs([]).slice(0, 3)).toEqual(["dev", "-H", "127.0.0.1"]);
  });
});
