import { describe, expect, it } from "vitest";
import { assertOwnedStoragePaths, isOwnedStoragePath } from "./ownership";

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";

describe("privileged Storage ownership", () => {
  it("allows canonical files in the caller's folder", () => {
    expect(isOwnedStoragePath(alice, `${alice}/note/file.png`)).toBe(true);
    expect(isOwnedStoragePath(alice, `${alice}/doc/cv.v2.pdf`)).toBe(true);
  });

  it.each([
    `${bob}/note/file.png`, `${alice}extra/note/file.png`,
    `${alice}/../${bob}/file.png`, `${alice}/./file.png`,
    `${alice}/%2e%2e/${bob}/file.png`, `${alice}/%252e%252e/file.png`,
    `${alice}/note%2ffile.png`, `${alice}/note\\file.png`,
    `${alice}//file.png`, `${alice}/`, alice, `/${alice}/file.png`,
    `https://storage.example/${alice}/file.png`, `${alice}/file.png?x=1`,
    `${alice}/file.png#fragment`, `${alice}/file.png\n`, `${alice}/file\0.png`,
    "", null, undefined, 12,
  ])("rejects foreign or ambiguous reference %j", (path) => {
    expect(isOwnedStoragePath(alice, path)).toBe(false);
  });

  it("refuses a whole mixed-owner batch without disclosing the path", () => {
    expect(() => assertOwnedStoragePaths(alice, [`${alice}/ok.png`, `${bob}/private.png`]))
      .toThrow("Stored file reference does not belong to this account.");
  });
});
