// ── Which group and course the picker has open ──────────────────────────────
// The picker shows one group at a time (phase 2, decision 5), and the open
// group and course live in the URL (?group=, ?course=) so a link or a carousel
// slide can open a course directly. Both arrive untrusted, so they are kept
// only if the catalog has them.
//
// Pure. The catalog import is type-only and erased, so no pack reaches the
// browser through this module.

import type { CatalogGroup } from "./catalog";
import { isCourseGroupId, type CourseGroupId } from "./groups";

export interface CourseSelection {
  groupId: CourseGroupId | null;
  packId:  string | null;
}

export const NO_SELECTION: CourseSelection = { groupId: null, packId: null };

/**
 * Keep what the catalog has, drop the rest. A course names its own group, so
 * a course alone is enough, and it wins over a group that disagrees with it.
 * A broken course can't be opened, because there is nothing to start.
 */
export function resolveSelection(
  groups:   readonly CatalogGroup[],
  rawGroup: unknown,
  rawPack:  unknown,
): CourseSelection {
  if (typeof rawPack === "string") {
    const home = groups.find(g => g.listings.some(l => l.packId === rawPack && l.course !== null));
    if (home) return { groupId: home.group.id, packId: rawPack };
  }
  if (isCourseGroupId(rawGroup) && groups.some(g => g.group.id === rawGroup)) {
    return { groupId: rawGroup, packId: null };
  }
  return NO_SELECTION;
}

/** The query string that reopens a selection, or "" for the list of groups. */
export function selectionQuery(selection: CourseSelection): string {
  if (!selection.groupId) return "";
  const params = new URLSearchParams({ group: selection.groupId });
  if (selection.packId) params.set("course", selection.packId);
  return `?${params.toString()}`;
}

/** Every course that can be started, for surfaces that point into the catalog. */
export function startableCourseIds(groups: readonly CatalogGroup[]): string[] {
  return groups.flatMap(g => g.listings.filter(l => l.course !== null).map(l => l.packId));
}
