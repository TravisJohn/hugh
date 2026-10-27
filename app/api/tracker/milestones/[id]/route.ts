import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { buildMilestonePatch } from "@/lib/tracker/milestonePatch";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";

interface OwnedMilestone {
  id:          string;
  concept_ids: string[] | null;
  tracks:      { user_id: string } | null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // What this request may write, and which results a move resets. Results are
  // refused here: the mastery session route and tracker/review/submit record
  // them after grading the learner themselves.
  const patch = buildMilestonePatch(body);
  if (!patch.ok) {
    return NextResponse.json({ error: patch.error }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error: fetchError } = await supabase
    .from("milestones")
    .select("id, concept_ids, tracks!track_id!inner(user_id)")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    console.error("[tracker/milestones PATCH] lookup error:", fetchError.message);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
  // RLS already hides other learners' rows from this read. The explicit check
  // is the second lock, because the write below runs as the service role,
  // where RLS does not apply.
  const row = data as unknown as OwnedMilestone | null;
  if (!row || row.tracks?.user_id !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // An earlier topic is read-only (narrow Learn PR D, decision 2): no moves
  // and no edits. So is a course card whose pack can't be loaded.
  const readOnly = readOnlyRefusal(row.concept_ids);
  if (readOnly) return readOnly;

  // Since migration 058 a learner's session cannot write review or mastery
  // results, and a move can reset them, so the write uses the service role.
  const { error: updateError } = await createServiceClient()
    .from("milestones")
    .update(patch.write)
    .eq("id", id);

  if (updateError) {
    console.error("[tracker/milestones PATCH] DB error:", updateError.message);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
