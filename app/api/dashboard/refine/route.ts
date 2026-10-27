// Retired by narrow Learn phase 2 (PR D, 2026-10-27). Learners start from the
// course catalog now, so this route reads nothing and spends nothing: it
// answers 410 and records the call. Phase 3 deletes this file once a week in
// production passes with no call from real use (lib/learn/retiredRoute.ts).
import { type NextRequest } from "next/server";
import { retiredRouteResponse } from "@/lib/learn/retiredRoute";

export async function POST(request: NextRequest) {
  return retiredRouteResponse(request, "dashboard/refine");
}
