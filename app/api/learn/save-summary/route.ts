import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidPointTag } from "@/lib/tracker/points";
import { sanitizeCovered, sanitizeTranscript } from "@/lib/learn/sessionRecord";
import { readOnlyRefusal } from "@/lib/packs/cardAccess";
import { CARDLESS_SAVE_MESSAGE, CARDLESS_SAVE_ROUTE, recordRetiredCall } from "@/lib/learn/retiredRoute";
import { CHOOSE_COURSE_HREF } from "@/lib/learn/earlierTopic";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json() as {
    topic:        string;
    story:        string;
    takeaway:     string;
    title?:       string;
    goalId?:      string;
    milestoneId?: string;
    pointId?:     string | null;
    covered?:     unknown;
    transcript?:  unknown;
  };

  const { topic, story, takeaway, title, milestoneId, pointId } = body;
  if (!topic || !story || !takeaway) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const entryTitle = title?.trim() || topic;
  const entryBody  = `${story}\n\nKey Takeaway: ${takeaway}`;

  // Both arrive from the browser, so both are re-validated here rather than
  // trusted from the summarize response they originally came from.
  const covered    = sanitizeCovered(body.covered);
  const transcript = sanitizeTranscript(body.transcript);

  // ── Case 1: milestone-scoped session → save as a diary entry on that card ──
  if (milestoneId) {
    const { data: ms } = await supabase
      .from("milestones")
      .select("id, concept_ids")
      .eq("id", milestoneId)
      .single();

    if (!ms) return NextResponse.json({ error: "Milestone not found" }, { status: 404 });

    // An earlier topic's diary is kept to read (narrow Learn PR D).
    const readOnly = readOnlyRefusal(ms.concept_ids as string[] | null);
    if (readOnly) return readOnly;

    // A tag pointing at a non-existent learning point is dropped rather than rejected.
    const tag = (await isValidPointTag(supabase, milestoneId, pointId)) ? pointId ?? null : null;

    const { error: entryError } = await supabase
      .from("milestone_entries")
      .insert({
        milestone_id: milestoneId,
        user_id:      user.id,
        title:        entryTitle,
        body:         entryBody,
        point_id:     tag,
        covered,
        transcript,
      });

    if (entryError) {
      return NextResponse.json({ error: "Failed to save diary entry" }, { status: 500 });
    }

    return NextResponse.json({ milestoneId, saved: true });
  }

  // ── No card: the closed path ──
  //
  // This branch used to add a new card, with no concept_ids, to the goal's
  // track. Since narrow Learn PR D Ask always names a card, so only a tab
  // opened before then can get here, and a card-less note on a course board
  // would be an ungrounded card among the syllabus. Refused and counted, so
  // phase 3 can delete it once nothing real reaches it.
  await recordRetiredCall(user.id, CARDLESS_SAVE_ROUTE);
  return NextResponse.json(
    { error: CARDLESS_SAVE_MESSAGE, chooseCourse: CHOOSE_COURSE_HREF },
    { status: 400 },
  );
}
