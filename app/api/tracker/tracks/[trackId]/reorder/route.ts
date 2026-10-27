import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";

/**
 * Persist a manual backlog ordering. The client sends the backlog milestone ids
 * in their new order; we reassign the *existing* set of position values to them
 * (sorted ascending). Reusing the same value set keeps these cards correctly
 * interleaved relative to other columns without renumbering the whole track.
 *
 * Body: { orderedIds: string[] }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ trackId: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { trackId } = await params;
  const body = (await request.json()) as { orderedIds?: string[] };
  const orderedIds = body.orderedIds;

  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ error: "orderedIds is required" }, { status: 400 });
  }

  const supabase = await createClient();

  // Verify the track belongs to this user
  const { data: track } = await supabase
    .from("tracks")
    .select("id")
    .eq("id", trackId)
    .eq("user_id", userId)
    .single();

  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });

  // Fetch the affected milestones (scoped to this track) and their positions
  const { data: rows, error: fetchErr } = await supabase
    .from("milestones")
    .select("id, position, concept_ids")
    .eq("track_id", trackId)
    .in("id", orderedIds);

  if (fetchErr || !rows || rows.length !== orderedIds.length) {
    return NextResponse.json({ error: "Milestones not found" }, { status: 404 });
  }

  // An earlier topic's board is read-only (narrow Learn PR D, decision 2).
  for (const row of rows) {
    const readOnly = readOnlyRefusal(row.concept_ids as string[] | null);
    if (readOnly) return readOnly;
  }

  const sortedPositions = rows
    .map(r => r.position as number)
    .sort((a, b) => a - b);

  // Assign the smallest position to the first id, etc.
  const updates = orderedIds.map((id, i) =>
    supabase
      .from("milestones")
      .update({ position: sortedPositions[i] })
      .eq("id", id)
      .eq("track_id", trackId)
  );

  const results = await Promise.all(updates);
  const failed = results.find(r => r.error);
  if (failed) {
    console.error("[tracker/reorder] DB error:", failed.error?.message);
    return NextResponse.json({ error: "Failed to reorder" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
