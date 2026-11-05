import type { NextConfig } from "next";

// Supabase host is needed in the CSP (signed image URLs load as <img src>,
// and the SDK talks to it directly from the browser). Read from the same
// env var the client SDK uses so the policy never drifts from the real
// project — see lib/supabase/client.ts.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseHost = supabaseUrl ? new URL(supabaseUrl).origin : "";

// MEDIUM-02 (deployment readiness audit): baseline security headers + a
// report-only CSP. Report-only so nothing breaks while we observe real
// violations; promote to enforcing (`Content-Security-Policy`) once that's
// been done. Directives below cover the browser's actual external surface:
// Supabase (auth/storage) and jsDelivr (Pyodide worker script + DuckDB-WASM
// bundle — see lib/code/pyodide.worker.ts, lib/code/duckdbClient.ts).
const cspDirectives = (frameAncestors: "none" | "self") => [
  `default-src 'self'`,
  `base-uri 'self'`,
  `object-src 'none'`,
  `form-action 'self'`,
  `frame-ancestors '${frameAncestors}'`,
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:${supabaseHost ? ` ${supabaseHost}` : ""}`,
  `font-src 'self' data:`,
  `worker-src 'self' blob:`,
  `connect-src 'self' https://cdn.jsdelivr.net${supabaseHost ? ` ${supabaseHost} wss://${new URL(supabaseUrl!).host}` : ""}`,
  `media-src 'self'`,
].join("; ");

// Framing policy is the one header that varies by path. Everything else is
// identical, so it's built once here rather than duplicated across the two
// rules below.
const securityHeaders = (framing: "DENY" | "SAMEORIGIN") => [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: framing },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), interest-cohort=()" },
  {
    key: "Content-Security-Policy-Report-Only",
    value: cspDirectives(framing === "SAMEORIGIN" ? "self" : "none"),
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      // The architecture dashboard is a static asset that app/admin/architecture
      // embeds in a same-origin <iframe>. A blanket DENY refuses even that, so
      // this one prefix gets SAMEORIGIN. The page doing the framing is itself
      // admin-gated, and the asset carries no secrets or data.
      {
        source: "/admin-architecture/:path*",
        headers: securityHeaders("SAMEORIGIN"),
      },
      // Everything else stays un-framable. The negative lookahead keeps this
      // rule from also matching the path above — Next.js applies every matching
      // rule, which would otherwise emit two conflicting X-Frame-Options.
      {
        source: "/((?!admin-architecture/).*)",
        headers: securityHeaders("DENY"),
      },
    ];
  },
};

export default nextConfig;
