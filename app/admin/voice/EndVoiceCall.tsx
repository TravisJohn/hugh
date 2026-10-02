"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function EndVoiceCall({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function end() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/voice/${sessionId}`, { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Could not end this call.");
      } else router.refresh();
    } catch { setError("Could not reach the server."); }
    finally { setBusy(false); }
  }
  return <div>
    <button onClick={end} disabled={busy} className="rounded-lg bg-red-500/15 px-3 py-1 text-xs text-red-300 hover:bg-red-500/25 disabled:opacity-50">
      {busy ? "Ending..." : "End call"}
    </button>
    {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
  </div>;
}
