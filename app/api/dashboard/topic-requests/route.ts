import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { createServiceClient } from "@/lib/supabase/service";
import { logSafeError } from "@/lib/observability/log";
import {
  checkRequest, mayRequestAnother, requestWindowStart, REQUEST_REJECTION_MESSAGE,
} from "@/lib/learn/topicRequest";

// POST /api/dashboard/topic-requests { topic } → 201 { saved: true }
//
// The request box (PRD-narrow-learn.md, row 6): a learner asks for a subject
// the catalog doesn't have. Spends nothing: no model call, no build and no
// logUsage, because there is nothing to log. It is not a route into track
// generation.
//
// Server-written only (migration 061). Learners hold no privilege on
// topic_requests, so the daily limit below can't be skipped by calling
// Supabase directly. The count and the insert are two statements, so two
// requests in the same instant could both pass at the limit. For a box that
// spends nothing, one extra row is not worth a lock.

const UNAVAILABLE = "Hugh couldn't save your request right now. Nothing was saved — try again.";

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const body    = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const checked = checkRequest(body.topic);
  if (!checked.ok) {
    return NextResponse.json({ error: REQUEST_REJECTION_MESSAGE[checked.rejection] }, { status: 400 });
  }

  const db = createServiceClient();

  // A count that didn't come back is not a count of zero (Rule 5).
  const { count, error: countError } = await db
    .from("topic_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", requestWindowStart(new Date()).toISOString());
  if (countError || count === null) {
    logSafeError("dashboard/topic-requests count", countError, [checked.text]);
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }
  if (!mayRequestAnother(count)) {
    return NextResponse.json({ error: REQUEST_REJECTION_MESSAGE.daily_limit }, { status: 429 });
  }

  const { error: insertError } = await db
    .from("topic_requests")
    .insert({ user_id: userId, requested_topic: checked.text });
  if (insertError) {
    logSafeError("dashboard/topic-requests insert", insertError, [checked.text]);
    return NextResponse.json({ error: UNAVAILABLE }, { status: 503 });
  }

  return NextResponse.json({ saved: true }, { status: 201 });
}
