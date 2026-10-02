import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { endCall } from "@/lib/mastery/liveVoiceControl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await db.from("mastery_realtime_sessions")
    .select("id, provider_call_id, state").in("state", ["starting", "active"])
    .lte("deadline_at", now).order("deadline_at").limit(50);
  if (error) return NextResponse.json({ error: "Recovery inventory unavailable" }, { status: 503 });
  let ended = 0;
  let failed = 0;
  for (const session of data ?? []) {
    if (session.provider_call_id) {
      if (await endCall(session.id, session.provider_call_id, "deadline_recovery")) ended += 1;
      else failed += 1;
    } else {
      const result = await db.from("mastery_realtime_sessions")
        .update({ state: "failed", end_reason: "startup_timeout", ended_at: now })
        .eq("id", session.id).eq("state", "starting");
      if (result.error) failed += 1;
      else ended += 1;
    }
  }
  return NextResponse.json({ checked: data?.length ?? 0, ended, failed }, { status: failed ? 503 : 200 });
}
