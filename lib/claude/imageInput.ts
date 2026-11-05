/**
 * A Claude call that carries images, for the one route that reads screenshots.
 *
 * `TextCall` stays text-only on purpose: the other call sites still cannot send
 * an image by accident, and a route that means to send one says so by building
 * an `ImageCall` and calling `createWithImages`. Both billing paths take the
 * same call. The API sends real image blocks (`apiImageParams`); the plan sends
 * the same blocks as one JSON line on the CLI's stdin (`subscription/cliArgs`).
 *
 * Pure, and safe in the browser: the Notes upload limit is read from here.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { textBytes, textReservation, type TextCall } from "./textInput";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface CallImage {
  mediaType: ImageMediaType;
  base64: string;
}

export interface ImageCall extends TextCall {
  /** Said just before the images, in the same turn, so the model knows what they are. */
  imageCaption: string;
  /** Sent ahead of `messages`, so they are in view for the whole conversation. */
  images: CallImage[];
}

/**
 * Claude allows 10 MB per image after base64 encoding, which grows a file by a
 * third. Counted in decimal bytes, so the limit holds whichever way "10 MB" is
 * meant.
 */
export const MAX_IMAGE_FILE_BYTES = 7_500_000;
export const MAX_IMAGE_FILE_LABEL = "7.5 MB";

/**
 * An admission hold per image, NOT a measure: logging the call gives the hold
 * back. Claude downsizes an image to at most 1,568 tokens on Sonnet 4.6 and
 * 4,784 on Claude 4.7 and later, so this covers either if a route changes model.
 */
export const IMAGE_TOKEN_ALLOWANCE = 5_000;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (text: string): number[] => [...text].map(char => char.charCodeAt(0));

/** What the bytes really are, or null. The stored MIME type is only what the browser declared. */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF8"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/**
 * A stored file as an image Claude will accept, or why it cannot be one. The
 * type comes from the bytes because Claude rejects a whole request when an
 * image does not match its declared type: a JPEG renamed `.png` would otherwise
 * fail every time, for a reason no retry could fix.
 */
export function readCallImage(bytes: Buffer): CallImage | "not-an-image" | "too-large" {
  if (bytes.length > MAX_IMAGE_FILE_BYTES) return "too-large";
  const mediaType = sniffImageType(bytes);
  if (!mediaType) return "not-an-image";
  return { mediaType, base64: bytes.toString("base64") };
}

export function imageBlock(image: CallImage): Anthropic.ImageBlockParam {
  return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } };
}

/** The turn that carries the images, on either billing path. */
export function imageTurnBlocks(call: ImageCall): Anthropic.ContentBlockParam[] {
  return [{ type: "text", text: call.imageCaption }, ...call.images.map(imageBlock)];
}

/**
 * The call as the Anthropic API takes it. The images get a user turn of their
 * own, and the API joins it to a user turn that follows.
 */
export function apiImageParams(call: ImageCall): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: call.model,
    max_tokens: call.max_tokens,
    system: call.system,
    ...(call.cache_control ? { cache_control: call.cache_control } : {}),
    messages: [{ role: "user", content: imageTurnBlocks(call) }, ...call.messages],
  };
}

/**
 * The hold for an image call. The text is held as `textReservation` holds it,
 * which also refuses an over-long conversation; base64 is left out of the sum,
 * because Claude bills an image by its size on screen, not by its bytes.
 */
export function imageReservation(call: ImageCall, attempts = 1): number {
  const images = textBytes(call.imageCaption) + call.images.length * IMAGE_TOKEN_ALLOWANCE;
  return textReservation(call, attempts) + attempts * images;
}
