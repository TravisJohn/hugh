import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import { hasSurface } from "@/lib/auth/requireProvisioned";
import ErrorScreen from "@/components/ui/ErrorScreen";
import NotesWorkspace from "@/components/notes/NotesWorkspace";
import RecordActivity from "@/components/monitor/RecordActivity";

// The Notes workspace — capture a test screenshot + your reasoning, then let
// Hugh (the Coach) read both and correct your thinking. Auth-gated like the rest
// of the post-login app; all per-user data is fetched client-side by useNotes
// through the /api/notes/* routes.
//
// Privacy pass (migration 050): this surface accepts arbitrary uploaded images
// and sends every one to Claude's vision model to be read, which makes it the
// least bounded personal-data path in the product. It is off by default. The
// database enforces that in RLS and the /api/notes/* routes enforce it again
// (they use the service-role client, which bypasses RLS); this check only
// decides whether it is worth drawing the workspace at all.
export default async function NotesPage() {
  const supabase = await createClient();
  const { user } = await verifyUserAccess(supabase);

  if (!await hasSurface(user.id, "notes")) {
    // Not an error and not a 404 — the page exists and nothing broke, so this
    // offers no retry (rule 5: the exit has to match what actually happened).
    return (
      <ErrorScreen
        title="Not available yet"
        message="Notes is not switched on for your account. It is where you upload a screenshot and have Hugh read it back to you, and we are opening it up gradually."
        homeHref="/home"
        homeLabel="Back to your activities"
      />
    );
  }

  return (

    <>

      {/* Records that this surface was used today. Renders nothing. */}

      <RecordActivity feature="notes" />

      <NotesWorkspace />

    </>

  );
}
