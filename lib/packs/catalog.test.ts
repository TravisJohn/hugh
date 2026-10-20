import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  catalogIds, catalogListing, courseSummary, loadEntry, loadPack,
  PACK_REFUSAL_MESSAGE, refusalStatus,
} from "./catalog";
import { packTrack } from "./track";
import linearRegression from "@/content/packs/linear-regression.json";
import type { ReferencePack } from "@/types/pack";

// A fresh, mutable copy of a real catalog pack, for breaking one thing at a time.
const lr = (): ReferencePack => JSON.parse(JSON.stringify(linearRegression)) as ReferencePack;

describe("the catalog CI guard (PRD row 11)", () => {
  it("lists at least one course, so an emptied catalog cannot pass silently", () => {
    expect(catalogIds().length).toBeGreaterThan(0);
  });

  it.each(catalogIds())("%s loads: machine-checked or better, with cards, and passes every offline rule", id => {
    const result = loadPack(id);
    expect(result.ok ? "ok" : result.reason).toBe("ok");
  });

  it.each(catalogIds())("%s builds a board that teaches every live concept exactly once", id => {
    const result = loadPack(id);
    if (!result.ok) throw new Error(`${id} did not load`);
    const taught = packTrack(result.pack).rows.flatMap(r => r.concept_ids);
    const live   = result.pack.concepts.filter(c => !c.retired).map(c => `${id}:${c.id}`);
    expect(new Set(taught).size).toBe(taught.length);
    expect([...taught].sort()).toEqual([...live].sort());
  });

  it.each(catalogIds())("%s never drops a concept or card id a learner's board may hold", id => {
    const lockPath = join(process.cwd(), "content", "packs", "ids", `${id}.json`);
    expect(existsSync(lockPath), `missing content/packs/ids/${id}.json`).toBe(true);
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { concepts: string[]; cards: string[] };
    const result = loadPack(id);
    if (!result.ok) throw new Error(`${id} did not load`);
    const concepts = result.pack.concepts.map(c => c.id);
    const cards    = (result.pack.cards ?? []).map(c => c.id);
    // Everything ever published is still there (a retired concept still counts)...
    expect(lock.concepts.filter(c => !concepts.includes(c))).toEqual([]);
    expect(lock.cards.filter(c => !cards.includes(c))).toEqual([]);
    // ...and every id now published is recorded, so the next edit is held to it.
    expect(concepts.filter(c => !lock.concepts.includes(c))).toEqual([]);
    expect(cards.filter(c => !lock.cards.includes(c))).toEqual([]);
  });
});

describe("loadEntry: a pack below the bar is refused, with a reason", () => {
  it("refuses a pack that is only provisional, because Hugh teaches from machine-checked up", () => {
    const p = { ...lr(), status: "provisional" as const };
    delete p.machineCheck;
    expect(loadEntry({ id: p.id, region: "stats", raw: p })).toEqual({ ok: false, reason: "below-status" });
  });

  it("refuses a pack with no cards, because there would be no track to build", () => {
    const p = lr();
    delete p.cards;
    expect(loadEntry({ id: p.id, region: "stats", raw: p })).toEqual({ ok: false, reason: "no-cards" });
  });

  it("refuses a pack edited after its machine check, so an unjudged sentence is never taught", () => {
    const p = lr();
    p.concepts[0]!.keyPoints[0]!.text = "A sentence nobody judged.";
    expect(loadEntry({ id: p.id, region: "stats", raw: p })).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses something that is not a pack at all", () => {
    expect(loadEntry({ id: "x", region: "stats", raw: { nope: true } })).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns the pack and its map region when everything holds", () => {
    const result = loadEntry({ id: "linear-regression", region: "stats", raw: lr() });
    expect(result.ok && result.region).toBe("stats");
  });
});

describe("loadPack", () => {
  it("refuses an id that is not in the catalog, without guessing", () => {
    expect(loadPack("not-a-course")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("refusals read differently from each other (Rule 5)", () => {
  it("gives every refusal its own message", () => {
    const messages = Object.values(PACK_REFUSAL_MESSAGE);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("treats an unknown course as the caller's mistake and a broken pack as Hugh's", () => {
    expect(refusalStatus("unknown")).toBe(404);
    expect(refusalStatus("below-status")).toBe(503);
    expect(refusalStatus("invalid")).toBe(503);
    expect(refusalStatus("no-cards")).toBe(503);
  });
});

describe("catalogListing", () => {
  it("lists a broken pack as broken, never drops it, so an empty picker means an empty catalog", () => {
    const broken = lr();
    delete broken.cards;
    const listing = catalogListing([
      { id: "linear-regression", region: "stats", raw: lr() },
      { id: "broken", region: "stats", raw: broken },
    ]);
    expect(listing.map(l => l.packId)).toEqual(["linear-regression", "broken"]);
    expect(listing[0]!.course?.cardCount).toBe(12);
    expect(listing[1]).toEqual({ packId: "broken", course: null, problem: PACK_REFUSAL_MESSAGE["no-cards"] });
  });
});

describe("courseSummary", () => {
  it("names each publisher once, in the pack's own order", () => {
    const p = lr();
    const summary = courseSummary(p);
    expect(summary.publishers.length).toBe(new Set(p.sources.map(s => s.publisher)).size);
    expect(summary.publishers[0]).toBe(p.sources[0]!.publisher);
    expect(summary).toMatchObject({ packId: p.id, version: p.version, subject: p.subject, cardCount: 12 });
  });
});
