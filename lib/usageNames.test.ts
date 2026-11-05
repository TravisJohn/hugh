// A logged call gives back its reservation by feature name (migration 062), so
// a gate and its log must use one name. Nothing fails at runtime when they
// don't: the claim just stays held for its full TTL, and that route's learners
// go back to being told "monthly limit reached" long before they are. This
// fails the build instead, read from disk like the other route guards.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** These two pass a caller's name along; they are not call sites of their own. */
const PASS_THROUGH = new Set(["lib/usage.ts", "lib/claude/textBudget.ts"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const sources = [...sourceFiles("app/api"), ...sourceFiles("lib")]
  .filter(file => !PASS_THROUGH.has(file))
  .map(file => ({ file, src: readFileSync(join(ROOT, file), "utf8") }));

/** Every name a call site hands to the gate, literal or not, with where it is. */
const GATE_CALLS = [
  /\b(?:enforceUsageGate|checkUsageAllowed|textBudgetGuard)\(\s*[\w.]+\s*,\s*([^,)]+)/g,
  /\bcreate(?:Text|Image)Message\(\s*[\w.]+\s*,\s*[\w.]+\s*,\s*([^,)]+)/g,
];
const LOG_CALL = /\blogUsage\(\{([^}]*)\}/g;

function collect(patterns: RegExp[], pick: (match: RegExpMatchArray) => string | undefined) {
  return sources.flatMap(({ file, src }) =>
    patterns.flatMap(pattern => [...src.matchAll(pattern)].map(match => ({ file, name: pick(match) }))),
  );
}

const gates = collect(GATE_CALLS, match => match[1].trim());
const logs = collect([LOG_CALL], match => match[1].match(/\bfeature:\s*("[^"]*"|[^,\s]+)/)?.[1]);

const literal = (name: string | undefined) => /^"[^"]+"$/.test(name ?? "");
const names = (calls: typeof gates) => new Set(calls.map(call => call.name));

describe("a route gates and logs under one name", () => {
  it("still sees the call sites, so a rename can't silently empty this guard", () => {
    expect(gates.length).toBeGreaterThan(15);
    expect(logs.length).toBeGreaterThan(15);
    expect(names(gates)).toContain('"learn/chat"');
    expect(names(logs)).toContain('"learn/chat"');
  });

  it("spells every gate's name out, so this guard can read it", () => {
    expect(gates.filter(call => !literal(call.name))).toEqual([]);
  });

  it("spells every log's name out, so this guard can read it", () => {
    expect(logs.filter(call => !literal(call.name))).toEqual([]);
  });

  it("gates every name it logs, or that spend has no claim to give back", () => {
    const gated = names(gates);
    expect(logs.filter(call => !gated.has(call.name))).toEqual([]);
  });

  it("logs every name it gates, or that claim is held for its whole TTL every time", () => {
    const logged = names(logs);
    expect(gates.filter(call => !logged.has(call.name))).toEqual([]);
  });
});
