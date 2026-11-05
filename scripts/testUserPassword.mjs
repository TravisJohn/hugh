// The test learner's password lives in .env.local, never in this repo. The repo
// is public and the account signs in on the live site too, so a password written
// here is a working login for anyone who reads it.

export const TEST_USER_PASSWORD_VAR = "HUGH_TEST_USER_PASSWORD";

// seed-test-user.mjs writes this value to the real database. The floor keeps a
// short, guessable password from going back on an account that can reach the
// live site. The password that used to be in this repo is shorter than this.
export const MIN_TEST_USER_PASSWORD_LENGTH = 16;

/** The password from an environment, or an error saying what to fix. */
export function testUserPassword(env) {
  const value = env[TEST_USER_PASSWORD_VAR]?.trim();
  if (!value) {
    throw new Error(
      `${TEST_USER_PASSWORD_VAR} is not set. Add it to .env.local with at least ${MIN_TEST_USER_PASSWORD_LENGTH} characters.`,
    );
  }
  if (value.length < MIN_TEST_USER_PASSWORD_LENGTH) {
    throw new Error(
      `${TEST_USER_PASSWORD_VAR} needs at least ${MIN_TEST_USER_PASSWORD_LENGTH} characters.`,
    );
  }
  return value;
}

/** For the scripts: the same check, ending the run with one sentence on failure. */
export function requireTestUserPassword(env) {
  try {
    return testUserPassword(env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
