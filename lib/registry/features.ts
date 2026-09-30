// ── The feature registry ────────────────────────────────────────────────────
//
// One entry per surface in Hugh: what a learner can reach, which API routes it
// owns, where its code lives, which tables it touches, and — the part nothing
// else in the codebase knows — which rows in each of the three telemetry stores
// belong to it.
//
// WHY THIS EXISTS. Hugh records three different things in three different
// tables, deliberately, and each speaks its own vocabulary:
//
//   usage_logs.feature        route-level    "learn/chat", "tracker/verify"
//   activity_events.feature   surface-level  "ask", "notes"
//   operation_events.operation operation-level "track.build", "quiz.generate"
//
// Those vocabularies must stay different — that is settled in CLAUDE.md and is
// correct. But because nothing maps between them, no view can put spend,
// engagement and outcome for one feature side by side. Every figure on /admin
// today is grouped by user or by model; not one is grouped by feature.
//
// This file is the join key. It is the reason /admin/features can exist.
//
// WHAT IT IS NOT. It is not a second copy of `lib/monitor/features.ts`. That
// module owns the ten learner-facing calendars in Monitor's Usage view, along
// with their display order and seed caveats. This registry is a superset — it
// also carries internal surfaces with no calendar (admin, margin, the app
// shell) — and carries no display concerns at all. `features.test.ts` asserts
// the overlap between the two agrees, so neither can drift from the other.
//
// ADDING A FEATURE is a TypeScript change, deliberately not a migration — the
// same stance `lib/observability/operations.ts` takes, for the same reason: an
// entry that is wrong renders nowhere, rather than corrupting a view.
//
// Pure: no React, no Supabase, no `server-only`.

import type { OperationId } from "@/lib/observability/operations";

/**
 * Whether a surface is something a learner reaches, or something only the
 * operator sees. `/admin/features` groups by this, because "Notes had three
 * failures" and "the admin console had three failures" are not the same news.
 */
export type FeatureKind = "learner" | "internal";

export interface FeatureDefinition {
  /** Stable key. Used in URLs and as a React key — changing one is a rename. */
  id:    string;
  label: string;
  kind:  FeatureKind;

  /** One sentence, for the operator. Not marketing copy. */
  blurb: string;

  /** Pages a learner (or admin) can navigate to. Paths as they appear in `app/`. */
  routes: readonly string[];

  /** Paths under `app/api/`, without the leading `app/api/` or trailing `/route.ts`. */
  apiRoutes: readonly string[];

  /**
   * Directories under `lib/` and `components/` this surface is built from.
   *
   * A directory may be claimed by more than one feature: `lib/learn` serves
   * both the board and Ask Hugh, and `lib/code` serves both the drills and the
   * sandbox. Code organisation and surface boundaries are not the same
   * partition, and forcing them to be would make one of them a lie. The test
   * therefore asserts every directory is claimed at least once — never that it
   * is claimed exactly once.
   */
  libDirs:        readonly string[];
  componentDirs:  readonly string[];

  /** Postgres tables this surface reads or writes. Informational. */
  tables: readonly string[];

  /** `usage_logs.feature` values whose spend belongs to this surface. */
  usageFeatures: readonly string[];

  /**
   * `activity_events.feature` values reported by this surface.
   *
   * A list rather than a single value because the Code pillar is one codebase
   * behind two calendars — `code-drill` and `code-sandbox` — and collapsing
   * them would lose a distinction Monitor already makes.
   */
  activityFeatures: readonly string[];

  /** `operation_events.operation` ids this surface records. */
  operations: readonly OperationId[];

  /**
   * Whether this surface can cost money at all.
   *
   * `false` is an assertion, not a description: the test fails the build if a
   * route owned by a `false` feature calls `logUsage`. Cases, Case Lab, the
   * code drills and the margin are all deliberately zero-runtime-AI, and that
   * property is load-bearing enough to be machine-checked rather than trusted.
   */
  spendsTokens: boolean;

  /**
   * Test files under this feature's directories.
   *
   * Held here rather than counted at request time, because the page that shows
   * it runs on Vercel where the source tree is not deployed — a filesystem
   * count would be right locally and blank in production. `features.test.ts`
   * asserts this number against the real count, so it cannot go stale.
   *
   * A weak proxy for quality, shown with no judgement attached and next to
   * health, which is the real signal. Coverage is lopsided by design of
   * history, not of intent, and making that visible is the point.
   */
  tests: number;
}

/**
 * Order follows the product: the learning loop first, then the tools a learner
 * reaches for, then the surfaces only the operator sees. Not alphabetical —
 * sorting by name would separate Review from Mastery, which are two halves of
 * one milestone.
 */
export const FEATURES: readonly FeatureDefinition[] = [
  {
    id:    "learn",
    label: "Learn",
    kind:  "learner",
    blurb: "Pick a topic, generate a track, work the Kanban board of milestones.",
    routes: ["/home/learn", "/study/[goalId]", "/study/[goalId]/track"],
    apiRoutes: [
      "dashboard/classify-topic",
      "dashboard/goals",
      "dashboard/goals/[id]",
      "dashboard/goals/[id]/answers",
      "dashboard/goals/[id]/retry",
      "dashboard/goals/document/approve",
      "dashboard/goals/document/extract",
      "dashboard/refine",
      "tracker/tracks/[trackId]",
      "tracker/tracks/[trackId]/reorder",
      "tracker/milestones/[id]",
      "tracker/milestones/[id]/entries",
      "tracker/milestones/[id]/summary",
    ],
    libDirs:       ["tracker", "documents", "learn"],
    componentDirs: ["dashboard", "tracker"],
    tables: [
      "learning_goals", "tracks", "milestones", "goal_answers",
      "track_generations", "pending_document_extractions",
    ],
    usageFeatures: [
      "dashboard/refine-topic", "dashboard/refine", "dashboard/document-extract",
      "learn/topic-domain", "tracker/generate", "tracker/priority", "tracker/summary",
    ],
    activityFeatures: ["learn"],
    operations: [
      "track.build", "track.retry", "track.refine", "track.extract",
      "track.summary", "topic.gate", "answers.forget",
    ],
    spendsTokens: true,
    tests: 17,
  },
  {
    id:    "ask",
    label: "Ask Hugh",
    kind:  "learner",
    blurb: "Tutor chat against a milestone, with the learning diary and focus timer.",
    routes: ["/study/[goalId]/ask"],
    apiRoutes: [
      "learn/chat",
      "learn/summarize",
      "learn/save-summary",
      "tracker/entries/[entryId]",
      "tracker/entries/[entryId]/verify",
      "tracker/milestones/[id]/coverage",
    ],
    libDirs:       ["learn", "askcode"],
    componentDirs: ["learn", "askcode"],
    tables: ["milestone_entries", "milestones", "tracks", "point_status_events"],
    usageFeatures: ["learn/chat", "learn/summarize", "tracker/verify", "tracker/points"],
    activityFeatures: ["ask"],
    operations: ["ask.chat", "ask.summarize", "ask.verify", "ask.coverage"],
    spendsTokens: true,
    tests: 15,
  },
  {
    id:    "review",
    label: "Review quiz",
    kind:  "learner",
    blurb: "Diary-grounded quiz — every question must quote a verified diary line.",
    routes: ["/review/[milestoneId]"],
    apiRoutes: ["tracker/review/quiz"],
    libDirs:       [],
    componentDirs: [],
    tables: ["milestones", "milestone_entries"],
    usageFeatures: ["review/quiz"],
    activityFeatures: ["review"],
    operations: ["quiz.generate"],
    spendsTokens: true,
    tests: 0,
  },
  {
    id:    "mastery",
    label: "Prove mastery",
    kind:  "learner",
    blurb: "Explain a milestone out loud — scripted for learners; Realtime is an administrator preview.",
    routes: ["/mastery/[milestoneId]"],
    apiRoutes: [
      "tracker/mastery/evaluate",
      "tracker/mastery/recap",
      "tracker/mastery/session",
      "tracker/mastery/realtime-session",
      "tracker/mastery/realtime-usage",
    ],
    libDirs:       ["mastery"],
    componentDirs: [],
    tables: ["milestones", "milestone_entries"],
    usageFeatures: [
      "mastery/evaluate",
      "mastery/recap",
      "mastery/session",
      // Realtime voice. Gated at mint time under this same string since the
      // flag was written; it only became a SPEND string once the usage report
      // landed, because before that nothing was ever logged against it.
      "mastery/realtime",
    ],
    activityFeatures: ["mastery"],
    operations: [
      "mastery.evaluate",
      "mastery.recap",
      "mastery.session",
      "mastery.realtime",
    ],
    spendsTokens: true,
    tests: 6,
  },
  {
    id:    "code",
    label: "Code",
    kind:  "learner",
    blurb: "Pattern map, timed fluency drills, and a free-form Python sandbox.",
    routes: ["/code", "/code/start", "/code/drill"],
    apiRoutes: ["code/attempts", "code/chat", "code/generate-drill", "code/pins"],
    libDirs:       ["code"],
    componentDirs: ["code"],
    tables: ["code_drills", "code_drill_attempts", "pinned_thoughts"],
    usageFeatures: ["code/chat", "code/generate-drill"],
    activityFeatures: ["code-drill", "code-sandbox"],
    operations: ["code.chat", "code.drill"],
    spendsTokens: true,
    tests: 9,
  },
  {
    id:    "cases",
    label: "The Case Room",
    kind:  "learner",
    blurb: "Judgment cases from static JSON. Zero runtime AI by design.",
    routes: ["/cases", "/cases/[id]"],
    apiRoutes: ["cases/progress"],
    libDirs:       ["cases"],
    componentDirs: ["cases"],
    tables: ["case_attempts"],
    usageFeatures: [],
    activityFeatures: ["cases"],
    operations: [],
    spendsTokens: false,
    tests: 1,
  },
  {
    id:    "case-lab",
    label: "Case Lab",
    kind:  "learner",
    blurb: "Long-form cases with a CSV and an in-browser worked notebook.",
    routes: ["/cases/lab", "/cases/lab/[id]"],
    apiRoutes: [],
    libDirs:       ["case-lab"],
    componentDirs: ["case-lab"],
    tables: [],
    usageFeatures: [],
    activityFeatures: ["case-lab"],
    operations: [],
    spendsTokens: false,
    tests: 1,
  },
  {
    id:    "cloud",
    label: "Cloud reference",
    kind:  "learner",
    blurb: "Cloud-services reference with an assistant and a review list.",
    routes: ["/cloud", "/cloud/[provider]/[service]"],
    apiRoutes: ["cloud/chat"],
    libDirs:       ["cloud"],
    componentDirs: ["cloud"],
    tables: [],
    usageFeatures: ["cloud/chat"],
    activityFeatures: ["cloud"],
    operations: ["cloud.chat"],
    spendsTokens: true,
    tests: 1,
  },
  {
    id:    "notes",
    label: "Notes",
    kind:  "learner",
    blurb: "Screenshot-and-reasoning workspace with per-image Coach threads.",
    routes: ["/notes"],
    apiRoutes: [
      "notes/coach", "notes/group", "notes/images", "notes/messages",
      "notes/move", "notes/notebooks", "notes/notes", "notes/summarize",
    ],
    libDirs:       ["notes"],
    componentDirs: ["notes"],
    tables: ["notes", "notebooks", "note_images", "note_messages"],
    usageFeatures: ["notes/coach", "notes/summarize"],
    activityFeatures: ["notes"],
    operations: ["notes.coach", "notes.summarize"],
    spendsTokens: true,
    tests: 4,
  },
  {
    id:    "margin",
    label: "The margin",
    kind:  "internal",
    blurb: "Scratch-pad primitive embedded in other surfaces. Not the Notes workspace.",
    routes: [],
    apiRoutes: ["margin"],
    libDirs:       ["margin"],
    componentDirs: ["margin"],
    tables: ["learner_notes"],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    // Load-bearing. Cloud Skills browsing is a zero-runtime-AI surface, and the
    // margin must not be what changes that. Asserted, not merely documented.
    spendsTokens: false,
    tests: 1,
  },
  {
    id:    "voice",
    label: "Voice (TTS)",
    kind:  "internal",
    blurb: "ElevenLabs speech, called by whichever surface is speaking.",
    routes: [],
    apiRoutes: ["tts"],
    libDirs:       [],
    componentDirs: [],
    tables: [],
    // `tts` rows are deliberately NOT credited to a learner-facing surface —
    // they belong to whoever was speaking and cannot be attributed to one.
    // `lib/monitor/features.ts` excludes them from the Usage view for exactly
    // this reason; owning them here keeps the spend visible somewhere without
    // mis-attributing it.
    usageFeatures: ["tts"],
    activityFeatures: [],
    operations: ["voice.speak"],
    spendsTokens: true,
    tests: 0,
  },
  {
    id:    "monitor",
    label: "Monitor",
    kind:  "internal",
    blurb: "Hand-kept tracking: skills, job applications, documents, usage calendars.",
    routes: ["/monitor"],
    apiRoutes: [
      "monitor/activity", "monitor/applications", "monitor/applications/[id]",
      "monitor/documents", "monitor/documents/[id]/versions", "monitor/documents/file",
      "monitor/skills", "monitor/skills/[id]/entries",
    ],
    libDirs:       ["monitor"],
    componentDirs: ["monitor", "usage"],
    tables: [
      "activity_events", "monitor_skills", "monitor_skill_entries",
      "monitor_applications", "monitor_application_events",
      "monitor_documents", "monitor_document_versions",
    ],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    spendsTokens: false,
    tests: 6,
  },
  {
    id:    "account",
    label: "Account",
    kind:  "internal",
    blurb: "Learner's own settings, data disclosure and deletion.",
    routes: ["/account"],
    apiRoutes: ["account"],
    libDirs:       ["account"],
    componentDirs: ["account"],
    tables: ["profiles"],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    spendsTokens: false,
    tests: 1,
  },
  {
    id:    "admin",
    label: "Admin console",
    kind:  "internal",
    blurb: "What needs attention, spend by feature, accounts and approvals.",
    routes: ["/admin", "/admin/features", "/admin/users"],
    apiRoutes: ["admin/users/[userId]"],
    libDirs:       [],
    componentDirs: [],
    tables: ["profiles", "usage_logs"],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    spendsTokens: false,
    tests: 0,
  },
  {
    id:    "observability",
    label: "Observability console",
    kind:  "internal",
    blurb: "Operation outcomes: what was attempted, what failed, what was refused.",
    routes: ["/admin/observability"],
    apiRoutes: ["observability/beacon"],
    // `lib/observability` itself is infrastructure, not this surface's code —
    // the store is shared by everything, the console is what lives here.
    libDirs:       [],
    componentDirs: [],
    tables: ["operation_events", "learning_goals"],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    spendsTokens: false,
    tests: 0,
  },
  {
    id:    "architecture",
    label: "Architecture dashboard",
    kind:  "internal",
    blurb: "Repo map and the admin architecture assistant.",
    routes: ["/admin/architecture"],
    apiRoutes: ["architecture/chat", "architecture/data"],
    libDirs:       ["architecture"],
    componentDirs: [],
    tables: [],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    // Uses OPENAI_MODEL, but through its own key and outside logUsage — the
    // assistant is an operator tool, not learner spend. If that changes, this
    // flag flips and the test will demand a usageFeatures entry.
    spendsTokens: false,
    tests: 0,
  },
  {
    id:    "shell",
    label: "App shell",
    kind:  "internal",
    blurb: "Landing page, sign-in, the activity grid, and the gate pages.",
    routes: [
      "/", "/home", "/(auth)/login", "/(auth)/signup",
      "/pending", "/blocked", "/privacy", "/upgrade",
    ],
    apiRoutes: ["auth/self-approve"],
    libDirs:       [],
    componentDirs: ["landing"],
    tables: ["profiles"],
    usageFeatures: [],
    activityFeatures: [],
    operations: [],
    spendsTokens: false,
    tests: 0,
  },
] as const;

// ── Infrastructure ──────────────────────────────────────────────────────────

/**
 * Directories under `lib/` that belong to no single feature because every
 * feature stands on them. Listed explicitly so that a NEW directory appearing
 * in `lib/` is a test failure rather than a silent orphan — the whole point of
 * the drift guard is that nothing gets to be unowned by accident.
 */
export const INFRA_LIB_DIRS: readonly string[] = [
  "supabase",      // database clients
  "storage",       // file ownership checks shared by Notes and Monitor
  "auth",          // session and admin gating
  "claude",        // prompts and parsers
  "errors",        // error shapes
  "observability", // the outcomes store (the console is a feature; the store is not)
  "pomodoro",      // focus timer, shared by Ask Hugh, Notes and the code drills
  "registry",      // this module
] as const;

/** Same idea for `components/`. */
export const INFRA_COMPONENT_DIRS: readonly string[] = [
  "ui",
] as const;

/**
 * `usage_logs.feature` values that legitimately belong to no single surface.
 *
 * Kept as an explicit list with a reason attached, rather than as a gap in the
 * registry, so that an unclaimed string is always either a deliberate exclusion
 * or a failed build — never an oversight that quietly under-reports spend.
 */
export const UNATTRIBUTED_USAGE_FEATURES: readonly string[] = [
  // The legacy interview loop, deleted 2026-08-24. Historic rows survive in
  // usage_logs and must still price correctly; no live route emits these.
  "interview",
  "tracker/generate-legacy",
] as const;

// ── Cross-feature import edges ──────────────────────────────────────────────

/**
 * The complete set of imports one feature directory is allowed to make into
 * another. Everything not listed here is a build failure.
 *
 * Infrastructure is not listed and never needs to be: any feature may import
 * `lib/supabase`, `lib/auth`, `lib/claude`, `lib/observability` and the rest
 * freely, which is what makes them infrastructure. Only feature-to-feature
 * edges are governed here, and there are seven in the whole codebase — two in
 * `lib/`, five in `components/`. Measured, not assumed.
 *
 * That number is the reason Hugh does not need splitting into separate
 * repositories: the independence already exists. This list is what keeps it,
 * because an edge can now only be added on purpose, with a reason beside it.
 */
export interface ImportEdge {
  from:   string;
  to:     string;
  /** Why this edge is acceptable. Required — an edge with no reason is a smell. */
  reason: string;
}

export const ALLOWED_LIB_EDGES: readonly ImportEdge[] = [
  { from: "tracker", to: "learn",
    reason: "Track generation runs the topic-domain gate before it spends." },
  { from: "code", to: "case-lab",
    reason: "The Case Lab notebook reuses the Pyodide session client." },
] as const;

export const ALLOWED_COMPONENT_EDGES: readonly ImportEdge[] = [
  { from: "case-lab", to: "code",
    reason: "Case Lab renders the shared notebook cell components." },
  { from: "cloud", to: "margin",
    reason: "Cloud Skills is the first surface to carry a margin pad." },
  { from: "learn", to: "askcode",
    reason: "Code mode is a composer mode inside the Ask Hugh chat." },
  { from: "notes", to: "learn",
    reason: "Notes reuses the focus timer and music player from the Ask page." },
  { from: "tracker", to: "learn",
    reason: "The milestone drawer embeds the Ask Hugh chat surface." },
] as const;

// ── Lookups ─────────────────────────────────────────────────────────────────

export const FEATURE_IDS: readonly string[] = FEATURES.map(f => f.id);

export function featureById(id: string): FeatureDefinition | null {
  return FEATURES.find(f => f.id === id) ?? null;
}

/** Which feature owns a given `usage_logs.feature` string, if any. */
export function featureForUsage(usageFeature: string): FeatureDefinition | null {
  return FEATURES.find(f => f.usageFeatures.includes(usageFeature)) ?? null;
}

/** Which feature owns a given `operation_events.operation` id, if any. */
export function featureForOperation(operation: string): FeatureDefinition | null {
  return FEATURES.find(f => (f.operations as readonly string[]).includes(operation)) ?? null;
}

/**
 * Whether a feature can report an outcome at all.
 *
 * This is the distinction `/admin/features` is built around: a surface that
 * spends money but records no operations is not healthy, and is not broken —
 * it is invisible, and must render as its own third state. A blank must never
 * be readable as a pass.
 */
export function isInstrumented(f: FeatureDefinition): boolean {
  return f.operations.length > 0;
}

/** Surfaces that spend money without recording whether the spend worked. */
export function blindSpenders(): readonly FeatureDefinition[] {
  return FEATURES.filter(f => f.spendsTokens && !isInstrumented(f));
}
