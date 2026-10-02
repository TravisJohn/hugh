import { type NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { createServiceClient } from "@/lib/supabase/service";
import { endCall } from "@/lib/mastery/liveVoiceControl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const REASONS = new Set(["user_ended", "max_duration", "max_followups", "inactivity", "coach_concluded", "disconnected"]);

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { sessionId?: unknown; reason?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "Malformed request" }, { status: 400 }); }
  if (typeof body.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.sessionId)) {
    return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  }
  const db = createServiceClient();
  const { data, error } = await db.from("mastery_realtime_sessions")
    .select("id, provider_call_id, state").eq("id", body.sessionId).eq("user_id", userId).single();
  if (error || !data) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (data.state === "ended" || data.state === "failed") return NextResponse.json({ ended: true });
  if (!data.provider_call_id) return NextResponse.json({ error: "Session is starting" }, { status: 409 });
  const reason = typeof body.reason === "string" && REASONS.has(body.reason) ? body.reason : "user_ended";
  if (!(await endCall(data.id, data.provider_call_id, reason))) {
    return NextResponse.json({ error: "Termination pending retry" }, { status: 503 });
  }
  return NextResponse.json({ ended: true });
}
