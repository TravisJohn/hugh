import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import FeatureCards from "@/components/landing/FeatureCards";

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect("/home");

  return (
    <div className="min-h-screen bg-[#0A0F1E] text-slate-100">

      {/* ── Breathing background orbs — fixed so they persist while scrolling ── */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="animate-breathe absolute top-0 left-0 h-[600px] w-[600px] -translate-x-1/3 -translate-y-1/3 rounded-full bg-sky-500/15 blur-3xl" />
        <div className="animate-breathe-delayed absolute bottom-0 right-0 h-[700px] w-[700px] translate-x-1/3 translate-y-1/3 rounded-full bg-violet-500/12 blur-3xl" />
        <div className="animate-breathe-slow absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full bg-sky-400/8 blur-3xl" />
      </div>

      {/* ── Nav ─────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-[#0A0F1E]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="font-serif text-xl font-semibold tracking-tight text-white">
            Hugh.
          </span>
          <Link
            href="/login"
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition-all hover:border-slate-500 hover:bg-slate-800/60 hover:text-white"
          >
            Sign in
          </Link>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="relative py-24">
        <div className="relative mx-auto flex max-w-5xl flex-col items-center gap-8 px-6 text-center">
          {/* Logo */}
          <div className="relative">
            <div className="absolute inset-0 rounded-full bg-sky-400/10 blur-2xl scale-150" />
            <Image
              src="/hugh-logo.png.png"
              alt="Hugh"
              width={240}
              height={240}
              className="relative object-contain drop-shadow-2xl"
              priority
            />
          </div>

          {/* Headline */}
          <div className="space-y-2">
            <h1 className="font-serif text-5xl leading-tight tracking-tight text-slate-100 md:text-6xl">
              You can learn anything,
            </h1>
            <h1 className="font-serif text-5xl leading-tight tracking-tight md:text-6xl">
              <span className="bg-gradient-to-r from-sky-400 to-violet-400 bg-clip-text text-transparent">
                and it all starts with You.
              </span>
            </h1>
          </div>

          {/* Subtext */}
          <p className="max-w-xl text-lg leading-relaxed text-slate-400">
            Hugh builds a learning track around your topic. Ask questions, keep a diary,
            and check your understanding as you go.
          </p>

          {/* Buttons */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/login"
              className="rounded-xl bg-sky-500 px-8 py-3.5 text-sm font-semibold text-white shadow-lg shadow-sky-500/20 transition-all hover:bg-sky-400 hover:shadow-sky-400/30"
            >
              Start practicing free
            </Link>
            <Link
              href="/login"
              className="rounded-xl border border-slate-700 px-6 py-3.5 text-sm text-slate-300 transition-all hover:border-slate-500 hover:bg-slate-800/60 hover:text-white"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* ── The Platform ──────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
              The Platform
            </p>
            <h2 className="font-serif text-2xl text-slate-200">
              Everything you need to grow
            </h2>
          </div>

          <FeatureCards />
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────── */}
      <section className="py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="mb-10">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
              How It Works
            </p>
            <h2 className="font-serif text-2xl text-slate-200">
              Four steps to knowing your stuff
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">

            <div className="group border-t-2 border-sky-500 pt-5">
              <p className="text-3xl font-bold text-slate-800 transition-colors duration-200 group-hover:text-slate-700">
                01
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-200">
                Pick a topic you want to learn
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Choose a subject, paste a job description, or start with a preset
                domain. Hugh gets ready around you.
              </p>
            </div>

            <div className="group border-t border-slate-700/60 pt-5 transition-colors duration-200 hover:border-slate-600">
              <p className="text-3xl font-bold text-slate-800 transition-colors duration-200 group-hover:text-slate-700">
                02
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-200">
                Explore it with Hugh
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Ask questions, work through the ideas, and capture what you learn
                in your diary.
              </p>
            </div>

            <div className="group border-t border-slate-700/60 pt-5 transition-colors duration-200 hover:border-slate-600">
              <p className="text-3xl font-bold text-slate-800 transition-colors duration-200 group-hover:text-slate-700">
                03
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-200">
                Track your know-how
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Your milestone cards show your progress and what to revisit next.
              </p>
            </div>

            <div className="group border-t border-slate-700/60 pt-5 transition-colors duration-200 hover:border-slate-600">
              <p className="text-3xl font-bold text-slate-800 transition-colors duration-200 group-hover:text-slate-700">
                04
              </p>
              <p className="mt-3 text-sm font-semibold text-slate-200">
                Ask your dedicated assistant
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
                Stuck on a concept? Hugh stays on topic and explains it in depth,
                just for you.
              </p>
            </div>

          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/5 py-10">
        <div className="mx-auto max-w-5xl px-6 flex items-center justify-between">
          <span className="font-serif text-sm text-slate-600">Hugh</span>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="text-xs text-slate-600 transition-colors hover:text-slate-400">
              Privacy
            </Link>
            <p className="text-xs text-slate-700">Skill Prep App · Free to use</p>
          </div>
        </div>
      </footer>

    </div>
  );
}
