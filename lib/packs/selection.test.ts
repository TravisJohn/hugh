import { describe, it, expect } from "vitest";
import { catalogIds, catalogListing, groupedCatalog, PACK_REFUSAL_MESSAGE } from "./catalog";
import { NO_SELECTION, resolveSelection, selectionQuery, startableCourseIds } from "./selection";
import linearRegression from "@/content/packs/linear-regression.json";
import type { ReferencePack } from "@/types/pack";

const groups = groupedCatalog();

describe("resolveSelection: the URL and the carousel are untrusted", () => {
  it("opens a course in its own group from the course alone, so a carousel slide needs only its course", () => {
    expect(resolveSelection(groups, undefined, "neural-networks"))
      .toEqual({ groupId: "machine-learning", packId: "neural-networks" });
  });

  it("trusts the course over a group that disagrees with it", () => {
    expect(resolveSelection(groups, "stats-foundations", "neural-networks"))
      .toEqual({ groupId: "machine-learning", packId: "neural-networks" });
  });

  it("opens a group with no course chosen yet", () => {
    expect(resolveSelection(groups, "stats-modelling", undefined))
      .toEqual({ groupId: "stats-modelling", packId: null });
  });

  it("falls back to the group when the course is made up", () => {
    expect(resolveSelection(groups, "stats-modelling", "not-a-course"))
      .toEqual({ groupId: "stats-modelling", packId: null });
  });

  it("shows the list of groups for anything it can't place", () => {
    expect(resolveSelection(groups, "analytics", undefined)).toEqual(NO_SELECTION);
    expect(resolveSelection(groups, ["stats-modelling"], ["neural-networks"])).toEqual(NO_SELECTION);
    expect(resolveSelection([], "stats-modelling", "neural-networks")).toEqual(NO_SELECTION);
  });

  it("won't open a broken course, because there would be nothing to start", () => {
    const broken = JSON.parse(JSON.stringify(linearRegression)) as ReferencePack;
    delete broken.cards;
    const withBroken = groupedCatalog(catalogListing([{ id: "broken", group: "stats-modelling", raw: broken }]));
    expect(withBroken[0]!.listings[0]!.problem).toBe(PACK_REFUSAL_MESSAGE["no-cards"]);
    expect(resolveSelection(withBroken, undefined, "broken")).toEqual(NO_SELECTION);
  });
});

describe("selectionQuery", () => {
  it("writes a selection back as the query that reopens it", () => {
    const selection = resolveSelection(groups, undefined, "ab-testing");
    expect(selectionQuery(selection)).toBe("?group=stats-in-practice&course=ab-testing");
    const reopened = new URLSearchParams(selectionQuery(selection));
    expect(resolveSelection(groups, reopened.get("group"), reopened.get("course"))).toEqual(selection);
  });

  it("leaves the URL bare for the list of groups", () => {
    expect(selectionQuery(NO_SELECTION)).toBe("");
  });
});

describe("startableCourseIds", () => {
  it("lists every course in the catalog that can be started", () => {
    expect([...startableCourseIds(groups)].sort()).toEqual(catalogIds().sort());
  });
});
