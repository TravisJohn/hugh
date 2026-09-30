import type { TextCallGuard } from "@/lib/claude/textInput";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  generateMilestones,
  MAX_TOKENS,
  MODEL,
} from "@/lib/tracker/generateMilestones";
import {
  milestonePromptId,
  promptFingerprint,
  promptVersion,
} from "@/lib/claude/promptIdentity";
import { assignBacklogPriority, type PriorityAssignment } from "@/lib/tracker/priority";
import { answerChars, contextUptake, type QAPair } from "@/lib/learn/contextUptake";
import { logUsage } from "@/lib/usage";
import { logSafeError } from "@/lib/observability/log";
import { errorClassOf } from "@/lib/observability/sanitize";
import { type KanbanColumn } from "@/types";

/** A track could not be built. Distinct from a Claude/parse error so the
 *  caller can tell "the model misbehaved" from "the database refused". */
export class TrackGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackGenerationError";
  }
}

/** Optional provenance context — see `track_generations` in migration 048. */
export interface GenerationOptions {
  /** Prompt-sized admission for callers that opt into the S2 text boundary. */
  beforeGeneration?: TextCallGuard;
  beforePriority?: TextCallGuard;
  /**
   * Whether the generation prompt actually READ the learner's answers.
   *
   * False today, and deliberately so: every row written while this stays false
   * is a control-arm sample — a real learner with real context that the model
   * never saw. Flip it in the same change that starts feeding answers into
   * `milestoneGenerationPrompt`, and the two eras stay separable forever.
   */
  contextUsed?: boolean;

  /** True when called by the offline replay harness rather than a learner. */
  isReplay?: boolean;
}

// A track with no milestones is not a partial success, it is an empty Kanban
// board with no explanation on it. If the milestone insert fails we delete the
// track we just made rather than leave an orphan row behind: the goal's
// track_status goes to 'failed', and a retry must not find a stale track
// sitting where the new one belongs.
async function deleteOrphanTrack(supabase: SupabaseClient, trackId: string): Promise<void> {
  const { error } = await supabase.from("tracks").delete().eq("id", trackId);
  if (error) {
    // Nothing more we can do here — the throw that follows is the real signal.
    // Logged loudly because it leaves a row that a retry will have to survive.
    logSafeError(`generateTrack orphan cleanup ${trackId}`, error);
  }
}

/**
 * The learner's 5-whys answers, read only to MEASURE them.
 *
 * Reading them here is not the same as using them: `contextUsed` stays false
 * until the generation prompt itself consumes them. What comes back is turned
 * into two numbers and discarded — the words never leave `goal_answers`.
 *
 * Failure is swallowed. A provenance measurement must never be the reason a
 * learner's track build fails.
 */
async function readGoalAnswers(
  supabase: SupabaseClient,
  goalId:   string,
): Promise<QAPair[]> {
  const { data, error } = await supabase
    .from("goal_answers")
    .select("question, answer")
    .eq("goal_id", goalId)
    .order("position", { ascending: true });

  if (error) {
    logSafeError("generateTrack answer measurement", error);
    return [];
  }
  return (data ?? []) as QAPair[];
}

/** One milestone as the learner receives it, ranking included. */
interface ServedMilestone {
  title:           string;
  summary:         string;
  column:          KanbanColumn;
  position:        number;
  priority_rank:   number | null;
  priority_reason: string | null;
}

/**
 * The row written to `track_generations`. Accumulated as the build proceeds so
 * that whatever has been established by the time something throws is still
 * recorded — a failure that reaches the model knows its attempt count, and one
 * that reaches the database knows its milestone count.
 */
interface GenerationRecord {
  user_id:            string;
  goal_id:            string | null;
  track_id:           string | null;
  source_kind:        "qa" | "document";
  model:              string;
  prompt_version:     string;
  prompt_fingerprint: string;
  max_tokens:         number;
  input_topic:        string;
  answer_count:       number;
  context_used:       boolean;
  answer_chars:       number;
  context_uptake:     number | null;
  milestones_out:     ServedMilestone[] | null;
  milestone_count:    number | null;
  ranked:             boolean;
  rank_model:         string | null;
  rank_fingerprint:   string | null;
  columns_coerced:    number;
  outcome:            "ok" | "failed";
  error_class:        string | null;
  attempts:           number;
  generation_ms:      number | null;
  tokens_in:          number;
  tokens_out:         number;
  is_replay:          boolean;
}

/**
 * Write the provenance row. Never throws, never rejects.
 *
 * Same inversion `lib/observability/record.ts` documents: observability must
 * not break the thing it observes. A failed provenance write costs an eval
 * sample; a thrown one would cost the learner their track.
 */
async function writeGenerationRecord(
  supabase: SupabaseClient,
  record:   GenerationRecord,
): Promise<void> {
  try {
    const { error } = await supabase.from("track_generations").insert(record);
    if (error) logSafeError("generateTrack provenance", error, [record.input_topic]);
  } catch (err) {
    logSafeError("generateTrack provenance", err, [record.input_topic]);
  }
}

export async function generateTrack(
  supabase:      SupabaseClient,
  userId:        string,
  topic:         string,
  goalId?:       string,
  documentText?: string,
  options:       GenerationOptions = {},
): Promise<string> {
  const startedAt = Date.now();
  const promptId  = milestonePromptId(documentText);

  // Everything known before the first model call. The rest is filled in as the
  // build proceeds, and the row is written in `finally` so both the success
  // and the failure branch record one — from ONE site. Writing it from the
  // three calling routes instead would rebuild exactly the duplication
  // architecture rule 3 exists to prevent.
  const record: GenerationRecord = {
    user_id:            userId,
    goal_id:            goalId ?? null,
    track_id:           null,
    // What the generator ACTUALLY SAW. A retried document goal has no document
    // — the approve route deletes the extracted text once it has been read —
    // so that rebuild is honestly a 'qa' generation.
    source_kind:        documentText ? "document" : "qa",
    model:              MODEL,
    prompt_version:     promptVersion(promptId),
    prompt_fingerprint: promptFingerprint(promptId),
    max_tokens:         MAX_TOKENS,
    input_topic:        topic,
    answer_count:       0,
    context_used:       options.contextUsed ?? false,
    answer_chars:       0,
    context_uptake:     null,
    milestones_out:     null,
    milestone_count:    null,
    ranked:             false,
    rank_model:         null,
    rank_fingerprint:   null,
    columns_coerced:    0,
    outcome:            "failed",
    error_class:        null,
    attempts:           0,
    generation_ms:      null,
    tokens_in:          0,
    tokens_out:         0,
    is_replay:          options.isReplay ?? false,
  };

  try {
    const answers = goalId ? await readGoalAnswers(supabase, goalId) : [];
    record.answer_count = answers.length;
    record.answer_chars = answerChars(answers);

    const { parsed, usage: genUsage, attempts } = await generateMilestones(topic, documentText, MODEL, undefined, options.beforeGeneration);
    record.attempts   = attempts;
    record.tokens_in  = genUsage.inputTokens;
    record.tokens_out = genUsage.outputTokens;

    // Track generation is the single largest Claude call in the product. Log it
    // as soon as it returns, so the spend is recorded even if the DB writes fail.
    // A replay has no learner to bill, and usage_logs.user_id is NOT NULL
    // against auth.users, so its spend lives only on the provenance row (Q4).
    if (!record.is_replay) {
      void logUsage({
        userId,
        model:     MODEL,
        feature:   "tracker/generate",
        tokensIn:  genUsage.inputTokens,
        tokensOut: genUsage.outputTokens,
      });
    }

    // Measured against what the model produced, whether or not it read the
    // answers — that comparison is the point of the control arm.
    record.context_uptake = contextUptake(answers, parsed.milestones);

    const trackRow: Record<string, unknown> = {
      user_id:           userId,
      title:             parsed.trackTitle,
      topic_description: topic,
    };
    if (goalId) trackRow.goal_id = goalId;

    const { data: track, error: trackError } = await supabase
      .from("tracks")
      .insert(trackRow)
      .select("id")
      .single();

    if (trackError || !track) {
      throw new TrackGenerationError(trackError?.message ?? "Failed to create track");
    }

    const trackId = track.id as string;

    const validCols: KanbanColumn[] = ["backlog", "learn", "review", "done"];
    const milestoneRows = parsed.milestones.map((m, i) => {
      const valid = validCols.includes(m.column as KanbanColumn);
      // Counted, not just corrected: how often a model names a column that
      // isn't real is a model-quality signal, and it is the difference between
      // what the model meant and what the learner was shown.
      if (!valid) record.columns_coerced++;
      return {
        track_id:      trackId,
        title:         m.title,
        summary:       m.summary,
        kanban_column: valid ? (m.column as KanbanColumn) : "backlog",
        position:      i,
      };
    });

    // The insert is checked, and the returned rows are counted. Dropping either
    // check is what produced a "ready" track with an empty board and no error on
    // any surface — the failure the learner could see but the system could not.
    // `position` comes back too, because the snapshot has to join each row's
    // rank to its place and insert order is not a promise.
    const { data: inserted, error: milestoneError } = await supabase
      .from("milestones")
      .insert(milestoneRows)
      .select("id, position");

    if (milestoneError) {
      await deleteOrphanTrack(supabase, trackId);
      throw new TrackGenerationError(`Failed to save milestones: ${milestoneError.message}`);
    }

    if (!inserted || inserted.length !== milestoneRows.length) {
      await deleteOrphanTrack(supabase, trackId);
      throw new TrackGenerationError(
        `Milestone insert was partial: expected ${milestoneRows.length}, saved ${inserted?.length ?? 0}`,
      );
    }

    record.track_id        = trackId;
    record.milestone_count = milestoneRows.length;

    // One-time agentic backlog ranking. Non-blocking: a failure here must not
    // break track creation — the board simply falls back to no suggested order.
    let assignments: PriorityAssignment[] = [];
    try {
      const priority = await assignBacklogPriority(supabase, trackId, topic, options.beforePriority);
      if (priority) {
        assignments             = priority.assignments;
        record.ranked           = true;
        record.rank_model       = priority.model;
        record.rank_fingerprint = promptFingerprint("backlog.priority");
        record.tokens_in       += priority.inputTokens;
        record.tokens_out      += priority.outputTokens;
        if (!record.is_replay) {
          void logUsage({
            userId,
            model:     priority.model,
            feature:   "tracker/priority",
            tokensIn:  priority.inputTokens,
            tokensOut: priority.outputTokens,
          });
        }
      }
    } catch (err) {
      // `ranked` stays false, which is the whole point of recording it: without
      // it, a track that lost its suggested order is indistinguishable from one
      // that never needed one.
      logSafeError("generateTrack backlog priority", err, [topic]);
    }

    record.milestones_out = buildServedBoard(milestoneRows, inserted, assignments);
    record.outcome        = "ok";

    return trackId;
  } catch (err) {
    record.error_class = errorClassOf(err);
    throw err;
  } finally {
    record.generation_ms = Date.now() - startedAt;
    await writeGenerationRecord(supabase, record);
  }
}

/**
 * The curriculum as the learner receives it: the milestones that were written,
 * each carrying the rank the second model call gave it.
 *
 * Kept out of `generateTrack`'s body because it is the one piece of real
 * branching in the write path, and because what "the output" means is the
 * decision this whole row exists to record.
 */
function buildServedBoard(
  written:     Array<{ title: string; summary: string; kanban_column: KanbanColumn; position: number }>,
  inserted:    Array<{ id: string; position: number }>,
  assignments: readonly PriorityAssignment[],
): ServedMilestone[] {
  const rankById     = new Map(assignments.map(a => [a.id, a]));
  const idByPosition = new Map(inserted.map(row => [row.position, row.id]));

  return written.map(m => {
    const id   = idByPosition.get(m.position);
    const rank = id ? rankById.get(id) : undefined;
    return {
      title:           m.title,
      summary:         m.summary,
      column:          m.kanban_column,
      position:        m.position,
      priority_rank:   rank?.rank   ?? null,
      priority_reason: rank?.reason ?? null,
    };
  });
}
