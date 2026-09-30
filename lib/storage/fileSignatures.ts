/** Check the file header before trusting a browser-supplied MIME type. */
export function matchesUploadSignature(mime: string, bytes: Uint8Array): boolean {
  const starts = (...magic: number[]) =>
    bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);

  switch (mime) {
    case "image/png": return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg": return starts(0xff, 0xd8, 0xff);
    case "image/gif": return starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61)
      || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    case "image/webp": return starts(0x52, 0x49, 0x46, 0x46)
      && bytes.length >= 12
      && [0x57, 0x45, 0x42, 0x50].every((value, index) => bytes[index + 8] === value);
    case "application/pdf": return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
    case "application/msword": return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case "application/rtf": return starts(0x7b, 0x5c, 0x72, 0x74, 0x66);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.oasis.opendocument.text":
      // Both are ZIP containers. Deeper format parsing happens when content is extracted.
      return starts(0x50, 0x4b, 0x03, 0x04);
    default: return false;
  }
}
