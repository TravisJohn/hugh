"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const passwordsMatch = confirm.length > 0 && password === confirm;
  const passwordMismatch = confirm.length > 0 && password !== confirm;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    const supabase = createClient();
    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/confirm?next=/home`,
      },
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    // With Supabase "Confirm email" on (as in production), sign-up returns no
    // session: the account is approved when its owner clicks the emailed link,
    // in /auth/confirm.
    if (!data.session) {
      setSent(true);
      return;
    }

    // A session here means email confirmation has been switched off. Nothing
    // approves the account on this path, so /home sends it to /pending until
    // an admin approves it — waiting, never self-approved.
    router.push("/home");
    router.refresh();
  }

  // ── Check your inbox screen ─────────────────────────────────────────────
  if (sent) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0F1E] px-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <Link href="/">
              <span className="font-serif text-2xl font-semibold text-white">Hugh.</span>
            </Link>
          </div>
          <div className="rounded-2xl border border-white/5 bg-slate-900/80 p-10 text-center shadow-2xl backdrop-blur-sm">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-sky-500/10 text-sky-400">
              <Mail className="h-6 w-6" />
            </div>
            <h2 className="text-xl font-bold text-white">Check your inbox</h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">
              We sent a confirmation link to{" "}
              <span className="font-medium text-slate-200">{email}</span>.
              Open it to activate your account and you&apos;re all set.
            </p>
            <p className="mt-3 text-xs text-slate-600">
              Can&apos;t find it? Check your spam or junk folder.
            </p>
            <Link
              href="/login"
              className="mt-7 inline-flex text-sm font-medium text-sky-400 transition-colors hover:text-sky-300"
            >
              ← Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // ── Sign up form ────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0A0F1E] px-4">
      <div className="w-full max-w-md">

        {/* Brand */}
        <div className="mb-8 text-center">
          <Link href="/">
            <span className="font-serif text-2xl font-semibold text-white">Hugh.</span>
          </Link>
        </div>

        <div className="rounded-2xl border border-white/5 bg-slate-900/80 p-8 shadow-2xl backdrop-blur-sm">
          <div className="mb-7">
            <h1 className="text-xl font-bold tracking-tight text-white">
              Create your account
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Free to start — no credit card needed.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">

            {/* Email */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="rounded-xl border border-slate-700/50 bg-slate-800/60 px-4 py-3 text-sm text-white placeholder-slate-600 transition-all focus:border-sky-500/50 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  className="w-full rounded-xl border border-slate-700/50 bg-slate-800/60 px-4 py-3 pr-11 text-sm text-white placeholder-slate-600 transition-all focus:border-sky-500/50 focus:outline-none focus:ring-1 focus:ring-sky-500/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {password.length > 0 && password.length < 8 && (
                <p className="text-xs text-amber-400">
                  {8 - password.length} more character{8 - password.length !== 1 ? "s" : ""} needed
                </p>
              )}
            </div>

            {/* Confirm password */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="confirm" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  id="confirm"
                  type={showConfirm ? "text" : "password"}
                  required
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="••••••••"
                  className={`w-full rounded-xl border bg-slate-800/60 px-4 py-3 pr-11 text-sm text-white placeholder-slate-600 transition-all focus:outline-none focus:ring-1 ${
                    passwordMismatch
                      ? "border-red-500/50 focus:border-red-500/50 focus:ring-red-500/30"
                      : passwordsMatch
                      ? "border-green-500/50 focus:border-green-500/50 focus:ring-green-500/30"
                      : "border-slate-700/50 focus:border-sky-500/50 focus:ring-sky-500/30"
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-colors hover:text-slate-300"
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {passwordsMatch && (
                <p className="text-xs text-green-400">Passwords match ✓</p>
              )}
              {passwordMismatch && (
                <p className="text-xs text-red-400">Passwords don&apos;t match</p>
              )}
            </div>

            {error && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-1 w-full rounded-xl bg-sky-500 py-3 text-sm font-semibold text-white shadow-lg shadow-sky-500/20 transition-all hover:bg-sky-400 hover:shadow-sky-400/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Creating account…" : "Create Account"}
            </button>

            {/* Shown before the account exists, not after. A privacy notice a
                learner can only reach once they have signed up is not a notice. */}
            <p className="text-center text-xs leading-relaxed text-slate-600">
              Hugh sends what you write to AI providers to answer you, and stores it
              until you delete your account.{" "}
              <Link href="/privacy" className="text-slate-400 underline-offset-2 hover:underline">
                What Hugh stores
              </Link>
            </p>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-sky-400 transition-colors hover:text-sky-300"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
