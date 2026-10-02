import Link from "next/link";
import {
  ArrowLeft, ArrowRight, Layers, Users, Activity, Boxes,
  CheckCircle2, AlertTriangle, ExternalLink,
} from "lucide-react";
import { requireAdminPage } from "@/lib/auth/requireAdmin";
import { createServiceClient } from "@/lib/supabase/service";
import { estimateCost } from "@/lib/usage";
import { MODEL_RATES } from "@/lib/pricing";
import {
  buildHealthReport, formatUsd,
  type UsageRow, type OperationRow,
} from "@/lib/registry/health";

// ── Admin console ───────────────────────────────────────────────────────────
//
// The operator's landing page. It answers one question first — does anything
// need me? — and only then reports spend.
//
// It used to lead with a table of every user account, which before launch is
// the least informative thing on the page and crowded out everything else.
// That table now lives at /admin/users, unchanged. Detail lives one click
// away in each case; this page is a summary that must fit one screen.
//
// Spend is broken down BY FEATURE here, which the old page could not do at
// all: usage_logs.feature is route-level, and only lib/registry/features.ts
// knows which routes make up Notes.

export const dynamic = "force-dynamic";

const ATTENTION_WINDOW_DAYS = 7;
const ROW_CAP = 5000;

function startOfMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function fmt(n: number) {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
       : n >= 1_000     ? `${(n / 1_000).toFixed(1)}k`
       : String(n);
}

export default async function AdminPage() {
  await requireAdminPage();

  const service    = createServiceClient();
  const monthStart = startOfMonth();
  // Server Component with force-dynamic: renders once per request, so "now" is
  // a request timestamp rather than a value that shifts between re-renders.
  // eslint-disable-next-line react-hooks/purity
  const windowStart = new Date(Date.now() - ATTENTION_WINDOW_DAYS * 86_400_000).toISOString();

  const [usageRes, opsRes, profilesRes] = await Promise.all([
    service.from("usage_logs")
      .select("feature, tokens_in, tokens_out, tts_chars, model")
      .gte("created_at", monthStart)
      .limit(ROW_CAP),
    service.from("operation_events")
      .select("operation, outcome")
      .gte("created_at", windowStart)
      .limit(ROW_CAP),
    service.from("profiles").select("user_id, approved, is_blocked, is_admin"),
  ]);

  // Each read is tracked separately: a dropped query must never render as a
  // clean bill of health (CLAUDE.md rule 5).
  const failed = {
    spend:    usageRes.error    !== null,
    outcomes: opsRes.error      !== null,
    accounts: profilesRes.error !== null,
  };

  const usage = (usageRes.data ?? []) as UsageRow[];
  const ops   = (opsRes.data   ?? []) as OperationRow[];
  const report = buildHealthReport(usage, [], ops);

  // Provider split, priced per row at that row's own model rate.
  const modelCost = new Map<string, number>();
  let tokensIn = 0, tokensOut = 0;
  for (const row of usage) {
    const cost = estimateCost(row.tokens_in, row.tokens_out, row.tts_chars, row.model);
    tokensIn  += row.tokens_in  ?? 0;
    tokensOut += row.tokens_out ?? 0;
    const key = row.model ?? (row.tts_chars && !row.tokens_in ? "elevenlabs-tts" : "unattributed");
    modelCost.set(key, (modelCost.get(key) ?? 0) + cost);
  }
  let anthropicCost = 0, openaiCost = 0, ttsCost = 0;
  for (const [model, cost] of modelCost) {
    if (model === "elevenlabs-tts") ttsCost += cost;
    else if (model.startsWith("gpt")) openaiCost += cost;
    else anthropicCost += cost; // unpriced rows fall back to Claude rates
  }

  const profiles = profilesRes.data ?? [];
  const pending  = profiles.filter(
    p => !p.approved && !p.is_blocked && !p.is_admin,
  ).length;

  const failures     = report.rows.reduce((s, r) => s + r.failed, 0);
  const failingRows  = report.rows.filter(r => r.failed > 0)
    .sort((a, b) => b.failed - a.failed);
  const blindCount   = report.blind.length;

  // The spend ranking the old page could not produce.
  const topSpend = [...report.rows]
    .filter(r => r.spendUsd > 0)
    .sort((a, b) => b.spendUsd - a.spendUsd)
    .slice(0, 6);

  const needsAttention =
    pending > 0 || failures > 0 || blindCount > 0 ||
    report.unattributedSpendUsd > 0 || failed.spend || failed.outcomes || failed.accounts;

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-slate-100">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-8 py-4">
        <div className="flex items-center gap-4">
          <Link
            href="/home"
            className="flex items-center gap-1.5 text-sm text-slate-500 transition-colors hover:text-slate-300"
          >
            <ArrowLeft size={14} />
            Dashboard
          </Link>
          <span className="text-slate-700">|</span>
          <span className="font-serif text-lg font-semibold">Hugh Admin</span>
        </div>
        <span className="text-xs text-slate-600">
          {new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
        </span>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-8 py-8">

        {/* ── Does anything need me? ────────────────────────────────────── */}
        <section
          className={`rounded-2xl border p-6 ${
            needsAttention
              ? "border-amber-500/30 bg-amber-500/5"
              : "border-green-500/25 bg-green-500/5"
          }`}
        >
          <div className="flex items-start gap-4">
            {needsAttention
              ? <AlertTriangle size={22} className="mt-0.5 shrink-0 text-amber-400" />
              : <CheckCircle2  size={22} className="mt-0.5 shrink-0 text-green-400" />}

            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-slate-100">
                {needsAttention ? "Some things need you" : "Nothing needs you"}
              </p>

              {needsAttention ? (
                <ul className="mt-3 space-y-2 text-sm text-slate-400">
                  {pending > 0 && (
                    <li>
                      <Link href="/admin/users" className="text-amber-400 hover:underline">
                        {pending} {pending === 1 ? "account is" : "accounts are"} waiting for approval
                      </Link>
                      {" — they cannot reach any surface until approved."}
                    </li>
                  )}
                  {failures > 0 && (
                    <li>
                      <Link href="/admin/features" className="text-amber-400 hover:underline">
                        {failures} {failures === 1 ? "failure" : "failures"} in the last {ATTENTION_WINDOW_DAYS} days
                      </Link>
                      {" — "}
                      {failingRows.slice(0, 3).map(r => `${r.feature.label} (${r.failed})`).join(", ")}
                      {failingRows.length > 3 && `, and ${failingRows.length - 3} more`}.
                    </li>
                  )}
                  {blindCount > 0 && (
                    <li>
                      <Link href="/admin/features" className="text-amber-400 hover:underline">
                        {blindCount} {blindCount === 1 ? "surface spends" : "surfaces spend"} money without reporting an outcome
                      </Link>
                      {" — until fixed, this page cannot tell you they are healthy."}
                    </li>
                  )}
                  {report.unattributedSpendUsd > 0 && (
                    <li>
                      {formatUsd(report.unattributedSpendUsd)} of spend belongs to no feature
                      {" — "}
                      <span className="font-mono text-xs text-slate-500">
                        {report.unattributedFeatures.join(", ")}
                      </span>.
                    </li>
                  )}
                  {(failed.spend || failed.outcomes || failed.accounts) && (
                    <li className="text-red-400">
                      {[failed.spend && "spend", failed.outcomes && "outcomes", failed.accounts && "accounts"]
                        .filter(Boolean).join(", ")} could not be loaded. Figures below are
                      incomplete — this is a broken read, not an empty result.
                    </li>
                  )}
                </ul>
              ) : (
                <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-400">
                  No accounts waiting, no failures in the last {ATTENTION_WINDOW_DAYS} days, and every
                  money-spending surface is reporting an outcome. This is a positive
                  statement, not an absence of data.
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ── Spend ─────────────────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-5">

          <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5 lg:col-span-3">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-semibold text-slate-300">Spend by feature</p>
              <p className="text-xs text-slate-600">this month</p>
            </div>

            {failed.spend ? (
              <p className="mt-4 text-sm text-slate-600">Could not be loaded.</p>
            ) : topSpend.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">Nothing spent yet this month.</p>
            ) : (
              <div className="mt-4 space-y-2.5">
                {topSpend.map(r => (
                  <div key={r.feature.id} className="flex items-center gap-3">
                    <span className="w-32 shrink-0 truncate text-xs text-slate-400">
                      {r.feature.label}
                    </span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-sky-400"
                        style={{ width: `${(r.spendUsd / topSpend[0].spendUsd) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-slate-400">
                      {formatUsd(r.spendUsd)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-slate-800 pt-3 text-xs">
              <span className="text-slate-500">
                Total{" "}
                <span className="font-semibold tabular-nums text-slate-300">
                  {failed.spend ? "—" : formatUsd(report.totalSpendUsd)}
                </span>
              </span>
              <span className="text-slate-500">
                Claude <span className="tabular-nums text-slate-400">{formatUsd(anthropicCost)}</span>
              </span>
              {openaiCost > 0 && (
                <span className="text-slate-500">
                  OpenAI <span className="tabular-nums text-slate-400">{formatUsd(openaiCost)}</span>
                </span>
              )}
              {ttsCost > 0 && (
                <span className="text-slate-500">
                  Legacy voice <span className="tabular-nums text-slate-400">{formatUsd(ttsCost)}</span>
                </span>
              )}
            </div>
          </div>

          {/* Providers */}
          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-300">Anthropic</p>
                <Link
                  href="https://console.anthropic.com/settings/billing"
                  target="_blank"
                  className="flex items-center gap-1 text-xs text-slate-600 transition-colors hover:text-slate-400"
                >
                  Console <ExternalLink size={11} />
                </Link>
              </div>
              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Tokens in</span>
                  <span className="tabular-nums text-slate-400">{failed.spend ? "—" : fmt(tokensIn)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Tokens out</span>
                  <span className="tabular-nums text-slate-400">{failed.spend ? "—" : fmt(tokensOut)}</span>
                </div>
              </div>
              {modelCost.size > 0 && (
                <div className="mt-3 space-y-1 border-t border-slate-800 pt-2">
                  {[...modelCost.entries()].sort((a, b) => b[1] - a[1]).map(([model, cost]) => (
                    <div key={model} className="flex items-center justify-between text-xs">
                      <span className="truncate text-slate-600">
                        {model}
                        {model in MODEL_RATES && (
                          <span className="ml-1 text-slate-700">
                            (${MODEL_RATES[model].input}/${MODEL_RATES[model].output})
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-slate-500">{formatUsd(cost)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-slate-700">
                No live usage API — Console has the billed figure.
              </p>
            </div>
          </div>
        </section>

        {/* ── Where to go next ──────────────────────────────────────────── */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <NavCard
            href="/admin/features"
            icon={<Layers size={18} className="text-sky-400" />}
            title="Features"
            note={`${report.instrumentedCount}/${report.spendingCount} spending surfaces reporting`}
          />
          <NavCard
            href="/admin/users"
            icon={<Users size={18} className="text-violet-400" />}
            title="Users"
            note={`${profiles.length} accounts${pending > 0 ? ` · ${pending} pending` : ""}`}
          />
          <NavCard
            href="/admin/observability"
            icon={<Activity size={18} className="text-green-400" />}
            title="Observability"
            note="Operation outcomes and silent failures"
          />
          <NavCard
            href="/admin/architecture"
            icon={<Boxes size={18} className="text-amber-400" />}
            title="Architecture"
            note="Repo map and the admin assistant"
          />
          <NavCard
            href="/admin/voice"
            icon={<Activity size={18} className="text-cyan-400" />}
            title="Live voice"
            note="Sessions, usage and call termination"
          />
        </section>

      </main>
    </div>
  );
}

function NavCard({ href, icon, title, note }: {
  href:  string;
  icon:  React.ReactNode;
  title: string;
  note:  string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-900/50 p-5 transition-colors hover:border-slate-700 hover:bg-slate-900"
    >
      <div className="flex items-center justify-between">
        {icon}
        <ArrowRight size={14} className="text-slate-700 transition-colors group-hover:text-slate-500" />
      </div>
      <p className="font-semibold text-slate-200">{title}</p>
      <p className="text-xs leading-relaxed text-slate-600">{note}</p>
    </Link>
  );
}
