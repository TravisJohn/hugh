import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isActiveAccount } from "@/lib/auth/accountAccess";

/**
 * Shared admin gate for both pages and API routes. One source of truth for
 * "is the current request an authenticated admin?" — mirrors the original
 * inline check in app/admin/page.tsx (auth user → profiles.is_admin).
 */

type AdminStatus =
  | { status: "ok"; userId: string }
  | { status: "unauthenticated"; userId: null }
  | { status: "forbidden"; userId: string };

async function getAdminStatus(): Promise<AdminStatus> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { status: "unauthenticated", userId: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select("is_admin, approved, is_blocked")
    .eq("user_id", user.id)
    .single();

  if (!profile?.is_admin || !isActiveAccount(profile)) return { status: "forbidden", userId: user.id };
  return { status: "ok", userId: user.id };
}

/**
 * For server components / pages. Redirects non-admins (to /login or /home) and
 * returns the admin's user id. Never returns for a non-admin.
 */
export async function requireAdminPage(): Promise<string> {
  const result = await getAdminStatus();
  if (result.status === "unauthenticated") redirect("/login");
  if (result.status === "forbidden") redirect("/home");
  return result.userId;
}

/**
 * For route handlers. Returns either `{ userId }` or a NextResponse the caller
 * should return directly:
 *
 *   const gate = await requireAdminApi();
 *   if (gate instanceof NextResponse) return gate;
 *   // ...use gate.userId
 */
export async function requireAdminApi(): Promise<{ userId: string } | NextResponse> {
  const result = await getAdminStatus();
  if (result.status === "unauthenticated") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (result.status === "forbidden") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return { userId: result.userId };
}
