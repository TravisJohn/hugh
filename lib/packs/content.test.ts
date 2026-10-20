// Every pack on disk must pass the offline rules. This is what CI runs: it has
// no network, so anchors are checked against their pages by
// `npm run packs:check` when a pack is written, not here.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPack, parsePack } from "./validate";
import { parsePlants } from "./judge";

const PACK_DIR = join(process.cwd(), "content", "packs");
const PLANTS_DIR = join(PACK_DIR, "plants");
const files = readdirSync(PACK_DIR).filter(f => f.endsWith(".json")).sort();
const plantFiles = existsSync(PLANTS_DIR) ? readdirSync(PLANTS_DIR).filter(f => f.endsWith(".json")).sort() : [];

describe("reference packs on disk", () => {
  it("has at least one pack, so an emptied folder cannot pass silently", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s passes every offline rule", file => {
    const { pack, issues } = parsePack(JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")));
    expect(issues).toEqual([]);
    expect(pack).not.toBeNull();
    const errors = checkPack(pack!).filter(i => i.level === "error");
    expect(errors, errors.map(e => `${e.path}: ${e.message}`).join("\n")).toEqual([]);
  });

  it.each(files)("%s is named after its own id, so the validator can find it by id", file => {
    const raw: unknown = JSON.parse(readFileSync(join(PACK_DIR, file), "utf8"));
    const id = typeof raw === "object" && raw !== null && "id" in raw ? raw.id : null;
    expect(`${String(id)}.json`).toBe(file);
  });
});

describe("planted errors on disk (spec v1.1)", () => {
  it.each(plantFiles)("%s belongs to a pack and plants one of every kind of corruption", file => {
    expect(files).toContain(file);
    const { pack } = parsePack(JSON.parse(readFileSync(join(PACK_DIR, file), "utf8")));
    const { problems } = parsePlants(pack!, JSON.parse(readFileSync(join(PLANTS_DIR, file), "utf8")));
    expect(problems).toEqual([]);
  });
});
