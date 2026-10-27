import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { isValidPointTag } from "@/lib/tracker/points";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = await createClient();

  // Columns are enumerated rather than "*" so the diary list never ships every
  // entry's stored `transcript` to the browser — it can be thousands of words
  // per entry and nothing in the diary view reads it. Add new columns here when
  // the drawer needs them.
  const { data, error } = await supabase
    .from("milestone_entries")
    .select("id, milestone_id, user_id, title, body, fact_status, correction, " +
            "gap_note, corrected, point_id, archived_at, covered, created_at")
    .eq("milestone_id", id)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch entries" }, { status: 500 });
  }

  return NextResponse.json({ entries: data });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json()) as { body: string; title?: string; pointId?: string | null };

  const text  = body.body?.trim();
  const title = body.title?.trim() ?? null;
  if (!text) {
    return NextResponse.json({ error: "Entry body is required" }, { status: 400 });
  }

  const supabase = await createClient();

  // RLS shows a learner only their own cards. An earlier topic's diary is
  // kept to read, not added to (narrow Learn PR D, decision 2).
  const { data: card, error: cardError } = await supabase
    .from("milestones")
    .select("concept_ids")
    .eq("id", id)
    .maybeSingle();
  if (cardError) {
    console.error("[tracker/entries POST] card lookup error:", cardError.message);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }
  if (!card) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const readOnly = readOnlyRefusal(card.concept_ids as string[] | null);
  if (readOnly) return readOnly;

  // A tag pointing at a non-existent learning point is dropped, not rejected.
  const tag = (await isValidPointTag(supabase, id, body.pointId)) ? body.pointId ?? null : null;

  const { data, error } = await supabase
    .from("milestone_entries")
    .insert({ milestone_id: id, user_id: userId, body: text, title, point_id: tag })
    .select("*")
    .single();

  if (error) {
    console.error("[tracker/entries POST] DB error:", error.message);
    return NextResponse.json({ error: "Failed to save entry" }, { status: 500 });
  }

  return NextResponse.json({ entry: data });
}
