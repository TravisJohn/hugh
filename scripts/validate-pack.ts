// ── Reference pack validator ────────────────────────────────────────────────
// Checks a pack against PRD-reference-packs.md: the offline rules in
// lib/packs/validate.ts, then every anchor against its fetched source page.
//
//   npm run packs:check                       every pack in content/packs/
//   npm run packs:check -- linear-regression  one pack
//   npm run packs:check -- --offline          skip fetching (what CI runs)
//   npm run packs:check -- --links            print a highlight link per anchor
//   npm run packs:check -- <id> --dump        write each source's extracted text
//                                             to .pack-cache/<id>/ for authoring
//
// Exits 1 when any pack has an error. A pack may leave `draft` only when this
// passes with the network on.
//
// --dump exists so an author writes anchors against exactly the text this
// validator will later search, not a browser's rendering of the page. The
// cache is git-ignored: it holds other publishers' text, which a pack never
// stores.
//
// The machine check (spec v1.1):
//   npm run packs:check -- <id> --judge-packet
//       Extracts every anchored passage, mixes in the planted errors from
//       content/packs/plants/<id>.json, and writes the judge's packet and a
//       separate answer key to .pack-cache/<id>/. The judge reads only the
//       packet, in a fresh context.
//   npm run packs:check -- <id> --record-judgement <verdicts.json>
//       Scores the verdicts against the key. Only a full pass writes the
//       machineCheck record and raises the status.

import fs from "fs";
import path from "path";
import { extractText as extractPdfText } from "unpdf";
import { extractHtmlText } from "../lib/documents/extractHtml";
import { extractPassage, findAnchor, textFragmentUrl } from "../lib/packs/anchor";
import {
  buildJudgePacket, fingerprint, parseJudgement, parsePlants, scoreJudgement, type JudgeKey,
} from "../lib/packs/judge";
import {
  anchorTargets, checkPack, learningOrder, parsePack, sampleKeyPoints,
  REVIEW_MIN_SAMPLE, type PackIssue,
} from "../lib/packs/validate";
import type { ReferencePack } from "../types/pack";

const PACK_DIR = path.join(process.cwd(), "content", "packs");
const PLANTS_DIR = path.join(PACK_DIR, "plants");
const cacheDir = (id: string) => path.join(process.cwd(), ".pack-cache", id);
const USER_AGENT = "HughPackValidator/1.0 (+https://heyhugh.vercel.app)";

type Page =
  | { kind: "html" | "pdf"; text: string }
  | { kind: "unreadable"; reason: string };

// Many pages put block elements back to back with no whitespace between them.
// A line break after each keeps the words at those seams from running
// together, which would make an anchor spanning them impossible to find.
function separateBlocks(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|article|blockquote|pre|dd|dt|figcaption|caption)>/gi, "$&\n");
}

async function readPage(url: string): Promise<Page> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { kind: "unreadable", reason: `HTTP ${res.status}` };

    const bytes = new Uint8Array(await res.arrayBuffer());
    const isPdf = (res.headers.get("content-type") ?? "").includes("pdf") || /\.pdf($|\?)/i.test(url);
    if (isPdf) {
      const { text } = await extractPdfText(bytes, { mergePages: true });
      return text.trim() ? { kind: "pdf", text } : { kind: "unreadable", reason: "the PDF has no extractable text" };
    }
    const text = extractHtmlText(separateBlocks(new TextDecoder().decode(bytes)));
    return text.trim() ? { kind: "html", text } : { kind: "unreadable", reason: "the page has no text (built by JavaScript?)" };
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Anchor results. Unreadable pages and PDFs become manual checks, never passes. */
async function checkAnchors(pack: ReferencePack): Promise<PackIssue[]> {
  const issues: PackIssue[] = [];
  const urlOf = new Map(pack.sources.map(s => [s.id, s.url]));
  const pages = new Map<string, Page>();

  // One fetch per page, in sequence: these are other people's servers.
  for (const url of new Set(anchorTargets(pack).map(t => urlOf.get(t.sourceId)).filter((u): u is string => !!u))) {
    pages.set(url, await readPage(url));
  }

  for (const t of anchorTargets(pack)) {
    const url = urlOf.get(t.sourceId);
    if (!url) continue; // an unknown source id is already an error from checkPack
    const page = pages.get(url)!;
    if (page.kind === "unreadable") {
      issues.push({ level: "warning", path: t.path, message: `manual check (${t.ref}): ${page.reason} — ${url} at ${t.locator}` });
      continue;
    }
    const result = findAnchor(page.text, t.anchor);
    if (result.status === "start-missing") {
      issues.push({ level: "error", path: `${t.path}.anchor.start`, message: `(${t.ref}) "${t.anchor.start}" is not on the page` });
    } else if (result.status === "start-ambiguous") {
      issues.push({ level: "error", path: `${t.path}.anchor.start`, message: `(${t.ref}) "${t.anchor.start}" appears ${result.occurrences} times; lengthen it` });
    } else if (result.status === "end-missing") {
      issues.push({ level: "error", path: `${t.path}.anchor.end`, message: `(${t.ref}) "${t.anchor.end}" does not follow the start` });
    } else if (page.kind === "pdf") {
      issues.push({ level: "warning", path: t.path, message: `manual check (${t.ref}): found in the PDF's text, but browsers cannot highlight inside a PDF — ${url} at ${t.locator}` });
    }
  }
  return issues;
}

function linkFor(pack: ReferencePack, ref: string): string {
  const t = anchorTargets(pack).find(x => x.ref === ref);
  const source = t && pack.sources.find(s => s.id === t.sourceId);
  if (!t || !source) return ref;
  return /\.pdf($|\?)/i.test(source.url)
    ? `${source.url}  (PDF: ${t.locator}; start "${t.anchor.start}")`
    : textFragmentUrl(source.url, t.anchor);
}

async function dumpSources(pack: ReferencePack): Promise<boolean> {
  const dir = path.join(process.cwd(), ".pack-cache", pack.id);
  fs.mkdirSync(dir, { recursive: true });
  let unreadable = false;
  for (const s of pack.sources) {
    const page = await readPage(s.url);
    if (page.kind === "unreadable") {
      unreadable = true;
      console.log(`  ✗ ${s.id}: ${page.reason}`);
      continue;
    }
    fs.writeFileSync(path.join(dir, `${s.id}.txt`), page.text, "utf8");
    console.log(`  ✓ ${s.id} (${page.kind}, ${page.text.length} chars)`);
  }
  console.log(`  → ${dir}`);
  return unreadable;
}

async function checkFile(file: string, offline: boolean, showLinks: boolean, dump: boolean): Promise<boolean> {
  const label = path.basename(file, ".json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(PACK_DIR, file), "utf8"));
  } catch (err) {
    console.log(`\n✗ ${label}: cannot read — ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }

  const parsed = parsePack(raw);
  const pack = parsed.pack;
  if (dump) {
    console.log(`\n${label}: dumping source text`);
    if (!pack) {
      for (const i of parsed.issues) console.log(`  ERROR    ${i.path}: ${i.message}`);
      return true;
    }
    return dumpSources(pack);
  }
  const issues = [...parsed.issues];
  if (pack) {
    issues.push(...checkPack(pack));
    if (!offline) issues.push(...(await checkAnchors(pack)));
  }
  const errors   = issues.filter(i => i.level === "error");
  const warnings = issues.filter(i => i.level === "warning");

  if (pack && errors.length > 0 && pack.status !== "draft" && !offline) {
    errors.push({ level: "error", path: "$.status", message: `says "${pack.status}" but the validator fails; set it back to draft` });
  }

  console.log(`\n${errors.length ? "✗" : "✓"} ${label}${pack ? ` ${pack.version} (${pack.status})` : ""}`);
  if (pack) {
    const kp = pack.concepts.reduce((n, c) => n + c.keyPoints.length, 0);
    const mc = pack.concepts.reduce((n, c) => n + (c.misconceptions?.length ?? 0), 0);
    console.log(`  ${pack.concepts.length} concepts · ${kp} key points · ${mc} misconceptions · ${pack.sources.length} sources`);
    const order = learningOrder(pack.concepts.map(c => c.id), pack.prerequisites);
    if (order.ok) console.log(`  order: ${order.order.join(" → ")}`);
  }
  if (offline) console.log("  (offline: anchors not checked against their pages)");
  for (const e of errors)   console.log(`  ERROR    ${e.path}: ${e.message}`);
  for (const w of warnings) console.log(`  warning  ${w.path}: ${w.message}`);

  if (pack && errors.length === 0 && !offline) {
    console.log(`\n  Spot-check sample (${REVIEW_MIN_SAMPLE} random key points):`);
    for (const ref of sampleKeyPoints(pack, REVIEW_MIN_SAMPLE, Math.random)) {
      console.log(`    ${ref}  ${linkFor(pack, ref)}`);
    }
  }
  if (pack && showLinks) {
    console.log("\n  Every anchor:");
    for (const t of anchorTargets(pack)) console.log(`    ${t.ref}  ${linkFor(pack, t.ref)}`);
  }
  return errors.length > 0;
}

// ── The machine check ───────────────────────────────────────────────────────

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Load a pack that must parse and pass the offline rules before it can be judged. */
function loadPackOrExplain(id: string): { raw: Record<string, unknown>; pack: ReferencePack } | null {
  const raw = readJson(path.join(PACK_DIR, `${id}.json`)) as Record<string, unknown>;
  const { pack, issues } = parsePack(raw);
  const errors = [...issues, ...(pack ? checkPack({ ...pack, status: "provisional" }) : [])].filter(i => i.level === "error");
  if (!pack || errors.length > 0) {
    console.log(`✗ ${id}: fix these before judging:`);
    for (const e of errors) console.log(`  ERROR    ${e.path}: ${e.message}`);
    return null;
  }
  return { raw, pack };
}

async function writeJudgePacket(id: string): Promise<boolean> {
  const loaded = loadPackOrExplain(id);
  if (!loaded) return true;
  const { pack } = loaded;

  const plantsFile = path.join(PLANTS_DIR, `${id}.json`);
  if (!fs.existsSync(plantsFile)) {
    console.log(`✗ ${id}: no planted errors at ${path.relative(process.cwd(), plantsFile)}`);
    return true;
  }
  const { plants, problems } = parsePlants(pack, readJson(plantsFile));
  if (!plants) {
    for (const p of problems) console.log(`  ERROR    plants: ${p}`);
    return true;
  }

  // Every passage is needed: a run with a missing passage judges nothing.
  const urlOf = new Map(pack.sources.map(s => [s.id, s.url]));
  const pages = new Map<string, Awaited<ReturnType<typeof readPage>>>();
  const passages = new Map<string, string>();
  const missing: string[] = [];
  for (const t of anchorTargets(pack)) {
    const url = urlOf.get(t.sourceId)!;
    if (!pages.has(url)) pages.set(url, await readPage(url));
    const page = pages.get(url)!;
    const passage = page.kind === "unreadable" ? null : extractPassage(page.text, t.anchor);
    if (passage === null) missing.push(`${t.ref} (${page.kind === "unreadable" ? page.reason : "anchor did not resolve"})`);
    else passages.set(t.ref, passage);
  }
  if (missing.length > 0) {
    console.log(`✗ ${id}: cannot extract every passage:`);
    for (const m of missing) console.log(`  ERROR    ${m}`);
    return true;
  }

  const built = buildJudgePacket(pack, passages, plants, Math.random);
  if (!built.ok) {
    for (const p of built.problems) console.log(`  ERROR    ${p}`);
    return true;
  }
  const dir = cacheDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "judge-packet.json"), JSON.stringify(built.packet, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "judge-key.json"), JSON.stringify(built.key, null, 2) + "\n");
  const planted = built.key.entries.filter(e => e.planted).length;
  console.log(`✓ ${id}: ${built.packet.items.length} items (${built.packet.items.length - planted} real, ${planted} planted)`);
  console.log(`  packet (give the judge only this): ${path.join(dir, "judge-packet.json")}`);
  console.log(`  answer key (never show the judge): ${path.join(dir, "judge-key.json")}`);
  return false;
}

function recordJudgement(id: string, verdictsFile: string): boolean {
  const loaded = loadPackOrExplain(id);
  if (!loaded) return true;
  const { raw, pack } = loaded;
  const key = readJson(path.join(cacheDir(id), "judge-key.json")) as JudgeKey;

  if (key.fingerprint !== fingerprint(pack)) {
    console.log(`✗ ${id}: the pack changed after its judge packet was built; build a new packet and judge again`);
    return true;
  }
  const { judgement, problems } = parseJudgement(readJson(verdictsFile));
  if (!judgement) {
    for (const p of problems) console.log(`  ERROR    judgement: ${p}`);
    return true;
  }

  const result = scoreJudgement(key, judgement);
  console.log(`${result.passed ? "✓" : "✗"} ${id}: judged by ${judgement.judgeModel} (instructions v${judgement.instructionsVersion})`);
  console.log(`  real items: ${result.itemsSupported}/${result.itemsJudged} supported · planted errors: ${result.errorsCaught}/${result.errorsPlanted} caught`);
  for (const p of result.problems) console.log(`  INVALID  ${p}`);
  for (const u of result.unsupported) console.log(`  REWRITE  ${u.ref} [${u.verdict}] ${u.reason}`);
  for (const m of result.missedErrors) console.log(`  MISSED   ${m.ref} (${m.kind}) judged supported: ${m.reason}`);
  if (!result.passed) {
    if (result.missedErrors.length > 0) {
      console.log("  The run fails: a planted error got through. Change the judge's instructions (and their version) before re-running.");
    }
    return true;
  }

  // Write into the file's own object so its key order and layout survive.
  // The date is the author's local day: toISOString() is UTC, which in
  // Sydney's morning is still yesterday.
  const now = new Date();
  const localDay = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-");
  raw.machineCheck = {
    judgeModel: judgement.judgeModel,
    instructionsVersion: judgement.instructionsVersion,
    checkedAt: localDay,
    itemsJudged: result.itemsJudged,
    itemsSupported: result.itemsSupported,
    errorsPlanted: result.errorsPlanted,
    errorsCaught: result.errorsCaught,
    fingerprint: key.fingerprint,
  };
  // An approved pack stays approved: its audit still stands, and the record
  // now satisfies the v1.1 rule that approval sits on a machine check.
  if (raw.status !== "approved") raw.status = "machine-checked";
  fs.writeFileSync(path.join(PACK_DIR, `${id}.json`), JSON.stringify(raw, null, 2) + "\n");

  const recheck = parsePack(raw);
  const errors = recheck.pack ? checkPack(recheck.pack).filter(i => i.level === "error") : recheck.issues;
  if (errors.length > 0) {
    for (const e of errors) console.log(`  ERROR    ${e.path}: ${e.message}`);
    return true;
  }
  console.log(`  recorded: status is now ${String(raw.status)}`);
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline   = args.includes("--offline");
  const showLinks = args.includes("--links");
  const dump      = args.includes("--dump");
  const recordAt  = args.indexOf("--record-judgement");
  const verdicts  = recordAt >= 0 ? args[recordAt + 1] : undefined;
  const ids = args.filter((a, i) => !a.startsWith("--") && !(recordAt >= 0 && i === recordAt + 1));

  if (args.includes("--judge-packet") || recordAt >= 0) {
    if (ids.length !== 1) {
      console.log("The machine check runs on one pack at a time: npm run packs:check -- <id> --judge-packet");
      process.exit(1);
    }
    if (recordAt >= 0 && !verdicts) {
      console.log("Name the verdicts file: npm run packs:check -- <id> --record-judgement <verdicts.json>");
      process.exit(1);
    }
    const failed = recordAt >= 0 ? recordJudgement(ids[0], verdicts!) : await writeJudgePacket(ids[0]);
    process.exit(failed ? 1 : 0);
  }

  const files = ids.length > 0
    ? ids.map(id => `${id}.json`)
    : fs.readdirSync(PACK_DIR).filter(f => f.endsWith(".json")).sort();
  if (files.length === 0) {
    console.log(`No packs in ${PACK_DIR}.`);
    process.exit(1);
  }

  let failed = false;
  for (const file of files) failed = (await checkFile(file, offline, showLinks, dump)) || failed;
  process.exit(failed ? 1 : 0);
}

void main();
