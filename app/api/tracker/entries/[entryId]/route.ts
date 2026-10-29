import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { isValidPointTag } from "@/lib/tracker/points";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";

/**
 * Edit a diary entry, accept Hugh's suggested correction, or re-tag it to a
 * learning point.
 *
 * Body shapes:
 *  - { action: "accept" }              → apply `correction` to the body, clear the warning
 *  - { action: "archive" }             → soft-archive (hide from the diary, keep the row)
 *  - { action: "restore" }             → un-archive
 *  - { body, title?, pointId? }        → edit the entry; resets fact_status to
 *    'pending' so the client can re-verify. The permanent gap_note is preserved.
 *  - { pointId: string | null }        → re-tag only (no content change)
 *
 * Returns the updated entry.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { entryId } = await params;
  const body = (await request.json()) as {
    action?:  "accept" | "archive" | "restore";
    body?:    string;
    title?:   string;
    pointId?: string | null;
  };

  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("milestone_entries")
    .select("*")
    .eq("id", entryId)
    .eq("user_id", userId)
    .single();

  if (!existing) return NextResponse.json({ error: "Entry not found" }, { status: 404 });

  // An earlier topic's diary is kept to read (narrow Learn PR D, decision 2):
  // nothing that changes what an entry says. Archive and restore are how the
  // diary deletes and undeletes, and deleting stays allowed.
  if (body.action !== "archive" && body.action !== "restore") {
    const { data: card, error: cardError } = await supabase
      .from("milestones")
      .select("concept_ids")
      .eq("id", existing.milestone_id)
      .maybeSingle();
    if (cardError) {
      console.error("[tracker/entries PATCH] card lookup error:", cardError.message);
      return NextResponse.json({ error: "Failed to update entry" }, { status: 500 });
    }
    if (!card) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
    const readOnly = readOnlyRefusal(card.concept_ids as string[] | null);
    if (readOnly) return readOnly;
  }

  // Resolve an optional re-tag once (a tag pointing at a missing point is dropped).
  const hasPointKey = Object.prototype.hasOwnProperty.call(body, "pointId");
  const pointTag = hasPointKey
    ? ((await isValidPointTag(supabase, existing.milestone_id, body.pointId)) ? body.pointId ?? null : null)
    : undefined;

  let update: Record<string, unknown>;

  if (body.action === "accept") {
    if (!existing.correction) {
      return NextResponse.json({ error: "No correction to accept" }, { status: 400 });
    }
    // Apply the fix, clear the warning, keep the gap note as a permanent record.
    update = {
      body:        existing.correction,
      correction:  null,
      fact_status: "correct",
      corrected:   true,
    };
  } else if (body.action === "archive") {
    update = { archived_at: new Date().toISOString() };
  } else if (body.action === "restore") {
    update = { archived_at: null };
  } else if (body.body?.trim()) {
    const newBody  = body.body.trim();
    const newTitle = body.title?.trim();
    // Edited content → re-check needed. Preserve gap_note (permanent).
    update = {
      body:        newBody,
      title:       newTitle || existing.title,
      correction:  null,
      fact_status: "pending",
      corrected:   false,
    };
    if (hasPointKey) update.point_id = pointTag;
  } else if (hasPointKey) {
    // Re-tag only — no content change, so no re-verify.
    update = { point_id: pointTag };
  } else {
    return NextResponse.json({ error: "Entry body is required" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("milestone_entries")
    .update(update)
    .eq("id", entryId)
    .eq("user_id", userId)
    .select("*")
    .single();

  if (error) {
    console.error("[tracker/entries PATCH] DB error:", error.message);
    return NextResponse.json({ error: "Failed to update entry" }, { status: 500 });
  }

  return NextResponse.json({ entry: updated });
}
