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

import fs from "fs";
import path from "path";
import { extractText as extractPdfText } from "unpdf";
import { extractHtmlText } from "../lib/documents/extractHtml";
import { findAnchor, textFragmentUrl } from "../lib/packs/anchor";
import {
  anchorTargets, checkPack, learningOrder, parsePack, sampleKeyPoints,
  REVIEW_MIN_SAMPLE, type PackIssue,
} from "../lib/packs/validate";
import type { ReferencePack } from "../types/pack";

const PACK_DIR = path.join(process.cwd(), "content", "packs");
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline   = args.includes("--offline");
  const showLinks = args.includes("--links");
  const dump      = args.includes("--dump");
  const ids = args.filter(a => !a.startsWith("--"));

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
