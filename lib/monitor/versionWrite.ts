import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { nextVersionNumber, ALLOWED_DOC_MIME, MAX_DOC_BYTES, VERSION_NOTE_MAX } from "./documents";
import { normaliseText, APP_DOC_MAX } from "./applications";
import { MONITOR_DOCS_BUCKET } from "./storage";
import { assertOwnedStoragePaths } from "@/lib/storage/ownership";
import { matchesUploadSignature } from "@/lib/storage/fileSignatures";
import type { MonitorDocumentVersion } from "@/types/monitor";

// Writing a version — shared by "create a document" and "add a version to one",
// because both do exactly the same thing once the document exists. Keeping it in
// one place is what stops the two paths drifting into accepting different files,
// different size limits, or different definitions of an empty version.

export interface VersionInput {
  /** The text: searchable, readable inline. */
  content: string | null;
  /** Why this version exists. */
  note:    string | null;
  /** The artifact itself, when one was uploaded. */
  file:    File | null;
  /** Only used when creating a document. */
  label:   string | null;
  kind:    string | null;
}

/**
 * Pull a version body out of whichever encoding the client used — JSON for text
 * only, multipart when a file is attached. One endpoint per concept; the
 * encoding is an implementation detail of the browser, not a second feature.
 */
export async function readVersionInput(request: NextRequest): Promise<VersionInput | null> {
  const type = request.headers.get("content-type") ?? "";

  if (type.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    const file = form.get("file");
    return {
      content: normaliseText(form.get("content"), APP_DOC_MAX),
      note:    normaliseText(form.get("note"), VERSION_NOTE_MAX),
      // A zero-byte File is what an empty file input sends; treat it as nothing.
      file:    file instanceof File && file.size > 0 ? file : null,
      label:   normaliseText(form.get("label"), 120),
      kind:    typeof form.get("kind") === "string" ? String(form.get("kind")) : null,
    };
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    content: normaliseText(body.content, APP_DOC_MAX),
    note:    normaliseText(body.note, VERSION_NOTE_MAX),
    file:    null,
    label:   normaliseText(body.label, 120),
    kind:    typeof body.kind === "string" ? body.kind : null,
  };
}

/**
 * Reject anything a version may not carry, before the database is touched.
 * Returns a response to send, or null when the input is fine.
 *
 * Validation happens up front precisely so a refused file never leaves a half
 * a version behind.
 */
export async function rejectBadVersion(input: VersionInput): Promise<NextResponse | null> {
  if (!input.content && !input.file) {
    return NextResponse.json({ error: "Attach a file or paste the text." }, { status: 400 });
  }
  if (input.file) {
    if (!ALLOWED_DOC_MIME[input.file.type]) {
      return NextResponse.json({ error: "PDF, DOCX, DOC, RTF or ODT only." }, { status: 415 });
    }
    if (input.file.size > MAX_DOC_BYTES) {
      return NextResponse.json({ error: "That file is larger than 5 MB." }, { status: 413 });
    }
    const header = new Uint8Array(await input.file.slice(0, 16).arrayBuffer());
    if (!matchesUploadSignature(input.file.type, header)) {
      return NextResponse.json({ error: "The document content does not match its file type." }, { status: 415 });
    }
  }
  return null;
}

/**
 * Insert the next version of a document, uploading its file if there is one.
 *
 * Assumes the caller has already confirmed the document belongs to this user
 * and has run `rejectBadVersion`.
 */
export async function writeVersion(
  db: SupabaseClient,
  userId: string,
  documentId: string,
  input: VersionInput,
): Promise<MonitorDocumentVersion> {
  const { data: existing, error: readErr } = await db
    .from("monitor_document_versions").select("*")
    .eq("document_id", documentId).eq("user_id", userId);
  if (readErr) throw readErr;

  const version = nextVersionNumber((existing ?? []) as MonitorDocumentVersion[]);

  // Keyed under the owner's id so the storage policies can scope on the first
  // path segment. The extension comes from our allowlist, never from the
  // uploaded filename, so a mislabelled file cannot name its object on disk.
  let filePath: string | null = null;
  if (input.file) {
    const ext = ALLOWED_DOC_MIME[input.file.type];
    filePath = `${userId}/${documentId}/${crypto.randomUUID()}.${ext}`;
    assertOwnedStoragePaths(userId, [filePath]);
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const { error: upErr } = await db.storage
      .from(MONITOR_DOCS_BUCKET)
      .upload(filePath, bytes, { contentType: input.file.type, upsert: false });
    if (upErr) throw upErr;
  }

  const { data, error } = await db
    .from("monitor_document_versions")
    .insert({
      document_id: documentId,
      user_id:     userId,
      version,
      content:     input.content,
      note:        input.note,
      file_path:   filePath,
      file_name:   input.file ? input.file.name.slice(0, 200) : null,
      file_size:   input.file ? input.file.size : null,
      mime:        input.file ? input.file.type : null,
    })
    .select("*").single();

  if (error) {
    // The bytes are in the bucket but nothing references them. Remove them
    // rather than leaving an object no row can ever reach, or delete.
    if (filePath) await db.storage.from(MONITOR_DOCS_BUCKET).remove([filePath]);
    throw error;
  }

  return data as MonitorDocumentVersion;
}
