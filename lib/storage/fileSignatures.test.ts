import { describe, expect, it } from "vitest";
import { matchesUploadSignature } from "./fileSignatures";

describe("upload signatures", () => {
  it.each([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
    ["application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]],
    ["application/msword", [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
    ["application/rtf", [0x7b, 0x5c, 0x72, 0x74, 0x66]],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [0x50, 0x4b, 0x03, 0x04]],
    ["application/vnd.oasis.opendocument.text", [0x50, 0x4b, 0x03, 0x04]],
  ])("accepts the expected header for %s", (mime, header) => {
    expect(matchesUploadSignature(mime, new Uint8Array(header))).toBe(true);
  });

  it("rejects mismatched, truncated and unknown headers", () => {
    expect(matchesUploadSignature("image/png", new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    expect(matchesUploadSignature("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false);
    expect(matchesUploadSignature("application/pdf", new Uint8Array([0x25, 0x50]))).toBe(false);
    expect(matchesUploadSignature("application/octet-stream", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });
});
