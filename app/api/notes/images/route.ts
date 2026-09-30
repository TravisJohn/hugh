import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { createServiceClient } from "@/lib/supabase/service";
import { NOTE_IMAGES_BUCKET, SIGNED_URL_TTL } from "@/lib/notes/storage";
import { assertOwnedStoragePaths } from "@/lib/storage/ownership";
import { matchesUploadSignature } from "@/lib/storage/fileSignatures";
import { MAX_BUCKET_PARTS, type NoteImage, type NoteImageBucket } from "@/types";

// Screenshots for a note. Uploads go through this route (service-role) so we can
// validate size/type and key the object under the owner's id; reads hand back
// short-lived signed URLs. The Anthropic/OpenAI keys never touch the client, and
// neither does the Storage service key.
//
// A "bucket" is one screenshot slot: the row with parent_image_id = null, which
// owns the title, the flag and the chat thread. Rows pointing at it are extra
// snips of the SAME question — a page too tall for one capture — stacked under
// it in `position` order and sent to the Coach together. Parts are exactly one
// level deep: a part can never itself have parts.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per screenshot
const ALLOWED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const IMAGE_COLS = "id, note_id, title, storage_path, mime, created_at, flag, parent_image_id, position";
const FLAGS = new Set(["red", "yellow", "green"]);

// Attach a fresh signed URL to each image row (best-effort per row).
async function withSignedUrls(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  rows: Array<Omit<NoteImage, "url">>,
): Promise<NoteImage[]> {
  assertOwnedStoragePaths(userId, rows.map((row) => row.storage_path));
  return Promise.all(
    rows.map(async (r) => {
      const { data } = await db.storage
        .from(NOTE_IMAGES_BUCKET)
        .createSignedUrl(r.storage_path, SIGNED_URL_TTL);
      return { ...r, url: data?.signedUrl ?? null };
    }),
  );
}

// Fold flat rows into buckets. Callers pass rows already ordered by position
// (then created_at), so parts arrive in the order they should be stacked.
function toBuckets(rows: NoteImage[]): NoteImageBucket[] {
  const partsByParent = new Map<string, NoteImage[]>();
  for (const row of rows) {
    if (!row.parent_image_id) continue;
    const list = partsByParent.get(row.parent_image_id) ?? [];
    list.push(row);
    partsByParent.set(row.parent_image_id, list);
  }
  return rows
    .filter((row) => !row.parent_image_id)
    .map((row) => ({ ...row, parts: partsByParent.get(row.id) ?? [] }));
}

// Confirms the note belongs to this user; returns true/false.
async function ownsNote(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  noteId: string,
): Promise<boolean> {
  const { data } = await db.from("notes").select("id").eq("id", noteId).eq("user_id", userId).maybeSingle();
  return !!data;
}

// GET /api/notes/images?note_id=<id> → { images: NoteImageBucket[] } with
// signed URLs on the bucket and on every snip inside it.
export async function GET(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) return denied;

  const noteId = request.nextUrl.searchParams.get("note_id");
  if (!noteId) return NextResponse.json({ error: "note_id required" }, { status: 400 });

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("note_images")
      .select(IMAGE_COLS)
      .eq("user_id", userId)
      .eq("note_id", noteId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    const images = toBuckets(await withSignedUrls(db, userId, data ?? []));
    return NextResponse.json({ images });
  } catch (e) {
    console.error("[notes/images] list failed:", e);
    return NextResponse.json({ error: "Couldn't load images." }, { status: 502 });
  }
}

// POST /api/notes/images (multipart: note_id, file, parent_image_id?) → the
// created row. With parent_image_id it becomes an extra snip inside that
// bucket; without, it starts a new bucket of its own.
export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const noteId = String(form.get("note_id") ?? "").trim();
  const parentId = String(form.get("parent_image_id") ?? "").trim() || null;
  const file = form.get("file");
  if (!noteId) return NextResponse.json({ error: "note_id required" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });

  const ext = ALLOWED_MIME[file.type];
  if (!ext) return NextResponse.json({ error: "Only PNG, JPEG, WebP or GIF images are supported." }, { status: 415 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Image is larger than 10 MB." }, { status: 413 });

  try {
    const db = createServiceClient();
    if (!(await ownsNote(db, userId, noteId))) {
      return NextResponse.json({ error: "Note not found." }, { status: 404 });
    }

    // Siblings — the rows this upload will be ordered among. For a new bucket
    // that's the note's other buckets; for a snip it's the parent's other snips.
    // Both the default title and the position come from that list, so a fresh
    // row arrives labelled and already at the end.
    const siblingQuery = db
      .from("note_images")
      .select("id, position")
      .eq("user_id", userId)
      .eq("note_id", noteId);
    const { data: siblings, error: sibErr } = parentId === null
      ? await siblingQuery.is("parent_image_id", null)
      : await siblingQuery.eq("parent_image_id", parentId);
    if (sibErr) throw sibErr;

    if (parentId !== null) {
      // One level only, same note, same owner — and a hard ceiling, because
      // every snip is inlined as base64 into each Coach request.
      const { data: parent } = await db
        .from("note_images")
        .select("id, parent_image_id")
        .eq("id", parentId).eq("user_id", userId).eq("note_id", noteId)
        .maybeSingle();
      if (!parent) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });
      if (parent.parent_image_id) {
        return NextResponse.json({ error: "That's already part of another screenshot." }, { status: 409 });
      }
      if ((siblings ?? []).length + 1 >= MAX_BUCKET_PARTS) {
        return NextResponse.json(
          { error: `A screenshot can hold ${MAX_BUCKET_PARTS} snips. Start a new one for the rest.` },
          { status: 409 },
        );
      }
    }

    const position = (siblings ?? []).reduce((max, r) => Math.max(max, (r.position as number) + 1), 0);
    const title = parentId === null
      ? `Screenshot ${(siblings ?? []).length + 1}`
      : `Snip ${(siblings ?? []).length + 2}`; // the bucket itself is snip 1

    const path = `${userId}/${noteId}/${crypto.randomUUID()}.${ext}`;
    assertOwnedStoragePaths(userId, [path]);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesUploadSignature(file.type, bytes)) {
      return NextResponse.json({ error: "The image content does not match its file type." }, { status: 415 });
    }
    const { error: upErr } = await db.storage
      .from(NOTE_IMAGES_BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) throw upErr;

    const { data, error } = await db
      .from("note_images")
      .insert({
        user_id: userId, note_id: noteId, title,
        storage_path: path, mime: file.type,
        parent_image_id: parentId, position,
      })
      .select(IMAGE_COLS)
      .single();
    if (error) throw error;

    const [image] = await withSignedUrls(db, userId, [data]);
    return NextResponse.json({ image });
  } catch (e) {
    console.error("[notes/images] upload failed:", e);
    return NextResponse.json({ error: "Couldn't upload that image." }, { status: 502 });
  }
}

// Make a snip the top slice of its bucket.
//
// The bucket row owns the title, the flag and the whole chat thread, so it must
// stay the bucket — we swap the image BYTES between the snip and its parent
// instead of re-parenting rows. Ids never move, so nothing detaches from its
// conversation. This is what makes a tall question pasted bottom-half-first
// fixable rather than something you have to delete and redo.
async function promoteSnip(
  db: ReturnType<typeof createServiceClient>,
  userId: string,
  id: string,
): Promise<NextResponse> {
  const { data: snip } = await db
    .from("note_images").select("id, parent_image_id, storage_path, mime")
    .eq("id", id).eq("user_id", userId).maybeSingle();
  if (!snip) return NextResponse.json({ error: "Image not found." }, { status: 404 });
  if (!snip.parent_image_id) {
    return NextResponse.json({ error: "That's already the top slice." }, { status: 409 });
  }

  const { data: parent } = await db
    .from("note_images").select("id, storage_path, mime")
    .eq("id", snip.parent_image_id).eq("user_id", userId).maybeSingle();
  if (!parent) return NextResponse.json({ error: "Screenshot not found." }, { status: 404 });

  assertOwnedStoragePaths(userId, [snip.storage_path, parent.storage_path]);

  const [a, b] = await Promise.all([
    db.from("note_images").update({ storage_path: parent.storage_path, mime: parent.mime })
      .eq("id", snip.id).eq("user_id", userId),
    db.from("note_images").update({ storage_path: snip.storage_path, mime: snip.mime })
      .eq("id", parent.id).eq("user_id", userId),
  ]);
  if (a.error || b.error) throw a.error ?? b.error;

  return NextResponse.json({ ok: true });
}

// PATCH /api/notes/images { id, title?, flag?, position?, promote? } → rename,
// flag, reorder, or lift a snip to the top of its bucket. `flag` is one of
// 'red' | 'yellow' | 'green' | null (null clears it); `position` reorders a snip
// within its bucket, or a bucket within its note.
export async function PATCH(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string; title?: string; flag?: string | null; position?: number; promote?: boolean;
  };
  const id = body.id?.trim();
  const title = body.title?.trim().slice(0, 200);
  const hasFlag = Object.prototype.hasOwnProperty.call(body, "flag");
  const hasPosition = typeof body.position === "number" && Number.isFinite(body.position);
  if (hasFlag && body.flag !== null && !FLAGS.has(body.flag ?? "")) {
    return NextResponse.json({ error: "flag must be red, yellow, green or null" }, { status: 400 });
  }
  if (!id || (!title && !hasFlag && !hasPosition && body.promote !== true)) {
    return NextResponse.json({ error: "id and (title, flag, position or promote) required" }, { status: 400 });
  }

  const update: { title?: string; flag?: string | null; position?: number } = {};
  if (title) update.title = title;
  if (hasFlag) update.flag = body.flag ?? null;
  if (hasPosition) update.position = body.position;

  try {
    const db = createServiceClient();
    if (body.promote === true) return await promoteSnip(db, userId, id);

    const { data, error } = await db
      .from("note_images")
      .update(update)
      .eq("id", id)
      .eq("user_id", userId)
      .select(IMAGE_COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Image not found." }, { status: 404 });

    const [image] = await withSignedUrls(db, userId, [data]);
    return NextResponse.json({ image });
  } catch (e) {
    console.error("[notes/images] update failed:", e);
    return NextResponse.json({ error: "Couldn't update that image." }, { status: 502 });
  }
}

// DELETE /api/notes/images?id=<imageId> → remove the row and its Storage object.
// Deleting a bucket takes its snips with it: the rows go by FK cascade, but the
// bytes have to be removed explicitly or they'd be orphaned in the bucket.
export async function DELETE(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "notes");
  if (denied) return denied;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  try {
    const db = createServiceClient();
    const { data: row, error: readError } = await db
      .from("note_images").select("storage_path, parent_image_id")
      .eq("id", id).eq("user_id", userId).maybeSingle();
    if (readError) throw readError;

    const paths: string[] = row ? [row.storage_path as string] : [];
    if (row && !row.parent_image_id) {
      const { data: parts, error: partsError } = await db
        .from("note_images").select("storage_path").eq("user_id", userId).eq("parent_image_id", id);
      if (partsError) throw partsError;
      for (const p of parts ?? []) paths.push(p.storage_path as string);
    }
    assertOwnedStoragePaths(userId, paths);
    if (paths.length > 0) {
      const { error: removeError } = await db.storage.from(NOTE_IMAGES_BUCKET).remove(paths);
      if (removeError) throw removeError;
    }
    const { error } = await db.from("note_images").delete().eq("id", id).eq("user_id", userId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[notes/images] delete failed:", e);
    return NextResponse.json({ error: "Couldn't delete that image." }, { status: 502 });
  }
}
