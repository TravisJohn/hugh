import Image from "next/image";
import Link from "next/link";
import { GraduationCap, Code2, Trophy, Cloud, NotebookPen, Activity, Headphones, Newspaper, PieChart, Briefcase } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { verifyUserAccess } from "@/lib/supabase/verify-access";
import { readProvisioning } from "@/lib/auth/requireProvisioned";
import { isProvisioned } from "@/lib/auth/provisioning";
import SignOutButton from "@/components/landing/SignOutButton";
import HeaderUsage from "@/components/usage/HeaderUsage";

// Top-level activity picker — the post-login landing for every user. Picking
// "Learn" leads to the "What do you want to learn?" dashboard (/home/learn);
// "Code" opens the coding-drill landing (/code/start); "Cases" opens The Case
// Room (/cases); "Cloud Skills" opens the cloud-services reference (/cloud);
// "Notes" opens the wrong-answer review workspace (/notes); "Monitor" opens the
// hand-kept tracking surface (/monitor). Four further surfaces are announced
// but not built — see COMING_SOON below.

// Announced, not built. These are deliberately not Links and carry no href: a
// card that navigates nowhere teaches a learner to distrust the whole grid.
// They render as a compact strip rather than four more grid cards because
// /home is h-screen with no scroll (Architecture Rule 4) and the six live
// cards already need clamp() spacing to survive a laptop viewport. When one
// ships, move it up into the grid as a full card and delete its entry here.
const COMING_SOON = [
  { name: "Listen",    Icon: Headphones, blurb: "High-level topics, read aloud — learn while your hands are busy." },
  { name: "Updates",   Icon: Newspaper,  blurb: "What is moving right now across AI and data analytics." },
  { name: "Visualize", Icon: PieChart,   blurb: "Practise turning a dataset into a chart that makes the point." },
  { name: "Manage",    Icon: Briefcase,  blurb: "Take the manager's seat on a problem and make the calls." },
] as const;

export default async function HomePage() {
  const supabase = await createClient();
  const { user } = await verifyUserAccess(supabase);

  const firstName = (user.email ?? "").split("@")[0] ?? "there";

  // Privacy pass (migration 050). Both flags are read in one round-trip: the
  // grid should not advertise a surface the account cannot use. Monitor still
  // appears when documents are off — Skills and Your Usage remain available —
  // so only its subheading changes, not its presence.
  const provisioning     = await readProvisioning(user.id);
  const notesEnabled     = isProvisioned(provisioning, "notes");
  const monitorDocsOn    = isProvisioned(provisioning, "monitorDocs");
  const initial   = firstName[0]?.toUpperCase() ?? "?";

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-[#0A0F1E] sm:h-screen">

      {/* ── Breathing background orbs ────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-breathe absolute top-0 left-0 h-[600px] w-[600px] -translate-x-1/3 -translate-y-1/3 rounded-full bg-sky-500/20 blur-3xl" />
        <div className="animate-breathe-delayed absolute bottom-0 right-0 h-[700px] w-[700px] translate-x-1/3 translate-y-1/3 rounded-full bg-violet-500/15 blur-3xl" />
        <div className="animate-breathe-slow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[400px] rounded-full bg-sky-400/10 blur-3xl" />
      </div>

      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="relative flex shrink-0 items-center justify-between border-b border-slate-800 px-3 py-2 sm:px-8 sm:py-3">
        <span className="font-serif text-lg font-semibold text-white">Hugh.</span>

        <div className="flex items-center gap-2 text-sm sm:gap-4">
          <HeaderUsage />
          <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-slate-300 sm:flex">
            {initial}
          </div>
          <span className="hidden sm:block text-slate-500">{user.email}</span>
          <span className="hidden sm:block text-slate-700">|</span>
          {/* The only route to account deletion. A learner who cannot find it
              cannot exercise it, which would make the privacy policy that
              describes it untrue. */}
          <Link href="/account" className="text-slate-400 transition-colors hover:text-white">
            Account
          </Link>
          <span className="hidden sm:block text-slate-700">|</span>
          <SignOutButton />
        </div>
      </header>

      {/* ── Content ─────────────────────────────────────────────────── */}
      {/* Vertical rhythm scales with viewport height via clamp() rather than a
          fixed gap-8: on a single-screen laptop (~650-700px tall) fixed gaps
          plus the four-card grid and Notes bar don't fit, and overflow-hidden
          was silently clipping the Notes bar off the bottom. clamp() keeps the
          generous spacing on tall/dual-monitor screens while compressing
          smoothly — no breakpoint jump — as height shrinks. */}
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-start gap-2 overflow-hidden px-3 pt-8 sm:justify-center sm:gap-[clamp(0.5rem,3vh,2rem)] sm:px-6 sm:pt-0">

        {/* Logo */}
        <div className="relative hidden shrink-0 sm:block">
          <div className="absolute inset-0 rounded-full bg-sky-400/15 blur-2xl scale-150" />
          <Image
            src="/hugh-logo.png.png"
            alt="Hugh"
            width={88}
            height={88}
            className="relative h-[clamp(36px,9vh,88px)] w-[clamp(36px,9vh,88px)] object-contain drop-shadow-2xl"
            priority
          />
        </div>

        {/* Greeting */}
        <div className="shrink-0 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-600 mb-1">
            Welcome back, {firstName}
          </p>
          <h1 className="text-[clamp(1.125rem,2.8vh,1.5rem)] font-bold tracking-tight text-slate-100">
            What would you like to do?
          </h1>
        </div>

        {/* ── Six activities, 2 rows × 3 cols: Learn · Code · Cases ──
            Cloud Skills · Notes · Monitor ─────────────────────────── */}
        <div className="grid w-full max-w-4xl shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-[clamp(0.5rem,2vh,1rem)]">

          {/* Learn — the whole learning experience */}
          <Link
            href="/home/learn"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-green-500/40 bg-green-900/10 p-3 shadow-lg shadow-green-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-green-400/60 hover:bg-green-900/20 hover:shadow-xl hover:shadow-green-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-green-500/15 text-green-400 transition-transform duration-300 group-hover:scale-110">
              <GraduationCap size={22} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="font-semibold text-slate-100 text-base">Learn</p>
                <span className="rounded-full bg-green-500/15 px-1.5 py-0.5 text-xs font-semibold text-green-400">
                  Start here
                </span>
              </div>
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                Pick a topic and build real knowledge — follow your track, ask Hugh
                anything, and practise out loud.
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-green-400 transition-all group-hover:text-green-300 sm:block">
              Choose a topic →
            </span>
          </Link>

          {/* Code — timed coding drills */}
          <Link
            href="/code/start"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-sky-500/40 bg-sky-900/10 p-3 shadow-lg shadow-sky-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-sky-400/60 hover:bg-sky-900/20 hover:shadow-xl hover:shadow-sky-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-sky-500/15 text-sky-400 transition-transform duration-300 group-hover:scale-110">
              <Code2 size={22} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="font-semibold text-slate-100 text-base">Code</p>
                <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-xs font-semibold text-sky-400">
                  New
                </span>
              </div>
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                Short, timed coding reps that build muscle memory — practise what
                you&apos;ve learned or spin up your own drill.
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-sky-400 transition-all group-hover:text-sky-300 sm:block">
              Start coding →
            </span>
          </Link>

          {/* Cases — The Case Room */}
          <Link
            href="/cases"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-amber-500/40 bg-amber-900/10 p-3 shadow-lg shadow-amber-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-amber-400/60 hover:bg-amber-900/20 hover:shadow-xl hover:shadow-amber-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-amber-500/15 text-amber-400 transition-transform duration-300 group-hover:scale-110">
              <Trophy size={22} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="font-semibold text-slate-100 text-base">Cases</p>
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-xs font-semibold text-amber-400">
                  New
                </span>
              </div>
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                Work real business cases in The Case Room — make the calls that
                matter and test your judgment against an expert&apos;s.
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-amber-400 transition-all group-hover:text-amber-300 sm:block">
              Enter the Case Room →
            </span>
          </Link>

          {/* Cloud Skills — cloud-services reference */}
          <Link
            href="/cloud"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-violet-500/40 bg-violet-900/10 p-3 shadow-lg shadow-violet-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-violet-400/60 hover:bg-violet-900/20 hover:shadow-xl hover:shadow-violet-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-violet-500/15 text-violet-400 transition-transform duration-300 group-hover:scale-110">
              <Cloud size={22} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="font-semibold text-slate-100 text-base">Cloud Skills</p>
                <span className="rounded-full bg-violet-500/15 px-1.5 py-0.5 text-xs font-semibold text-violet-400">
                  New
                </span>
              </div>
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                Know your cloud — AWS, GCP and Azure services for data work, grouped by
                what they do, with an assistant to ask anything.
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-violet-400 transition-all group-hover:text-violet-300 sm:block">
              Explore the clouds →
            </span>
          </Link>

          {/* Notes — review a wrong answer with Hugh (personal utility).
              Hidden unless provisioned (migration 050): the grid must not
              advertise a surface that would refuse the learner on arrival. */}
          {notesEnabled && (
          <Link
            href="/notes"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-rose-500/40 bg-rose-900/10 p-3 shadow-lg shadow-rose-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-rose-400/60 hover:bg-rose-900/20 hover:shadow-xl hover:shadow-rose-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-rose-500/15 text-rose-400 transition-transform duration-300 group-hover:scale-110">
              <NotebookPen size={22} />
            </div>
            <div>
              <p className="font-semibold text-slate-100 text-base mb-1">Notes</p>
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                Drop a screenshot of a question you got wrong, jot your thinking, and let Hugh correct it.
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-rose-400 transition-all group-hover:text-rose-300 sm:block">
              Open →
            </span>
          </Link>
          )}

          {/* Monitor — the tracking surface (Skills · Applications · Usage).
              The subheading names all three views on purpose: Applications is
              career admin rather than learning, and a learner should be able to
              see that from the card instead of discovering it inside. */}
          <Link
            href="/monitor"
            className="group flex min-h-24 flex-col gap-1 rounded-2xl border border-cyan-500/40 bg-cyan-900/10 p-3 shadow-lg shadow-cyan-900/20 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-400/60 hover:bg-cyan-900/20 hover:shadow-xl hover:shadow-cyan-500/20 sm:gap-[clamp(0.4rem,1.2vh,0.75rem)] sm:p-[clamp(0.75rem,2.2vh,1.25rem)]"
          >
            <div className="flex h-[clamp(2rem,4.2vh,2.75rem)] w-[clamp(2rem,4.2vh,2.75rem)] items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-400 transition-transform duration-300 group-hover:scale-110">
              <Activity size={22} />
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <p className="font-semibold text-slate-100 text-base">Monitor</p>
                <span className="rounded-full bg-cyan-500/15 px-1.5 py-0.5 text-xs font-semibold text-cyan-400">
                  New
                </span>
              </div>
              {/* The subheading names only the views this account actually has.
                  Promising "jobs you've applied for" to someone whose documents
                  are not provisioned would be a card that lies about itself. */}
              <p className="hidden text-xs leading-snug text-slate-500 sm:block">
                {monitorDocsOn
                  ? <>Your own record, kept by hand — skills you&apos;re learning, jobs you&apos;ve
                      applied for, and where your time on Hugh actually went.</>
                  : <>Your own record, kept by hand — the skills you&apos;re learning, and
                      where your time on Hugh actually went.</>}
              </p>
            </div>
            <span className="mt-auto hidden text-xs font-semibold text-cyan-400 transition-all group-hover:text-cyan-300 sm:block">
              Open Monitor →
            </span>
          </Link>

        </div>

        {/* ── Coming soon: Listen · Updates · Visualize · Manage ────── */}
        <div className="hidden w-full max-w-4xl shrink-0 sm:block">
          <div className="mb-[clamp(0.25rem,1vh,0.5rem)] flex items-center gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              Coming soon
            </span>
            <span className="h-px flex-1 bg-slate-800" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-[clamp(0.375rem,1.2vh,0.625rem)]">
            {COMING_SOON.map(({ name, Icon, blurb }) => (
              <div
                key={name}
                title={blurb}
                aria-disabled="true"
                className="flex cursor-default items-center gap-2 rounded-xl border border-dashed border-slate-800 bg-slate-900/30 px-2.5 py-[clamp(0.375rem,1.2vh,0.625rem)]"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-800/60 text-slate-500">
                  <Icon size={15} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-slate-400">{name}</span>
                  <span className="block truncate text-[10px] leading-tight text-slate-600">{blurb}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
