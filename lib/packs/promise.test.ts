import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Learn teaches only from its catalog (narrow Learn, phase 2), so the app must
// stop promising open topics (PRD-narrow-learn.md, row 9). These are the
// promises it used to make, matched as whole phrases so an unrelated comment
// can't trip the guard.
const RETIRED_PROMISES: readonly RegExp[] = [
  /you can learn anything/i,
  /any data or analytics topic of your own/i,
  /paste a job description/i,
];

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the app no longer promises open topics", () => {
  it("leaves no retired promise anywhere a learner could read it", () => {
    const hits = ["app", "components"].flatMap(dir => sourceFiles(join(ROOT, dir)))
      .flatMap(file => {
        const text = readFileSync(file, "utf8");
        return RETIRED_PROMISES.filter(p => p.test(text)).map(p => `${relative(ROOT, file)}: ${p.source}`);
      });
    expect(hits).toEqual([]);
  });

  it("names the page by what Hugh now does", () => {
    const layout = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
    expect(layout).toContain('title: "Hugh: learn data and analytics by conversation"');
  });
});
