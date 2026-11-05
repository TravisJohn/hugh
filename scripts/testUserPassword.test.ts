import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MIN_TEST_USER_PASSWORD_LENGTH,
  TEST_USER_PASSWORD_VAR,
  testUserPassword,
} from "./testUserPassword.mjs";

const long = "x".repeat(MIN_TEST_USER_PASSWORD_LENGTH);

describe("reading the test learner's password", () => {
  it("names the variable to set when it is missing, so the fix is obvious", () => {
    expect(() => testUserPassword({})).toThrow(TEST_USER_PASSWORD_VAR);
  });

  it("treats a blank value as missing, since .env.example ships it blank", () => {
    expect(() => testUserPassword({ [TEST_USER_PASSWORD_VAR]: "   " })).toThrow("is not set");
  });

  it("refuses a short password, because the seed script writes it to the real database", () => {
    const short = "x".repeat(MIN_TEST_USER_PASSWORD_LENGTH - 1);
    expect(() => testUserPassword({ [TEST_USER_PASSWORD_VAR]: short })).toThrow("at least");
  });

  it("accepts a password at the floor, without stray whitespace from the file", () => {
    expect(testUserPassword({ [TEST_USER_PASSWORD_VAR]: ` ${long} ` })).toBe(long);
  });

  it("never repeats the value in an error, because script output gets pasted around", () => {
    const short = "shortsecret";
    try {
      testUserPassword({ [TEST_USER_PASSWORD_VAR]: short });
      expect.unreachable("a short password should be refused");
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });
});

describe("the public repo holds no test password", () => {
  const scriptsDir = join(process.cwd(), "scripts");
  const scripts = readdirSync(scriptsDir).filter(
    (name) => /\.(mjs|js|ts)$/.test(name) && !name.endsWith(".test.ts"),
  );

  // Each shape is one a script could use to carry a working login in plain text.
  const hardcoded = [
    /\b[A-Z_]*PASSWORD\s*=\s*["'`]/,
    /\bpassword:\s*["'`]/,
    /flag\(\s*["'`]password["'`]\s*,\s*["'`]/,
  ];

  it("finds the scripts it is meant to guard, so a moved folder cannot pass it silently", () => {
    expect(scripts).toEqual(
      expect.arrayContaining(["seed-test-user.mjs", "verify-049-e2e.mjs", "verify-notebooks.mjs"]),
    );
  });

  it.each(scripts)("%s has no password written into it", (name) => {
    const source = readFileSync(join(scriptsDir, name), "utf8");
    for (const shape of hardcoded) {
      expect(source).not.toMatch(shape);
    }
  });
});
