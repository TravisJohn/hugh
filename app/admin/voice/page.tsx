import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/requireAdmin";
import { createServiceClient } from "@/lib/supabase/service";
import EndVoiceCall from "./EndVoiceCall";

export const dynamic = "force-dynamic";

interface VoiceRow {
  id: string;
  user_id: string | null;
  state: string;
  started_at: string;
  deadline_at: string;
  ended_at: string | null;
  end_reason: string | null;
  reserved_usd: number;
  observed_usd: number;
  audio_in: number;
  audio_out: number;
  text_in: number;
  text_out: number;
  transcription_in: number;
  transcription_out: number;
}

export default async function AdminVoicePage() {
  await requireAdminPage();
  const db = createServiceClient();
  const { data, error } = await db.from("mastery_realtime_sessions")
    .select("id, user_id, state, started_at, deadline_at, ended_at, end_reason, reserved_usd, observed_usd, audio_in, audio_out, text_in, text_out, transcription_in, transcription_out")
    .order("started_at", { ascending: false }).limit(100);
  const rows = (data ?? []) as VoiceRow[];
  const active = rows.filter(row => row.state === "starting" || row.state === "active");
  return <main className="min-h-screen bg-[#0A0F1E] px-8 py-8 text-slate-100">
    <div className="mx-auto max-w-6xl">
      <Link href="/admin" className="text-sm text-slate-400 hover:text-white">Back to admin</Link>
      <h1 className="mt-5 font-serif text-3xl font-semibold">Live voice sessions</h1>
      <p className="mt-2 text-sm text-slate-400">Server observed usage and reserved allowance. Provider billing can differ from these estimates.</p>
      {error ? <p className="mt-6 text-red-400">Session records could not be loaded.</p> : <>
        <p className="mt-6 text-sm text-slate-300">{active.length} open calls in the most recent 100 sessions</p>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full min-w-[850px] text-left text-xs">
            <thead className="bg-slate-900 text-slate-400"><tr>
              <th className="p-3">Started</th><th className="p-3">User</th><th className="p-3">State</th>
              <th className="p-3">Deadline / end</th><th className="p-3">Usage tokens</th>
              <th className="p-3">Estimated / reserved</th><th className="p-3">Control</th>
            </tr></thead>
            <tbody>{rows.map(row => <tr key={row.id} className="border-t border-slate-800 text-slate-300">
              <td className="p-3">{new Date(row.started_at).toLocaleString()}</td>
              <td className="p-3 font-mono">{row.user_id?.slice(0, 8) ?? "Deleted account"}</td>
              <td className="p-3">{row.state}{row.end_reason ? ` · ${row.end_reason}` : ""}</td>
              <td className="p-3">{new Date(row.ended_at ?? row.deadline_at).toLocaleString()}</td>
              <td className="p-3">Audio {row.audio_in}/{row.audio_out}<br />Text {row.text_in}/{row.text_out}<br />Transcript {row.transcription_in}/{row.transcription_out}</td>
              <td className="p-3">${Number(row.observed_usd).toFixed(4)} / ${Number(row.reserved_usd).toFixed(2)}</td>
              <td className="p-3">{row.state === "active" ? <EndVoiceCall sessionId={row.id} /> : null}</td>
            </tr>)}</tbody>
          </table>
          {rows.length === 0 && <p className="p-5 text-sm text-slate-500">No Live voice sessions recorded.</p>}
        </div>
      </>}
    </div>
  </main>;
}
