// ── Course groups ───────────────────────────────────────────────────────────
// How the course picker organises the catalog: one group per view, instead of
// every course on one screen (PRD-narrow-learn.md, phase 2, decision 5). Each
// group is filed under one learner-map region, and a course takes its region
// from its group, so the picker and the map can't disagree.
//
// The order here is the order the picker shows. Within a group, courses keep
// catalog order, which for a path is its teaching order.
//
// Pure: no I/O, no `server-only`.

interface CourseGroupShape {
  id:     string;
  label:  string;
  /** One line on what the group covers, shown under its name. */
  blurb:  string;
  /** A path is meant to be taken in order, so the picker numbers its courses. */
  path:   boolean;
  /** The learner-map region every course in the group is filed under (lib/learn/regions.ts). */
  region: string;
}

const GROUPS = [
  {
    id:     "stats-foundations",
    label:  "Statistics foundations",
    blurb:  "Seven courses in order, from describing data to testing what it shows.",
    path:   true,
    region: "stats",
  },
  {
    id:     "stats-modelling",
    label:  "Statistical modelling",
    blurb:  "Model a response, update a belief, and forecast a series.",
    path:   false,
    region: "stats",
  },
  {
    id:     "stats-in-practice",
    label:  "Statistics in practice",
    blurb:  "Run a fair experiment, and find the observations that don't fit.",
    path:   false,
    region: "stats",
  },
  {
    id:     "machine-learning",
    label:  "Machine learning",
    blurb:  "Predict, judge and group with models.",
    path:   false,
    region: "ml",
  },
] as const satisfies readonly CourseGroupShape[];

export type CourseGroupId = (typeof GROUPS)[number]["id"];

export interface CourseGroup extends CourseGroupShape {
  id: CourseGroupId;
}

export const COURSE_GROUPS: readonly CourseGroup[] = GROUPS;

export function courseGroup(id: CourseGroupId): CourseGroup {
  const group = COURSE_GROUPS.find(g => g.id === id);
  // Unreachable: CourseGroupId is drawn from COURSE_GROUPS itself.
  if (!group) throw new Error(`Unknown course group: ${id}`);
  return group;
}

export function isCourseGroupId(value: unknown): value is CourseGroupId {
  return typeof value === "string" && COURSE_GROUPS.some(g => g.id === value);
}
