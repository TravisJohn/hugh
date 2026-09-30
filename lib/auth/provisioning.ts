import { isActiveAccount, type AccountAccessFlags } from "./accountAccess";

/**
 * Which personal-data surfaces an account is allowed to hold data in.
 *
 * Part of the privacy pass. `/notes` (screenshots, read by OpenAI's vision
 * model) and Monitor's documents/applications (résumés, cover letters,
 * employment history) are the richest personal material in Hugh, and signup is
 * open. Migration 050 puts both behind a per-learner flag that defaults to off,
 * so the public product does not accept that material at all.
 *
 * Pure and dependency-free (CLAUDE.md rule 7): this is an access-control
 * decision, so it is tested rather than inlined into a route. The reads live in
 * `requireProvisioned.ts` beside it, the way `requireAdmin.ts` is arranged.
 *
 * THE RULE MUST MATCH THE DATABASE. Migrations 050 and 055 put the same checks in RLS,
 * with no `is_admin` special case — admins are provisioned by having the
 * columns set true, not by bypassing the rule. Do not add a bypass here either:
 * a gate that is laxer in TypeScript than in Postgres produces a UI that offers
 * something the database then refuses.
 */

/** The surfaces gated by migration 050. */
export type ProvisionedSurface = "notes" | "monitorDocs";

/** The `profiles` columns migration 050 adds, as read back from Supabase. */
export interface ProvisioningFlags extends AccountAccessFlags {
  notes_enabled?:        boolean | null;
  monitor_docs_enabled?: boolean | null;
}

/** Surface → column. One mapping, so a rename cannot half-happen. */
export const PROVISIONING_COLUMN: Record<ProvisionedSurface, keyof ProvisioningFlags> = {
  notes:       "notes_enabled",
  monitorDocs: "monitor_docs_enabled",
};

/** The select list for reading both flags in one round-trip. */
export const PROVISIONING_COLUMNS = "notes_enabled, monitor_docs_enabled, approved, is_blocked";

/**
 * Is this account allowed to use the surface?
 *
 * Fails CLOSED on anything that is not exactly `true` — a missing profile, a
 * null column, a blocked or unapproved account, or code deployed before
 * migration 050 is applied, where the column does not exist and reads back as
 * `undefined`. The same active-account rule is enforced by migration 055.
 */
export function isProvisioned(
  flags:   ProvisioningFlags | null | undefined,
  surface: ProvisionedSurface,
): boolean {
  if (!flags) return false;
  return isActiveAccount(flags) && flags[PROVISIONING_COLUMN[surface]] === true;
}
