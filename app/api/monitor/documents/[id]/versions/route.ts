import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { createServiceClient } from "@/lib/supabase/service";
import { readVersionInput, rejectBadVersion, writeVersion } from "@/lib/monitor/versionWrite";

// Adding a version is the ONLY way to change a document's text or file.
//
// There is deliberately no PATCH for a version's body. An application records
// which version it was sent; rewriting that version would make the application
// claim to have sent something it never sent, and the record would be wrong in
// the one way that matters — retrospectively.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// POST /api/monitor/documents/[id]/versions → { version }
// JSON for text only, multipart when a file is attached.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "monitorDocs");
  if (denied) return denied;

  const { id: documentId } = await params;

  const input = await readVersionInput(request);
  if (!input) return NextResponse.json({ error: "Couldn't read that upload." }, { status: 400 });

  const bad = await rejectBadVersion(input);
  if (bad) return bad;

  try {
    const db = createServiceClient();

    const { data: doc } = await db
      .from("monitor_documents").select("id")
      .eq("id", documentId).eq("user_id", userId)
      .maybeSingle();
    if (!doc) return NextResponse.json({ error: "No such document." }, { status: 404 });

    const version = await writeVersion(db, userId, documentId, input);
    return NextResponse.json({ version }, { status: 201 });
  } catch (e) {
    console.error("[monitor/versions] create failed:", e);
    return NextResponse.json({ error: "Couldn't save that version." }, { status: 502 });
  }
}
