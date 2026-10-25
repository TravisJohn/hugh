/**
 * Narrow Learn, phase 2: the course catalog is open to every learner
 * (PRD-narrow-learn.md, phase 2, decision 1). Phase 1's admin-preview flag,
 * PACK_LEARN_ENABLED, is gone. With the topic input retired, switching courses
 * off would leave a learner nothing to start, so the undo is a rollback to the
 * previous deployment, not a flag.
 *
 * Read the profile server-side from the protected `profiles` row. Never accept
 * it from request JSON or JWT user metadata. A blocked account is kept out, and
 * so is one whose blocked flag can't be read, so a missing value fails closed.
 */
export interface PackLearnProfile {
  is_blocked?: boolean | null;
}

export function canUsePackLearn(profile: PackLearnProfile | null | undefined): boolean {
  return profile?.is_blocked === false;
}

/** What a refused account is told, the same from every route that starts or rebuilds a course. */
export const PACK_ACCESS_REFUSED = "This account can't start a course right now.";
