// ── Reference packs: anchors ────────────────────────────────────────────────
// An anchor is a few words at each end of a source passage. Finding one proves
// the source has that passage without the pack ever storing it. Pure: the
// script that fetches pages lives in scripts/validate-pack.ts.

import type { PackAnchor } from "@/types/pack";

/** How far past the start words the end words may sit, in normalised chars. */
export const ANCHOR_MAX_GAP = 600;

export type AnchorResult =
  | { status: "found" }
  | { status: "start-missing" }
  | { status: "start-ambiguous"; occurrences: number }
  | { status: "end-missing" };

/**
 * Fold away the differences a page and a hand-typed anchor disagree on but a
 * reader would not: runs of whitespace, curly versus straight quotes, the many
 * dashes, soft hyphens and compatibility forms such as ligatures. Case is kept,
 * so a passage shown to the judge reads as written.
 */
function foldForDisplay(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, "\"")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** `foldForDisplay`, then case too: the form anchors are matched in. */
export function normalizeText(s: string): string {
  return foldForDisplay(s).toLowerCase();
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Every index where `needle` occurs as whole words. "the model" must not
 * match inside "breathe models", because browsers' text fragments do not
 * either, and a reviewer's link would land somewhere else.
 */
function wholeWordOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    const before = at === 0 ? "" : haystack[at - 1];
    const after  = haystack[at + needle.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) found.push(at);
    from = at + 1;
  }
}

type Located =
  | { status: "found"; from: number; to: number }
  | Exclude<AnchorResult, { status: "found" }>;

/**
 * Where the anchored passage sits in already-normalised page text. The start
 * words must occur exactly once — an ambiguous start cannot say which passage
 * is meant — and the end words must follow within `maxGap` characters.
 * `findAnchor` and `extractPassage` share this, so the validator and the judge
 * always see the same passage.
 */
function locate(page: string, anchor: PackAnchor, maxGap: number): Located {
  const start = normalizeText(anchor.start);
  const end   = normalizeText(anchor.end);

  const starts = wholeWordOccurrences(page, start);
  if (starts.length === 0) return { status: "start-missing" };
  if (starts.length > 1)   return { status: "start-ambiguous", occurrences: starts.length };

  const afterStart = starts[0] + start.length;
  const ends = wholeWordOccurrences(page.slice(afterStart, afterStart + maxGap + end.length), end);
  return ends.length > 0
    ? { status: "found", from: starts[0], to: afterStart + ends[0] + end.length }
    : { status: "end-missing" };
}

/** Check that a passage bounded by the anchor exists on the page. */
export function findAnchor(pageText: string, anchor: PackAnchor, maxGap = ANCHOR_MAX_GAP): AnchorResult {
  const located = locate(normalizeText(pageText), anchor, maxGap);
  return located.status === "found" ? { status: "found" } : located;
}

/**
 * The passage itself, from its start words through its end words, with
 * whitespace and typography folded but case kept, so the judge reads it as
 * written. Null when the anchor does not resolve. The passage is for the judge
 * and the reviewer only; it is never stored in a pack.
 */
export function extractPassage(pageText: string, anchor: PackAnchor, maxGap = ANCHOR_MAX_GAP): string | null {
  const display = foldForDisplay(pageText);
  const lower   = display.toLowerCase();
  const located = locate(lower, anchor, maxGap);
  if (located.status !== "found") return null;
  // Lower-casing keeps the length of virtually all text, so the positions line
  // up. If it ever does not, the lower-cased slice is still the right passage.
  return (lower.length === display.length ? display : lower).slice(located.from, located.to);
}

/** Text-fragment syntax reserves `-`, `,` and `&`; encodeURIComponent misses `-`. */
function encodeFragmentPart(s: string): string {
  return encodeURIComponent(s.trim().replace(/\s+/g, " ")).replace(/-/g, "%2D");
}

/**
 * A link that opens the source scrolled to the passage and highlighted, so a
 * reviewer's spot-check is one click. Any existing fragment is replaced.
 */
export function textFragmentUrl(url: string, anchor: PackAnchor): string {
  const base = url.split("#")[0];
  return `${base}#:~:text=${encodeFragmentPart(anchor.start)},${encodeFragmentPart(anchor.end)}`;
}
