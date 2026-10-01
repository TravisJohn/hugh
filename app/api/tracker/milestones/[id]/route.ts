import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { type KanbanColumn } from "@/types";

const VALID_COLUMNS: KanbanColumn[] = ["backlog", "learn", "review", "done"];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsedBody: unknown = await request.json().catch(() => null);
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsedBody as {
    column?:           KanbanColumn;
    reviewValidated?:  boolean;
    masteryValidated?: unknown;
    masteryScore?:     unknown;
    masteryFeedback?:  unknown;
  };

  const updateData: {
    kanban_column?:     KanbanColumn;
    review_validated?:  boolean;
    mastery_validated?: boolean;
  } = {};

  if ("masteryValidated" in body || "masteryScore" in body || "masteryFeedback" in body) {
    return NextResponse.json({ error: "Mastery results cannot be set through this route" }, { status: 400 });
  }

  if (body.column !== undefined) {
    if (!VALID_COLUMNS.includes(body.column)) {
      return NextResponse.json({ error: "Invalid column" }, { status: 400 });
    }
    updateData.kanban_column = body.column;
    if (body.column === "done") updateData.mastery_validated = false;
  }

  if (body.reviewValidated !== undefined) {
    updateData.review_validated = body.reviewValidated;
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const supabase = await createClient();

  // Confirm the milestone belongs to this user via its track
  const { data: milestone, error: fetchError } = await supabase
    .from("milestones")
    .select("id, tracks!track_id!inner(user_id)")
    .eq("id", id)
    .single();

  if (fetchError || !milestone) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { error: updateError } = await supabase
    .from("milestones")
    .update(updateData)
    .eq("id", id);

  if (updateError) {
    console.error("[tracker/milestones PATCH] DB error:", updateError.message);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
