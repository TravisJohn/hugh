/**
 * Narrow Learn, phase 1: courses built from reference packs are an
 * administrator preview, so Travis can test them on the live site while
 * learners see nothing new (PRD-narrow-learn.md, phase 1 architecture).
 *
 * Read the profile server-side from the protected `profiles` row. Never accept
 * these flags from request JSON or JWT user metadata. Same shape as
 * `canUseRealtime`, kept separate so each preview is switched off on its own.
 */
export interface PackLearnProfile {
  is_admin?:   boolean | null;
  is_blocked?: boolean | null;
}

export function canUsePackLearn(
  enabled: string | undefined,
  profile: PackLearnProfile | null | undefined,
): boolean {
  return enabled === "true" && profile?.is_admin === true && profile.is_blocked === false;
}
