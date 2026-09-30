import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { createServiceClient } from "@/lib/supabase/service";
import { normaliseLabel, isDocumentKind, findDuplicateDocument } from "@/lib/monitor/documents";
import { readVersionInput, rejectBadVersion, writeVersion } from "@/lib/monitor/versionWrite";
import type { MonitorDocument, MonitorDocumentVersion } from "@/types/monitor";

// The document library: the résumés and cover letters you maintain, and their
// versions. An application references the version it was sent — see migration
// 040 for why that reference is the point.
//
// No AI on this route. A résumé is the most personal thing Hugh stores, and
// nothing here is read by a model or by anyone but its owner.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// GET /api/monitor/documents → { documents, versions } as FLAT rows.
//
// Archived documents are included: an application can still point at one of
// their versions, and resolving "what did I send" must not depend on whether
// the document is still in active use.
export async function GET(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "monitorDocs");
  if (denied) return denied;

  try {
    const db = createServiceClient();
    const [{ data: documents, error: e1 }, { data: versions, error: e2 }] = await Promise.all([
      db.from("monitor_documents").select("*").eq("user_id", userId)
        .order("created_at", { ascending: false }),
      db.from("monitor_document_versions").select("*").eq("user_id", userId)
        .order("version", { ascending: false })
        .limit(2000),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;

    return NextResponse.json({
      documents: (documents ?? []) as MonitorDocument[],
      versions:  (versions  ?? []) as MonitorDocumentVersion[],
    });
  } catch (e) {
    console.error("[monitor/documents] load failed:", e);
    return NextResponse.json({ error: "Couldn't load your documents." }, { status: 502 });
  }
}

// POST /api/monitor/documents { kind, label, content?, note?, file? }
//   → { document, version }
//
// JSON for text only, multipart when a file is attached — the same two
// encodings the versions route takes, read by the same code, so the two paths
// cannot drift into accepting different files or different size limits.
//
// A document is created with its first version in the same request. A document
// with no versions would be a folder with nothing in it: nothing could
// reference it, and it would sit in every picker as an empty choice.
//
// A name that already exists (same kind, folded on case and spacing) does NOT
// create a twin — it becomes the next VERSION of the document you already have.
// Uploading the same CV for a second application otherwise splits one résumé's
// record across two libraries, and "sent to 2, 1 interview" degrades into
// "sent to 1" reported twice. Same rule as skills, for the same reason.
export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "monitorDocs");
  if (denied) return denied;

  const input = await readVersionInput(request);
  if (!input) return NextResponse.json({ error: "Couldn't read that upload." }, { status: 400 });

  if (!isDocumentKind(input.kind)) {
    return NextResponse.json({ error: "A résumé or a cover letter." }, { status: 400 });
  }
  const label = normaliseLabel(input.label);
  if (!label) return NextResponse.json({ error: "Give the document a name." }, { status: 400 });

  const bad = await rejectBadVersion(input);
  if (bad) return bad;

  try {
    const db = createServiceClient();

    const { data: existingRows, error: readErr } = await db
      .from("monitor_documents").select("*").eq("user_id", userId);
    if (readErr) throw readErr;

    const duplicate = findDuplicateDocument(
      (existingRows ?? []) as MonitorDocument[], input.kind, label,
    );
    if (duplicate) {
      const version = await writeVersion(db, userId, duplicate.id, input);
      return NextResponse.json({ document: duplicate, version, existing: true }, { status: 201 });
    }

    const { data: docRow, error: docErr } = await db
      .from("monitor_documents")
      .insert({ user_id: userId, kind: input.kind, label })
      .select("*").single();
    if (docErr) throw docErr;

    const document = docRow as MonitorDocument;

    try {
      const version = await writeVersion(db, userId, document.id, input);
      return NextResponse.json({ document, version, existing: false }, { status: 201 });
    } catch (verErr) {
      // Roll the empty document back rather than leaving a choice that can
      // never be picked. This is the one place a Monitor route undoes a write,
      // and it is safe precisely because nothing can reference the document yet.
      await db.from("monitor_documents").delete().eq("id", document.id).eq("user_id", userId);
      throw verErr;
    }
  } catch (e) {
    console.error("[monitor/documents] create failed:", e);
    return NextResponse.json({ error: "Couldn't save that document." }, { status: 502 });
  }
}

// PATCH /api/monitor/documents { id, label?, archived? } → { document }
//
// Renaming and archiving only. A version's CONTENT is never editable: an
// application claims to have sent a particular version, and rewriting it would
// make that claim false. To change the text you add a version.
export async function PATCH(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "monitorDocs");
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as {
    id?: string; label?: unknown; archived?: unknown;
  };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.label !== undefined) {
    const label = normaliseLabel(body.label);
    if (!label) return NextResponse.json({ error: "Give the document a name." }, { status: 400 });
    patch.label = label;
  }
  if (typeof body.archived === "boolean") {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("monitor_documents")
      .update(patch)
      .eq("id", body.id).eq("user_id", userId)
      .select("*").single();
    if (error) throw error;
    return NextResponse.json({ document: data as MonitorDocument });
  } catch (e) {
    console.error("[monitor/documents] update failed:", e);
    return NextResponse.json({ error: "Couldn't update that document." }, { status: 502 });
  }
}
