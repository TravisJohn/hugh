import { describe, it, expect } from "vitest";
import {
  apiImageParams,
  IMAGE_TOKEN_ALLOWANCE,
  imageReservation,
  MAX_IMAGE_FILE_BYTES,
  readCallImage,
  sniffImageType,
  type ImageCall,
} from "./imageInput";
import { TextInputError, textReservation } from "./textInput";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00];
const GIF = [...Buffer.from("GIF89a")];
const WEBP = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WEBP")];

const call: ImageCall = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: "You are Hugh.",
  imageCaption: "Here is the question.",
  images: [{ mediaType: "image/png", base64: "AAAA" }],
  messages: [{ role: "user", content: "I picked B." }],
};

describe("sniffImageType", () => {
  it.each([
    ["image/png", PNG],
    ["image/jpeg", JPEG],
    ["image/gif", GIF],
    ["image/webp", WEBP],
  ])("recognises %s from its bytes", (type, bytes) => {
    expect(sniffImageType(Uint8Array.from(bytes))).toBe(type);
  });

  it("does not take any RIFF file for a WebP, because a WAV starts the same way", () => {
    const wav = [...Buffer.from("RIFF"), 1, 2, 3, 4, ...Buffer.from("WAVE")];
    expect(sniffImageType(Uint8Array.from(wav))).toBeNull();
  });

  it("returns null for bytes too short to be any image, rather than reading past the end", () => {
    expect(sniffImageType(Uint8Array.from([0x89]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("readCallImage", () => {
  it("trusts the bytes over the label, so a JPEG named .png still reaches Claude correctly typed", () => {
    expect(readCallImage(Buffer.from(JPEG))).toEqual({
      mediaType: "image/jpeg",
      base64: Buffer.from(JPEG).toString("base64"),
    });
  });

  it("refuses a file that is not an image, since no retry could fix it", () => {
    expect(readCallImage(Buffer.from("%PDF-1.7"))).toBe("not-an-image");
  });

  it("accepts a file exactly at the limit and refuses one byte over", () => {
    const atLimit = Buffer.alloc(MAX_IMAGE_FILE_BYTES);
    Buffer.from(PNG).copy(atLimit);
    expect(readCallImage(atLimit)).toMatchObject({ mediaType: "image/png" });
    expect(readCallImage(Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1))).toBe("too-large");
  });

  it("keeps the file limit inside Claude's 10 MB limit once base64 has grown it", () => {
    expect(Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4).toBeLessThanOrEqual(10_000_000);
  });
});

describe("apiImageParams", () => {
  it("puts the caption and images in a first user turn, then the thread in its real roles", () => {
    const thread: ImageCall["messages"] = [
      { role: "user", content: "I picked B." },
      { role: "assistant", content: "A is right." },
      { role: "user", content: "Why?" },
    ];
    expect(apiImageParams({ ...call, messages: thread }).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Here is the question." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
      ...thread,
    ]);
  });

  it("sends only fields the API knows, because it rejects any it does not", () => {
    const params = apiImageParams(call);
    expect(params).not.toHaveProperty("images");
    expect(params).not.toHaveProperty("imageCaption");
    expect(params).toMatchObject({ model: call.model, max_tokens: call.max_tokens, system: call.system });
  });
});

describe("imageReservation", () => {
  it("holds a fixed allowance per image instead of counting base64 as text", () => {
    const huge = { ...call, images: [{ mediaType: "image/png" as const, base64: "A".repeat(5_000_000) }] };
    expect(imageReservation(huge)).toBe(imageReservation(call));
  });

  it("holds more for a four-snip question than for a single screenshot", () => {
    const image = call.images[0];
    const four = { ...call, images: [image, image, image, image] };
    expect(imageReservation(four) - imageReservation(call)).toBe(3 * IMAGE_TOKEN_ALLOWANCE);
  });

  it("includes everything the text path would hold", () => {
    expect(imageReservation(call)).toBeGreaterThan(textReservation(call));
  });

  it("still refuses an over-long conversation with the learner-facing error", () => {
    const long = { ...call, messages: [{ role: "user" as const, content: "x".repeat(129 * 1024) }] };
    expect(() => imageReservation(long)).toThrow(TextInputError);
  });
});
