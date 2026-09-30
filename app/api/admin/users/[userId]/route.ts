import { type NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdminApi } from "@/lib/auth/requireAdmin";
import { deleteAccount } from "@/lib/account/deleteAccount";
import { logSafeError } from "@/lib/observability/log";

type Action = "approve" | "block" | "unblock" | "set_pro" | "set_free" | "reset_usage";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const gate = await requireAdminApi();
  if (gate instanceof NextResponse) return gate;

  const { userId } = await params;
  const body = (await request.json()) as { action: Action };
  const { action } = body;

  const service = createServiceClient();

  const updates: Record<string, unknown> = {};

  switch (action) {
    case "approve":      updates.approved   = true;              break;
    case "block":        updates.is_blocked = true;              break;
    case "unblock":      updates.is_blocked = false;
                         updates.approved   = true;              break;
    case "set_pro":      updates.plan       = "pro";             break;
    case "set_free":     updates.plan       = "free";            break;
    case "reset_usage":  updates.usage_reset_at = new Date().toISOString(); break;
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const { error } = await service
    .from("profiles")
    .update(updates)
    .eq("user_id", userId);

  if (error) {
    console.error("[admin/users] Update failed:", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;

/**
 * Admin-actioned deletion, for a learner who asks or who has lost access to
 * their own account. Same routine as the self-serve path
 * (`app/api/account`) — two implementations of "delete everything" is how one
 * of them quietly stops covering a bucket.
 *
 * Both admin actions use the shared active-admin gate.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const gate = await requireAdminApi();
  if (gate instanceof NextResponse) return gate;

  const { userId } = await params;

  // An admin deleting their own account through the admin console would take
  // the console with it. Self-deletion is a deliberate act and belongs on the
  // self-serve path, where the confirmation is typed.
  if (userId === gate.userId) {
    return NextResponse.json(
      { error: "You cannot delete your own account from here — use your account settings." },
      { status: 400 },
    );
  }

  const service = createServiceClient();
  const { data: target } = await service
    .from("profiles").select("is_admin").eq("user_id", userId).single();

  // Admins are not deletable through the console: it is the one action that
  // cannot be undone by another admin afterwards.
  if (target?.is_admin) {
    return NextResponse.json({ error: "Admin accounts cannot be deleted here." }, { status: 400 });
  }

  try {
    const receipt = await deleteAccount(service, userId);
    return NextResponse.json({ ok: true, ...receipt });
  } catch (err) {
    logSafeError("admin account deletion", err, []);
    return NextResponse.json(
      {
        error:
          "That account was not deleted. Some of its uploaded files may already " +
          "have been removed — run it again to finish.",
      },
      { status: 500 },
    );
  }
}
