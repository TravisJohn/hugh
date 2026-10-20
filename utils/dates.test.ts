import { describe, it, expect } from "vitest";
import { addDays } from "./dates";

describe("addDays", () => {
  it("returns a YYYY-MM-DD date, the shape the goals route accepts", () => {
    expect(addDays(30, new Date("2026-10-20T12:00:00Z"))).toBe("2026-11-19");
  });

  it("crosses a month end and a year end", () => {
    expect(addDays(14, new Date("2026-12-25T12:00:00Z"))).toBe("2027-01-08");
  });

  it("does not change the date it was given", () => {
    const from = new Date("2026-10-20T12:00:00Z");
    addDays(90, from);
    expect(from.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });
});
