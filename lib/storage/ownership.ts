// Storage references in database rows are untrusted, even when the row belongs
// to the caller. Do not decode or normalize paths: reject ambiguous spellings
// before a privileged Storage client gets a chance to interpret them.
const SEGMENT = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export function isOwnedStoragePath(userId: string, path: unknown): path is string {
  if (typeof path !== "string") return false;
  const segments = path.split("/");
  return segments.length >= 2 && segments[0] === userId &&
    // Compare the full match: JavaScript's $ also accepts a final newline.
    segments.every((segment) => SEGMENT.exec(segment)?.[0] === segment);
}

/** Validate the whole batch before doing any Storage work. Never log a path. */
export function assertOwnedStoragePaths(userId: string, paths: readonly unknown[]): void {
  if (!paths.every((path) => isOwnedStoragePath(userId, path))) {
    throw new Error("Stored file reference does not belong to this account.");
  }
}
