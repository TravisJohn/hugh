import { type NextRequest } from "next/server";
import { createClient } from "./server";
import { isActiveAccount } from "@/lib/auth/accountAccess";
import { logSafeError } from "@/lib/observability/log";

/**
 * Returns the authenticated active user's ID. A still-valid session for a
 * blocked or unapproved account cannot reach service-role API routes.
 *
 * Dev bypass: in non-production environments, passing
 *   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 * is accepted so API routes can be tested without a browser session.
 * This branch is compiled away in production builds.
 */
export async function getAuthenticatedUserId(
  request: NextRequest
): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("approved, is_blocked")
      .eq("user_id", user.id)
      .single();
    if (error) {
      logSafeError("account access read", error, []);
      return null;
    }
    return isActiveAccount(profile) ? user.id : null;
  }

  if (process.env.NODE_ENV !== "production") {
    const authHeader = request.headers.get("Authorization");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceKey && authHeader === `Bearer ${serviceKey}`) {
      return "dev-test-bypass";
    }
  }

  return null;
}
