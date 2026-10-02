import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/requireAdmin";
import { createServiceClient } from "@/lib/supabase/service";
import { endCall } from "@/lib/mastery/liveVoiceControl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await requireAdminApi();
  if (gate instanceof NextResponse) return gate;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  const db = createServiceClient();
  const { data, error } = await db.from("mastery_realtime_sessions")
    .select("id, provider_call_id, state").eq("id", id).single();
  if (error || !data) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (data.state === "ended" || data.state === "failed") return NextResponse.json({ ended: true });
  if (!data.provider_call_id) return NextResponse.json({ error: "Call is starting" }, { status: 409 });
  if (!(await endCall(id, data.provider_call_id, "admin_ended"))) {
    return NextResponse.json({ error: "Termination pending recovery" }, { status: 503 });
  }
  return NextResponse.json({ ended: true });
}
