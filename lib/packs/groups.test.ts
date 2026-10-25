import { describe, it, expect } from "vitest";
import { COURSE_GROUPS, courseGroup, isCourseGroupId } from "./groups";
import { isRegionId } from "@/lib/learn/regions";

describe("course groups", () => {
  it("gives every group its own id, so a ?group= link can only mean one group", () => {
    const ids = COURSE_GROUPS.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(COURSE_GROUPS.map(g => [g.id, g.region]))(
    "files %s under a real learner-map region (%s), so its courses appear on the map",
    (_id, region) => {
      expect(isRegionId(region)).toBe(true);
    },
  );

  it("gives every group a name and a blurb, because the picker shows both", () => {
    for (const g of COURSE_GROUPS) {
      expect(g.label.trim()).not.toBe("");
      expect(g.blurb.trim()).not.toBe("");
    }
  });

  it("looks a group up by its id", () => {
    expect(courseGroup("machine-learning").region).toBe("ml");
  });

  it("accepts only known group ids from a URL, so a made-up ?group= can't select anything", () => {
    expect(isCourseGroupId("stats-foundations")).toBe(true);
    expect(isCourseGroupId("analytics")).toBe(false);
    expect(isCourseGroupId("")).toBe(false);
    expect(isCourseGroupId(undefined)).toBe(false);
    expect(isCourseGroupId(["stats-foundations"])).toBe(false);
  });
});
