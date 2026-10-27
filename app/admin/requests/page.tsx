import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { requireAdminPage } from "@/lib/auth/requireAdmin";
import { createServiceClient } from "@/lib/supabase/service";

// ── Topic requests ──────────────────────────────────────────────────────────
//
// What learners asked the catalog to add (migration 061, PRD row 6), newest
// first. It is demand data for choosing the next packs, read with the service
// role because learners hold no privilege on the table. Only the newest rows
// are shown, so the page fits one screen; the total says how many exist.

export const dynamic = "force-dynamic";

const SHOWN = 25;

interface RequestRow {
  id:              string;
  user_id:         string;
  requested_topic: string;
  created_at:      string;
}

export default async function AdminRequestsPage() {
  await requireAdminPage();

  const { data, count, error } = await createServiceClient()
    .from("topic_requests")
    .select("id, user_id, requested_topic, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(SHOWN);
  const rows = (data ?? []) as RequestRow[];

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-slate-100">
      <header className="flex items-center gap-4 border-b border-slate-800 px-8 py-4">
        <Link
          href="/admin"
          className="flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-300"
        >
          <ArrowLeft size={14} />
          Admin
        </Link>
        <span className="text-slate-700">|</span>
        <span className="font-serif text-lg font-semibold">Topic requests</span>
      </header>

      <main className="mx-auto max-w-4xl px-8 py-8">
        {error ? (
          // A failed read is not an empty list (Rule 5).
          <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-400" />
            <p className="text-sm text-slate-300">
              Hugh couldn&apos;t load the requests. Reload to try again; nothing has been lost.
            </p>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">No learner has asked for a subject yet.</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-400">
              {count ?? rows.length} {count === 1 ? "request" : "requests"} in all
              {(count ?? 0) > SHOWN && `; the newest ${SHOWN} are shown`}.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
                  <th className="py-2 pr-4 font-medium">Subject</th>
                  <th className="py-2 pr-4 font-medium">Learner</th>
                  <th className="py-2 font-medium">Asked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-slate-800/60">
                    <td className="py-1.5 pr-4 text-slate-100">{r.requested_topic}</td>
                    {/* Enough of the id to see one learner asking twice, without naming them. */}
                    <td className="py-1.5 pr-4 font-mono text-xs text-slate-500">{r.user_id.slice(0, 8)}</td>
                    <td className="py-1.5 text-xs text-slate-400">{r.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  );
}
