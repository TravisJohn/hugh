/** Release containment for S3. This is not server-authoritative accounting.
 * Realtime remains an administrator preview until sessions, spend and expiry
 * are owned by the server. Never accept these flags from request JSON or JWT
 * user metadata; callers must read the protected profiles row server-side.
 */
export interface RealtimeAccessProfile {
  is_admin?: boolean | null;
  is_blocked?: boolean | null;
}

export function canUseRealtime(
  enabled: string | undefined,
  profile: RealtimeAccessProfile | null | undefined,
): boolean {
  return enabled === "true" && profile?.is_admin === true && profile.is_blocked === false;
}
