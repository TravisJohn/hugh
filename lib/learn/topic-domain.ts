import { isRegionId } from "@/lib/learn/regions";

// ── Topic domain gate ────────────────────────────────────────────────────────
// Hugh is strictly a data & analytics skill-prep app. Before ANY topic entry
// point builds a track or starts a session, an LLM judge (server-side, Haiku)
// decides whether the topic's core skill is in-domain (data engineering / data
// science / ML & LLM engineering / analytics / statistics / SQL / BI / cloud
// data / related tooling).
//
// A reliable judgement has three outcomes. A binary gate has only "build it" and
// "go away", and a bare topic like "Generative AI" is neither: its core skill
// depends entirely on which reading the learner meant (building RAG pipelines
// and evals is ML engineering — in domain; using ChatGPT to write faster is
// not). The old gate resolved that ambiguity by rejecting, then offered data
// reframes — telling the learner their topic was off-limits and in the same
// breath suggesting the same topic in different words. "needs_angle" is that
// missing third state: don't reject an under-specified topic, ask which angle
// they meant.

/**
 * - `in`          — the core skill is data/analytics. Proceed.
 * - `needs_angle` — a genuine data reading exists but the phrasing hasn't
 *                   committed to one. Don't proceed, and don't reject: ask,
 *                   carrying `suggestions` as the answers.
 * - `out`         — the core skill is a different profession or subject.
 *                   Declined with a warm heads-up and nothing else: no angles,
 *                   no reframes. Offering data readings of an off-domain
 *                   subject was tried and removed — Hugh proposing a track on
 *                   "measuring your Spanish retention" to someone who asked to
 *                   learn Spanish is not a kindness, it is a sales pitch.
 * - `unavailable` — no reliable judgement was made. Retry the same topic.
 */
export type TopicVerdict = "in" | "needs_angle" | "out" | "unavailable";

export interface TopicDomainVerdict {
  /** One of three judgements, or a retryable classifier failure. */
  verdict: TopicVerdict;
  /** One short clause explaining the call (for logs / debugging). */
  reason: string;
  /**
   * Learner-facing copy.
   *
   * Usually empty for "in" — a topic that passes cleanly needs no comment. The
   * exception is a topic naming a TOOL or PLATFORM (Airflow, dbt, Power BI):
   * it passes, and carries one sentence saying Hugh Learn will teach the
   * durable concepts behind it rather than the tool itself. Said before the
   * refinement questions, not after a track is built, because a learner who
   * wanted hands-on practice should find that out in the first ten seconds.
   */
  message: string;
  /** 0–3 data-angle options. Required when "needs_angle"; optional when "out". */
  suggestions: string[];
  /**
   * Which learning region this topic belongs to, when the judge could say.
   *
   * Only meaningful for "in" — a topic that is not being built needs no filing.
   * Undefined whenever the judge omitted it or named something that is not a
   * region: a goal with no region simply lights nothing.
   */
  region?: string;
}

/** True only when a track may actually be built from this topic. */
export function mayProceed(v: TopicDomainVerdict): boolean {
  return v.verdict === "in";
}

/**
 * True when the gate is holding a question out to the learner rather than
 * deciding for them, and is waiting on an answer before anything is built.
 *
 * One verdict qualifies today. It is a function rather than a comparison so a
 * caller cannot branch on `"out"` alone and let a verdict it has never heard of
 * fall through as though it were approval — which is exactly how the document
 * path behaved before this existed.
 */
export function awaitsChoice(v: TopicDomainVerdict): boolean {
  return v.verdict === "needs_angle";
}

/** A retryable outcome when the judge could not make a reliable call. */
export function unavailableVerdict(reason = "classifier-unavailable"): TopicDomainVerdict {
  return { verdict: "unavailable", reason, message: "Hugh couldn't check this topic right now. Please try again.", suggestions: [] };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asSuggestions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 3);
}

/**
 * Turn an untrusted judge response into a safe verdict. Shared by the server
 * judge and the browser wrapper so malformed-output rules exist in exactly one
 * place and cannot drift apart.
 *
 * A malformed answer is unavailable, never approval or a judgement against
 * the learner. They can retry the same topic when the classifier recovers.
 */
export function normalizeVerdict(raw: unknown): TopicDomainVerdict {
  if (typeof raw !== "object" || raw === null) return unavailableVerdict("malformed-response");

  const r      = raw as Record<string, unknown>;
  const reason = asString(r.reason);
  const suggestions = asSuggestions(r.suggestions);

  // Legacy/regression path: an older prompt (or a model reverting to the old
  // shape) emits the boolean instead. `inDomain:false` meant "out".
  const raw3 = typeof r.verdict === "string" ? r.verdict : r.inDomain === false ? "out" : r.inDomain === true ? "in" : "";

  if (raw3 === "out") {
    return { verdict: "out", reason, message: asString(r.message), suggestions };
  }

  // A retired verdict, kept as a mapping rather than a hole. An older prompt
  // (or a model reverting to it) can still emit "reframe" for an off-domain
  // subject; that is a decline now, and must not fall through to the unavailable
  // return below and build a track for it.
  if (raw3 === "reframe") {
    return { verdict: "out", reason: reason || "reframe-retired", message: "", suggestions: [] };
  }

  if (raw3 === "needs_angle") {
    // A question with no answer choices is a broken classifier response.
    if (suggestions.length === 0) return unavailableVerdict("needs-angle-without-suggestions");
    return { verdict: "needs_angle", reason, message: asString(r.message), suggestions };
  }

  // An explicit, well-formed "in" may carry a note (see `message` above). The
  // unavailable path below deliberately cannot: a verdict Hugh never really made
  // must not put words in Hugh's mouth.
  if (raw3 === "in") {
    const region = isRegionId(r.region) ? r.region : undefined;
    return { verdict: "in", reason, message: asString(r.message), suggestions: [], region };
  }

  return unavailableVerdict(reason || "unrecognised-verdict");
}

/**
 * Ask the server-side judge whether `topic` is within Hugh's domain. Called at
 * every topic ENTRY point to enforce the "data & analytics skill prep only"
 * protocol.
 *
 * `previousAttempts` are earlier phrasings this learner was already asked to
 * narrow. They exist so a second or third try does not come back with the same
 * three suggestions the learner has already turned down; they do not influence
 * the verdict. Build the list with `recordAttempt` in `lib/learn/gateHistory`.
 *
 * A transient failure asks the learner to retry; it never creates a track from
 * an unclassified topic.
 */
export async function classifyTopic(
  topic:            string,
  previousAttempts: readonly string[] = [],
): Promise<TopicDomainVerdict> {
  try {
    const res = await fetch("/api/dashboard/classify-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, previousAttempts }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: unknown } | null;
      const unavailable = unavailableVerdict();
      if (typeof body?.error === "string" && [429, 503].includes(res.status)) unavailable.message = body.error;
      return unavailable;
    }
    return normalizeVerdict(await res.json());
  } catch {
    return unavailableVerdict();
  }
}
