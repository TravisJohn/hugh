import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { requireProvisionedApi } from "@/lib/auth/requireProvisioned";
import { createServiceClient } from "@/lib/supabase/service";
import { MONITOR_DOCS_BUCKET, SIGNED_URL_TTL } from "@/lib/monitor/storage";
import { assertOwnedStoragePaths } from "@/lib/storage/ownership";

// Hand back a short-lived signed URL for one version's file.
//
// Minted on request rather than attached to every version in the documents
// GET: most versions are never opened, and a list response carrying a live URL
// to every résumé you have ever written is a much larger thing to leak than one
// URL to the one you asked for. Five minutes, then it is dead.

const unauth = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

// GET /api/monitor/documents/file?version=<id>[&download=1] → { url, file_name }
//
// Without `download` the URL renders inline — a PDF opens in the viewer rather
// than landing in the downloads folder, which is what you want when you are
// only checking which version this is. With it, the object is served as an
// attachment under its original filename.
export async function GET(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return unauth();

  // Privacy pass: this surface holds personal material and is off by
  // default (migration 050). RLS stops the browser reaching the tables
  // and bucket directly; this stops our own service-role client, which
  // bypasses RLS entirely.
  const denied = await requireProvisionedApi(userId, "monitorDocs");
  if (denied) return denied;

  const versionId = request.nextUrl.searchParams.get("version");
  if (!versionId) return NextResponse.json({ error: "version required" }, { status: 400 });

  try {
    const db = createServiceClient();

    // Scoped by user_id as well as id: the row is the authorisation check, and
    // the service-role client would otherwise happily sign anyone's object.
    const { data: row } = await db
      .from("monitor_document_versions")
      .select("file_path, file_name")
      .eq("id", versionId).eq("user_id", userId)
      .maybeSingle();

    if (!row?.file_path) {
      return NextResponse.json({ error: "No file on that version." }, { status: 404 });
    }

    const asDownload = request.nextUrl.searchParams.get("download") === "1";
    assertOwnedStoragePaths(userId, [row.file_path]);
    const { data, error } = await db.storage
      .from(MONITOR_DOCS_BUCKET)
      .createSignedUrl(
        row.file_path as string,
        SIGNED_URL_TTL,
        asDownload ? { download: (row.file_name as string | null) ?? true } : undefined,
      );
    if (error || !data?.signedUrl) throw error ?? new Error("no signed url");

    return NextResponse.json({ url: data.signedUrl, file_name: row.file_name });
  } catch (e) {
    console.error("[monitor/documents/file] sign failed:", e);
    return NextResponse.json({ error: "Couldn't open that file." }, { status: 502 });
  }
}
