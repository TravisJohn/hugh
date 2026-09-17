import Link from "next/link";
import { ArrowLeft, Layers, AlertTriangle, EyeOff } from "lucide-react";
import { requireAdminPage } from "@/lib/auth/requireAdmin";
import { createServiceClient } from "@/lib/supabase/service";
import { RETENTION_DAYS } from "@/lib/retention";
import {
  buildHealthReport,
  formatUsd,
  type UsageRow,
  type ActivityRow,
  type OperationRow,
  type FeatureHealth,
} from "@/lib/registry/health";

// ── Feature health ──────────────────────────────────────────────────────────
//
// One row per surface in Hugh, joining all three telemetry stores on
// lib/registry/features.ts. This is the only view in the app grouped by
// FEATURE: /admin groups by user and by model, and /admin/observability groups
// by operation. Neither can answer "how is Notes doing?".
//
// All arithmetic lives in lib/registry/health.ts (pure, tested); this file
// queries, handles read failure, and formats.

export const dynamic = "force-dynamic";

/**
 * Rows are pulled and aggregated in memory rather than in SQL — fine at Hugh's
 * volume, and it needs no view. The cap stops a runaway table being dragged
 * into a page render; if it is hit, the page says so rather than quietly
 * reporting a fraction of reality.
 */
const ROW_CAP = 5000;

const WINDOWS = [
  { days: 7,   label: "7 days"  },
  { days: 30,  label: "30 days" },
  { days: 0,   label: "All time" },
] as const;

interface Props {
  searchParams: Promise<{ days?: string }>;
}

export default async function FeaturesPage({ searchParams }: Props) {
  await requireAdminPage();

  const sp    = await searchParams;
  const days  = WINDOWS.some(w => String(w.days) === sp.days) ? Number(sp.days) : 7;
  const label = WINDOWS.find(w => w.days === days)!.label;
  // Health reads operation_events, which the retention job (migration 052)
  // clears after a fixed window. "All time" is true of spend and learners but
  // not of outcomes, so that column names the window it can actually see.
  const healthLabel = days === 0 ? `last ${RETENTION_DAYS.operationEvents} days` : label;

  const service = createServiceClient();

  // Server Component with force-dynamic: this renders once per request, so
  // "now" is a request timestamp, not a value that could shift between client
  // re-renders. The purity rule cannot tell the two apart.
  // eslint-disable-next-line react-hooks/purity
  const since = days === 0 ? null : new Date(Date.now() - days * 86_400_000);

  const usageQ = service
    .from("usage_logs")
    .select("feature, tokens_in, tokens_out, tts_chars, model")
    .limit(ROW_CAP);
  const activityQ = service
    .from("activity_events")
    .select("feature, user_id, event_date")
    .limit(ROW_CAP);
  const operationQ = service
    .from("operation_events")
    .select("operation, outcome")
    .limit(ROW_CAP);

  if (since) {
    usageQ.gte("created_at", since.toISOString());
    activityQ.gte("event_date", since.toISOString().slice(0, 10));
    operationQ.gte("created_at", since.toISOString());
  }

  const [usageRes, activityRes, operationRes] = await Promise.all([
    usageQ, activityQ, operationQ,
  ]);

  // A dropped query is not "you have nothing". Each store's failure is tracked
  // separately, and the columns it feeds render as unknown rather than as zero
  // — "we could not load it" and "there is none" are different sentences to the
  // person reading them (CLAUDE.md rule 5).
  const failed = {
    spend:    usageRes.error     !== null,
    activity: activityRes.error  !== null,
    outcomes: operationRes.error !== null,
  };
  const anyFailed = failed.spend || failed.activity || failed.outcomes;

  const report = buildHealthReport(
    (usageRes.data     ?? []) as UsageRow[],
    (activityRes.data  ?? []) as ActivityRow[],
    (operationRes.data ?? []) as OperationRow[],
  );

  const truncated =
    (usageRes.data?.length     ?? 0) >= ROW_CAP ||
    (activityRes.data?.length  ?? 0) >= ROW_CAP ||
    (operationRes.data?.length ?? 0) >= ROW_CAP;

  const pctInstrumented = report.spendingCount === 0
    ? 100
    : (report.instrumentedCount / report.spendingCount) * 100;

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-8 py-4">
        <div className="flex items-center gap-4">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            <ArrowLeft size={14} />
            Admin
          </Link>
          <span className="text-slate-700">|</span>
          <span className="font-serif text-lg font-semibold">Features</span>
          <span className="text-slate-700">|</span>
          <Link
            href="/admin/observability"
            className="text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            Observability
          </Link>
        </div>

        <nav className="flex items-center gap-1" aria-label="Time window">
          {WINDOWS.map(w => (
            <Link
              key={w.days}
              href={`/admin/features?days=${w.days}`}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                w.days === days
                  ? "bg-slate-800 text-slate-200"
                  : "text-slate-600 hover:text-slate-400"
              }`}
            >
              {w.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-7xl space-y-6 px-8 py-8">

        {/* ── Instrumentation progress ──────────────────────────────────
            The element that makes amber legible as a position on a checklist
            rather than as a fault. Without it, a page that is mostly "not
            instrumented" reads as a page reporting that Hugh is broken. */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <div className="flex items-center gap-3">
              <Layers size={18} className="shrink-0 text-sky-400" />
              <p className="text-base text-slate-200">
                <span className="font-semibold tabular-nums">
                  {report.instrumentedCount} of {report.spendingCount}
                </span>{" "}
                money-spending surfaces are instrumented
                {report.blind.length > 0 && (
                  <>
                    {" — "}
                    <span className="font-semibold tabular-nums text-amber-400">
                      {report.blind.length}
                    </span>{" "}
                    cannot report an outcome yet
                  </>
                )}
              </p>
            </div>
            <p className="text-xs text-slate-500">
              {report.blind.length > 0
                ? "Amber rows are outstanding work, not failures"
                : "Nothing outstanding"}
            </p>
          </div>

          <div className="mt-4 flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full bg-green-400" style={{ width: `${pctInstrumented}%` }} />
            <div className="h-full bg-amber-400" style={{ width: `${100 - pctInstrumented}%` }} />
          </div>

          {report.blind.length > 0 && (
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              {report.blind.map(f => f.label).join(", ")} spend money and record
              nothing about whether the spend worked. Until they do, this page
              cannot tell you they are healthy — only that it cannot see them.
            </p>
          )}
        </section>

        {/* ── Read failure ─────────────────────────────────────────────── */}
        {anyFailed && (
          <section className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-semibold text-slate-200">
                  Some data could not be loaded
                </p>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
                  {[
                    failed.spend    && "spend",
                    failed.activity && "engagement",
                    failed.outcomes && "outcomes",
                  ].filter(Boolean).join(", ")} failed to load. Those columns show
                  “—” rather than zero: this is a broken read, not an empty
                  result, and the difference matters. Reload to try again.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ── Spend belonging to no feature ────────────────────────────── */}
        {report.unattributedSpendUsd > 0 && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5">
            <div className="flex items-start gap-3">
              <EyeOff size={18} className="mt-0.5 shrink-0 text-amber-400" />
              <div>
                <p className="text-sm font-semibold text-slate-200">
                  {formatUsd(report.unattributedSpendUsd)} of spend belongs to no feature
                </p>
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
                  Written under{" "}
                  <span className="font-mono text-xs text-slate-300">
                    {report.unattributedFeatures.join(", ")}
                  </span>
                  , which no registry entry claims — usually a historic row from
                  deleted code. It is counted in the total rather than dropped,
                  because money that belongs to nothing must be visible as
                  exactly that.
                </p>
              </div>
            </div>
          </section>
        )}

        {/* ── The table ─────────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/30">
          <div className="flex items-baseline justify-between border-b border-slate-800 px-6 py-4">
            <p className="font-semibold text-slate-200">All surfaces</p>
            <p className="text-xs text-slate-600">
              {label} · total {failed.spend ? "—" : formatUsd(report.totalSpendUsd)}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/60 text-xs uppercase tracking-wider text-slate-600">
                  <th className="px-6 py-3 text-left font-medium">Feature</th>
                  <th className="px-4 py-3 text-left font-medium">Kind</th>
                  <th className="px-4 py-3 text-left font-medium">Health · {healthLabel}</th>
                  <th className="px-4 py-3 text-right font-medium">Spend</th>
                  <th className="px-4 py-3 text-right font-medium">Learners</th>
                  <th className="px-6 py-3 text-right font-medium">Tests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {report.rows.map(row => (
                  <FeatureRow key={row.feature.id} row={row} failed={failed} />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <p className="max-w-3xl border-l-2 border-slate-800 pl-4 text-xs leading-relaxed text-slate-600">
          Every column is grouped by feature, which is possible only because{" "}
          <span className="font-mono text-slate-500">lib/registry/features.ts</span>{" "}
          maps the three stores onto one another: spend is route-level, engagement
          is surface-level, outcomes are operation-level.
          {truncated && ` Row cap of ${ROW_CAP} was reached — figures are a lower bound.`}
        </p>

      </main>
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function FeatureRow({
  row,
  failed,
}: {
  row:    FeatureHealth;
  failed: { spend: boolean; activity: boolean; outcomes: boolean };
}) {
  const f = row.feature;
  // Internal surfaces nobody has touched are dimmed rather than hidden: an
  // operator console should show the whole system, including its quiet parts.
  const quiet = row.instrumentation === "no-spend" && row.learners === 0;

  return (
    <tr className={`transition-colors hover:bg-slate-800/20 ${quiet ? "opacity-60" : ""}`}>
      <td className="px-6 py-4">
        <p className="font-semibold text-slate-200">{f.label}</p>
        <p className="text-xs text-slate-600">{f.blurb}</p>
      </td>

      <td className="px-4 py-4">
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-slate-600">
          {f.kind}
        </span>
      </td>

      <td className="px-4 py-4">
        <HealthCell row={row} failed={failed.outcomes} />
      </td>

      <td className="px-4 py-4 text-right font-mono text-xs tabular-nums">
        {failed.spend
          ? <span className="text-slate-600">—</span>
          : f.spendsTokens
            ? <span className="text-slate-300">{formatUsd(row.spendUsd)}</span>
            : <span className="text-slate-700">—</span>}
      </td>

      <td className="px-4 py-4 text-right font-mono text-xs tabular-nums text-slate-500">
        {failed.activity
          ? "—"
          : row.learners === 0
            ? "—"
            : `${row.learners} · ${row.activeDays}d`}
      </td>

      <td className="px-6 py-4 text-right font-mono text-xs tabular-nums">
        <span className={f.tests === 0 ? "text-amber-400" : "text-slate-400"}>
          {f.tests}
        </span>
      </td>
    </tr>
  );
}

function HealthCell({ row, failed }: { row: FeatureHealth; failed: boolean }) {
  if (failed) {
    return <span className="text-xs text-slate-600">Could not load</span>;
  }

  if (row.instrumentation === "no-spend") {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-700" />
        <span className="rounded-full border border-slate-800 bg-slate-800/40 px-2.5 py-0.5 text-xs text-slate-500">
          No AI spend
        </span>
      </span>
    );
  }

  if (row.instrumentation === "blind") {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-400">
          Not instrumented
        </span>
      </span>
    );
  }

  if (row.attempts === 0) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-700" />
        <span className="text-xs text-slate-600">No attempts in window</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400" />
      <span className="font-mono text-xs tabular-nums text-slate-400">
        {row.ok} ok
        <span className="px-1 text-slate-700">·</span>
        <span className={row.failed > 0 ? "text-red-400" : ""}>{row.failed} failed</span>
        <span className="px-1 text-slate-700">·</span>
        {/* 'refused' is the system working correctly — a usage gate, an
            off-domain topic. Coloured apart from failures so a healthy
            product does not read as a broken one. */}
        <span className="text-violet-400">{row.refused} refused</span>
      </span>
    </span>
  );
}
