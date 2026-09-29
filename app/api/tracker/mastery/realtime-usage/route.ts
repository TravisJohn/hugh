import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUserId } from "@/lib/supabase/auth-helper";
import { logUsage } from "@/lib/usage";
import { recordOperation } from "@/lib/observability/record";
import { MAX_SESSION_SECONDS } from "@/lib/mastery/realtimeConfig";
import {
  emptyTotals,
  boundTotals,
  toUsageRows,
  isEmpty,
  type RealtimeUsageTotals,
} from "@/lib/mastery/realtimeUsage";

export const dynamic = "force-dynamic";

// Records the browser's unverified report of Realtime spend (audit S3).
//
// The sibling route `realtime-session` mints an ephemeral credential and the
// call then runs browser-to-OpenAI over WebRTC, so the server never observes
// the spend. This endpoint is where it comes back. Without it, the gate at mint
// time RESERVES budget (migration 049) and nothing ever confirms the
// reservation — it expires, the learner's budget springs back, and the provider
// bill still arrives.
//
// Deliberately NOT gated on `MASTERY_REALTIME_ENABLED`. If the flag is turned
// off while a session is in flight, that session's tokens were still spent, and
// refusing the report would throw away the only record of them. The gate
// belongs on starting a session, not on paying for one that already ran.
//
// The figures are supplied by the browser, so they are BOUNDED, not trusted —
// see `boundTotals`. Clamping cannot detect missing or understated spend.
// Keep accepting reports from pre-restriction sessions and administrator
// previews; this route does not issue credentials or establish accurate billing.

/** The usage half of the request body, before it is trusted. */
interface UsageBody {
  milestoneId?: unknown;
  usage?:       Partial<Record<keyof RealtimeUsageTotals, unknown>>;
}

/** Read one field from an untrusted body. `boundTotals` does the real policing. */
function field(usage: UsageBody["usage"], key: keyof RealtimeUsageTotals): number {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: UsageBody;
  try {
    body = (await request.json()) as UsageBody;
  } catch {
    // `sendBeacon` fires during teardown and can deliver a truncated payload.
    return NextResponse.json({ error: "Malformed usage report" }, { status: 400 });
  }

  const milestoneId = typeof body.milestoneId === "string" ? body.milestoneId : null;
  if (!milestoneId) {
    return NextResponse.json({ error: "milestoneId is required" }, { status: 400 });
  }

  // Ownership, on the same join the mint route uses. A learner may only report
  // spend against a card that is theirs, or this becomes a way to burn someone
  // else's budget.
  const supabase = await createClient();
  const { data: milestone } = await supabase
    .from("milestones")
    .select("id, tracks!track_id!inner(user_id)")
    .eq("id", milestoneId)
    .single();

  if (!milestone) {
    return NextResponse.json({ error: "Milestone not found" }, { status: 404 });
  }

  const reported: RealtimeUsageTotals = {
    ...emptyTotals(),
    audioIn:          field(body.usage, "audioIn"),
    audioOut:         field(body.usage, "audioOut"),
    textIn:           field(body.usage, "textIn"),
    textOut:          field(body.usage, "textOut"),
    transcriptionIn:  field(body.usage, "transcriptionIn"),
    transcriptionOut: field(body.usage, "transcriptionOut"),
  };

  // The ceiling comes from the server's own config, never from the request.
  const { bounded, clamped } = boundTotals(reported, MAX_SESSION_SECONDS);

  if (clamped) {
    // Either a bug in the accumulator or a tampered client. Both are worth
    // seeing; neither should fail the request, because the clamped figure is
    // still the best record available.
    console.warn(
      `[mastery/realtime-usage] clamped an impossible report for ${userId} on ${milestoneId}`,
    );
  }

  if (isEmpty(bounded)) {
    // A session that connected and reported nothing is not the same as a
    // session that cost nothing. This is the silent failure the operation's
    // `failureIsSilent` flag names: the learner saw a working session, and the
    // spend left no trace. Record it as a failure so /admin/features can count
    // how often it happens.
    console.warn(
      `[mastery/realtime-usage] empty usage report for ${userId} on ${milestoneId}`,
    );
    void recordOperation({
      userId, operation: "mastery.realtime", outcome: "failed",
      detail: { stage: "empty-report" },
    });
    return NextResponse.json({ recorded: 0 });
  }

  // One row per rate class, each at its own model's rate — realtime audio and
  // realtime text differ by 16x, so a single blended row would misstate the
  // cost badly. `logUsage` defers each write past the response and never throws.
  const rows = toUsageRows(bounded);
  for (const row of rows) {
    await logUsage({
      userId,
      feature:   "mastery/realtime",   // same key the mint route gates on
      model:     row.model,
      tokensIn:  row.tokensIn,
      tokensOut: row.tokensOut,
    });
  }

  // Every dollar leaves evidence of whether it worked. `clamped` rides along
  // because a clamped report is the one case where the recorded figure is
  // deliberately not the reported one.
  void recordOperation({
    userId, operation: "mastery.realtime", outcome: "ok",
    detail: { rows: rows.length, clamped },
  });

  return NextResponse.json({ recorded: rows.length });
}
