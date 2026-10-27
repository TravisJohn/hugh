import { type SourceKind } from "@/types";

// Narrow Learn phase 2, PR D: what Hugh says about a goal that was not built
// from a source-checked course. Those are the "earlier topics": every goal
// started from a typed topic or an uploaded document before the catalog.
// They stay for the learner to read and delete, and nothing more.
//
// The copy lives here once, because the goal library, the track page and
// several routes all say it, and a learner who meets it twice should read the
// same sentence twice. Pure: no React, no Supabase, no `server-only`, so the
// browser components can import it too.

/** Where an earlier topic sends the learner instead: the course catalog. */
export const CHOOSE_COURSE_HREF = "/home/learn";
export const CHOOSE_COURSE_LABEL = "Choose a course";

/** How the goal library and the board header name an earlier topic. */
export const EARLIER_TOPIC_LABEL = "Earlier topic (not source-checked)";

/**
 * What every card surface says when it refuses an earlier topic: Ask, the
 * review quiz, mastery, the diary check, and any change to the board.
 */
export const EARLIER_TOPIC_READ_ONLY =
  "This is an earlier topic, kept for you to read. It wasn't built from a source-checked course.";

/** Why Rebuild is not offered on an earlier topic. */
export const EARLIER_TOPIC_NO_REBUILD =
  "Earlier topics can't be rebuilt. Choose a source-checked course to start again.";

/**
 * Whether a goal is a course from the catalog. Every other goal is an earlier
 * topic.
 *
 * `source_kind` is learner-writable, so this decides only what to offer, never
 * what to trust: the retry route re-checks course access and loads the pack
 * before it builds anything, and grounding keys off the server-written
 * `milestones.concept_ids`, not off this.
 */
export function isCourseGoal(goal: { source_kind: SourceKind }): boolean {
  return goal.source_kind === "pack";
}
