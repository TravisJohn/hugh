export interface AccountAccessFlags {
  approved?: boolean | null;
  is_blocked?: boolean | null;
}

/** A valid session alone does not grant access after an account is blocked. */
export function isActiveAccount(flags: AccountAccessFlags | null | undefined): boolean {
  return flags?.approved === true && flags.is_blocked === false;
}
