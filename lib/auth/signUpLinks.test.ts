// ── Finding sign-up ─────────────────────────────────────────────────────────
//
// A visitor looking for sign-up looks for the words "Sign up". Before this
// guard the way in was called "Create one free" on the login page and "Create
// account" on the landing cards, the landing header offered only "Sign in",
// and the hero's main button went to /login. Someone who wanted an account
// could not find where to make one.
//
// This scans the source rather than rendering pages, so a link that drifts to
// another name fails the build when it is written.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

const SIGN_UP_HREF = 'href="/signup"';

/** Every non-test .tsx file under `rel`, as repo-relative POSIX paths. */
function componentFilesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        walk(full);
      } else if (entry.name.endsWith(".tsx") && !/\.test\.tsx$/.test(entry.name)) {
        out.push(relative(ROOT, full).split(sep).join("/"));
      }
    }
  };
  const start = join(ROOT, rel);
  if (statSync(start, { throwIfNoEntry: false })) walk(start);
  return out;
}

/**
 * The visible label of every link to /signup in `source`. JSX expressions go
 * first, because an `onClick={e => …}` holds a `>` that would otherwise end
 * the opening tag early; then the rest of the opening tag, then any icons.
 */
function signUpLabels(source: string): string[] {
  const labels: string[] = [];
  let from = source.indexOf(SIGN_UP_HREF);
  while (from !== -1) {
    const close = source.slice(from).search(/<\/(?:Link|a)>/);
    const inner = source
      .slice(from, close === -1 ? undefined : from + close)
      .replace(/\{[^{}]*\}/g, "")
      .replace(/^[^>]*>/, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    labels.push(inner);
    from = source.indexOf(SIGN_UP_HREF, from + SIGN_UP_HREF.length);
  }
  return labels;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("sign-up links", () => {
  it("are all called Sign up, so a visitor looking for one word finds it everywhere", () => {
    const misnamed = ["app", "components"]
      .flatMap(componentFilesUnder)
      .flatMap((file) => signUpLabels(read(file)).map((label) => ({ file, label })))
      .filter(({ label }) => !label.startsWith("Sign up"));
    expect(misnamed).toEqual([]);
  });

  it("are offered on the landing page and the login page, where a new visitor looks", () => {
    expect(signUpLabels(read("app/page.tsx")).length).toBeGreaterThan(0);
    expect(signUpLabels(read("app/(auth)/login/page.tsx")).length).toBeGreaterThan(0);
  });

  it("are read past an onClick arrow and an icon to the label itself", () => {
    const withIcon = `<Link
        href="/signup"
        onClick={e => e.stopPropagation()}
        className="flex gap-2"
      >
        <UserPlus size={13} />
        Sign up
      </Link>`;
    expect(signUpLabels(withIcon)).toEqual(["Sign up"]);
    expect(signUpLabels(`<Link href="/signup">Create one free</Link>`)).toEqual(["Create one free"]);
    expect(signUpLabels(`<Link href="/login">Sign in</Link>`)).toEqual([]);
  });
});
