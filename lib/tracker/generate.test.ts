import { describe, it, expect, vi, beforeEach } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";

// generateTrack is orchestration, not pure logic: it calls Claude, writes two
// tables, and has to leave the database clean when the second write fails.
// Those failure paths are the ones that shipped a "ready" track with an empty
// board, so they are what this file exercises.

const { messagesCreate, logUsageMock, assignBacklogPriorityMock } = vi.hoisted(() => ({
  messagesCreate:            vi.fn(),
  logUsageMock:              vi.fn(),
  assignBacklogPriorityMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

// lib/usage is `import "server-only"`, which will not load under Vitest.
vi.mock("@/lib/usage", () => ({ logUsage: logUsageMock }));
vi.mock("@/lib/tracker/priority", () => ({ assignBacklogPriority: assignBacklogPriorityMock }));

const { generateTrack, TrackGenerationError } = await import("./generate");

describe("prompt-sized background admission", () => {
  it("refuses generation before the model or track writes", async () => {
    const beforeGeneration = vi.fn().mockRejectedValue(new Error("budget refused"));
    const { client, spy } = makeSupabase({});
    await expect(generateTrack(client, "user-1", "SQL", "goal", undefined, { beforeGeneration })).rejects.toThrow("budget refused");
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(spy.trackRowWritten).toBeNull();
    expect(beforeGeneration).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 2048, messages: expect.any(Array) }), 2);
  });

  it("reserves both generation attempts and passes the separate ranking guard", async () => {
    const beforeGeneration = vi.fn().mockResolvedValue(undefined);
    const beforePriority = vi.fn().mockResolvedValue(undefined);
    messagesCreate.mockResolvedValueOnce(claudeReply({ nonsense: true })).mockResolvedValueOnce(claudeReply(THREE_MILESTONES));
    const { client } = makeSupabase({});
    await generateTrack(client, "user-1", "SQL", "goal", undefined, { beforeGeneration, beforePriority });
    expect(beforeGeneration).toHaveBeenCalledOnce();
    expect(beforeGeneration).toHaveBeenCalledWith(messagesCreate.mock.calls[0][0], 2);
    expect(messagesCreate).toHaveBeenCalledTimes(2);
    for (const call of messagesCreate.mock.calls) expect(call[1]).toEqual({ maxRetries: 0 });
    expect(assignBacklogPriorityMock).toHaveBeenCalledWith(client, "track-1", "SQL", beforePriority);
  });
});

// -- Fixtures ---------------------------------------------------------------

const THREE_MILESTONES = {
  trackTitle: "Window Functions in SQL",
  milestones: [
    { title: "Frames and partitions", summary: "How a window is defined.",      column: "learn"   },
    { title: "Ranking functions",     summary: "ROW_NUMBER, RANK, DENSE_RANK.",  column: "backlog" },
    { title: "Running totals",        summary: "Cumulative sums over a frame.",  column: "backlog" },
  ],
};

function claudeReply(payload: unknown, tokensIn = 100, tokensOut = 50) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    usage:   { input_tokens: tokensIn, output_tokens: tokensOut },
  };
}

interface Script {
  trackInsert?:     { data: { id: string } | null; error: { message: string } | null };
  milestoneInsert?: { data: { id: string; position: number }[] | null; error: { message: string } | null };
  trackDelete?:     { error: { message: string } | null };
  goalAnswers?:     { data: Array<{ question: string; answer: string }> | null; error: { message: string } | null };
}

interface Spy {
  deletedTrackIds:      string[];
  milestoneRowsWritten: number;
  trackRowWritten:      Record<string, unknown> | null;
  generationRows:       Record<string, unknown>[];
}

// A hand-rolled stand-in for the query chains generateTrack actually uses:
//   tracks:            .insert(row).select("id").single()  and  .delete().eq("id", ...)
//   milestones:        .insert(rows).select("id, position")
//   goal_answers:      .select(...).eq(...).order(...)
//   track_generations: .insert(row)
// Anything else throws, so a change in the module's query shape fails loudly
// here rather than silently passing against a permissive mock.
function makeSupabase(script: Script): { client: SupabaseClient; spy: Spy } {
  const spy: Spy = {
    deletedTrackIds:      [],
    milestoneRowsWritten: 0,
    trackRowWritten:      null,
    generationRows:       [],
  };

  const client = {
    from(table: string) {
      if (table === "tracks") {
        return {
          insert(row: Record<string, unknown>) {
            spy.trackRowWritten = row;
            return {
              select: () => ({
                single: async () =>
                  script.trackInsert ?? { data: { id: "track-1" }, error: null },
              }),
            };
          },
          delete: () => ({
            eq: async (_column: string, id: string) => {
              spy.deletedTrackIds.push(id);
              return script.trackDelete ?? { error: null };
            },
          }),
        };
      }
      if (table === "milestones") {
        return {
          insert(rows: unknown[]) {
            spy.milestoneRowsWritten = rows.length;
            return {
              select: async () =>
                script.milestoneInsert ?? {
                  data:  rows.map((_, i) => ({ id: `m-${i}`, position: i })),
                  error: null,
                },
            };
          },
        };
      }
      // Provenance (migration 048). Read to measure the learner's answers,
      // written once per generation on both the success and failure branch.
      if (table === "goal_answers") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => script.goalAnswers ?? { data: [], error: null },
            }),
          }),
        };
      }
      if (table === "track_generations") {
        return {
          insert: async (row: Record<string, unknown>) => {
            spy.generationRows.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };

  return { client: client as unknown as SupabaseClient, spy };
}

beforeEach(() => {
  messagesCreate.mockReset();
  logUsageMock.mockReset();
  assignBacklogPriorityMock.mockReset();
  assignBacklogPriorityMock.mockResolvedValue(null);
});

// -- Happy path -------------------------------------------------------------

describe("generateTrack - the successful build", () => {
  it("returns the track id and writes every milestone the model produced", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({});

    const trackId = await generateTrack(client, "user-1", "SQL window functions");

    expect(trackId).toBe("track-1");
    expect(spy.milestoneRowsWritten).toBe(3);
    expect(spy.deletedTrackIds).toEqual([]);
  });

  it("links the track to the goal when a goalId is supplied, and omits it otherwise", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));

    const withGoal = makeSupabase({});
    await generateTrack(withGoal.client, "user-1", "SQL", "goal-9");
    expect(withGoal.spy.trackRowWritten).toMatchObject({ goal_id: "goal-9" });

    const without = makeSupabase({});
    await generateTrack(without.client, "user-1", "SQL");
    expect(without.spy.trackRowWritten).not.toHaveProperty("goal_id");
  });
});

// -- The bug this file exists for -------------------------------------------

describe("generateTrack - a failed milestone insert must not look like success", () => {
  it("throws instead of returning a track id whose board would be empty", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client } = makeSupabase({
      milestoneInsert: { data: null, error: { message: "permission denied for table milestones" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toBeInstanceOf(TrackGenerationError);
  });

  it("deletes the track it just created, so no orphan row is left behind", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({
      milestoneInsert: { data: null, error: { message: "insert failed" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toThrow();
    expect(spy.deletedTrackIds).toEqual(["track-1"]);
  });

  it("treats a partial insert as a failure - three asked for, two saved", async () => {
    // Postgres can accept some rows and reject others under a constraint. Two
    // thirds of a curriculum is not a curriculum, and the learner has no way to
    // tell which third is missing.
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({
      milestoneInsert: { data: [{ id: "m-0", position: 0 }, { id: "m-1", position: 1 }], error: null },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toThrow(/expected 3, saved 2/);
    expect(spy.deletedTrackIds).toEqual(["track-1"]);
  });

  it("still throws when the orphan cleanup itself fails", async () => {
    // A failed cleanup is worse, not better: the caller must still learn that
    // the track is unusable.
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client } = makeSupabase({
      milestoneInsert: { data: null, error: { message: "insert failed" } },
      trackDelete:     { error: { message: "delete failed too" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toBeInstanceOf(TrackGenerationError);
  });
});

describe("generateTrack - a failed track insert", () => {
  it("throws and never attempts a milestone write or a cleanup", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({
      trackInsert: { data: null, error: { message: "duplicate key" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toBeInstanceOf(TrackGenerationError);
    expect(spy.milestoneRowsWritten).toBe(0);
    expect(spy.deletedTrackIds).toEqual([]);
  });
});

// -- Accounting -------------------------------------------------------------

describe("generateTrack - spend is recorded whatever the database does", () => {
  it("logs the Claude spend even when the milestone insert then fails", async () => {
    // The tokens were bought before the write was attempted. A failed build
    // that bills nothing under-states real spend (CLAUDE.md, usage accounting).
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES, 900, 400));
    const { client } = makeSupabase({
      milestoneInsert: { data: null, error: { message: "insert failed" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toThrow();
    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "tracker/generate", tokensIn: 900, tokensOut: 400 }),
    );
  });

  it("bills both attempts when the first response is unparseable", async () => {
    messagesCreate
      .mockResolvedValueOnce(claudeReply({ trackTitle: "", milestones: [] }, 700, 20))
      .mockResolvedValueOnce(claudeReply(THREE_MILESTONES, 700, 300));
    const { client } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokensIn: 1400, tokensOut: 320 }),
    );
  });

  it("gives up after the second unparseable response without writing anything", async () => {
    messagesCreate.mockResolvedValue(claudeReply({ nonsense: true }));
    const { client, spy } = makeSupabase({});

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toThrow();
    expect(spy.trackRowWritten).toBeNull();
    expect(messagesCreate).toHaveBeenCalledTimes(2);
  });
});

// -- Non-blocking extras ----------------------------------------------------

describe("generateTrack - backlog ranking is best-effort", () => {
  it("still returns a usable track when the ranking call throws", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    assignBacklogPriorityMock.mockRejectedValue(new Error("ranking exploded"));
    const { client } = makeSupabase({});

    await expect(generateTrack(client, "user-1", "SQL")).resolves.toBe("track-1");
  });

  it("logs ranking spend separately when the ranking call succeeds", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    assignBacklogPriorityMock.mockResolvedValue({
      model: "claude-haiku-4-5", inputTokens: 120, outputTokens: 40,
      assignments: [{ id: "m-1", rank: 1, reason: "foundational" }],
    });
    const { client } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(logUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "tracker/priority", model: "claude-haiku-4-5" }),
    );
  });
});

// -- Provenance (migration 048) ---------------------------------------------

describe("generateTrack - the provenance row", () => {
  it("writes exactly one row on a successful build", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL window functions", "goal-9");

    expect(spy.generationRows).toHaveLength(1);
    expect(spy.generationRows[0]).toMatchObject({
      user_id:     "user-1",
      goal_id:     "goal-9",
      track_id:    "track-1",
      source_kind: "qa",
      outcome:     "ok",
      input_topic: "SQL window functions",
      attempts:    1,
    });
  });

  it("writes a row on the failure branch too - a failed generation is a data point", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({
      milestoneInsert: { data: null, error: { message: "permission denied" } },
    });

    await expect(generateTrack(client, "user-1", "SQL")).rejects.toBeInstanceOf(TrackGenerationError);

    expect(spy.generationRows).toHaveLength(1);
    expect(spy.generationRows[0]).toMatchObject({
      outcome:     "failed",
      error_class: "TrackGenerationError",
      track_id:    null,
    });
  });

  it("records the retry count, which exists in no other store", async () => {
    // usage_logs folds both attempts into one row, so this is the only place
    // "the model needed a second try" is written down.
    messagesCreate
      .mockResolvedValueOnce(claudeReply({ nonsense: true }))
      .mockResolvedValueOnce(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(spy.generationRows[0]).toMatchObject({ attempts: 2 });
  });

  it("names the document branch as its own prompt, and marks the source", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const qa  = makeSupabase({});
    const doc = makeSupabase({});

    await generateTrack(qa.client,  "user-1", "SQL", "goal-1");
    await generateTrack(doc.client, "user-1", "SQL", "goal-1", "extracted document text");

    expect(qa.spy.generationRows[0]).toMatchObject({ source_kind: "qa" });
    expect(doc.spy.generationRows[0]).toMatchObject({ source_kind: "document" });
    // Two structurally different prompts must not share one identity.
    expect(qa.spy.generationRows[0].prompt_fingerprint)
      .not.toBe(doc.spy.generationRows[0].prompt_fingerprint);
  });

  it("counts milestones the model filed under a column that isn't real", async () => {
    messagesCreate.mockResolvedValue(claudeReply({
      trackTitle: "T",
      milestones: [
        { title: "a", summary: "s", column: "learn" },
        { title: "b", summary: "s", column: "study" },   // not a kanban column
        { title: "c", summary: "s", column: "someday" }, // nor this
      ],
    }));
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(spy.generationRows[0]).toMatchObject({ columns_coerced: 2 });
  });

  it("snapshots the board as served, with the ranking the learner sees", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    assignBacklogPriorityMock.mockResolvedValue({
      model: "claude-sonnet-4-6", inputTokens: 100, outputTokens: 30,
      assignments: [{ id: "m-2", rank: 1, reason: "needed first" }],
    });
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    const row   = spy.generationRows[0] as { milestones_out: Array<Record<string, unknown>> };
    const ranked = row.milestones_out.find(m => m.position === 2);

    // The rank is applied by UPDATE after the insert, so a snapshot taken from
    // the generation parse alone would have no order in it at all.
    expect(ranked).toMatchObject({ priority_rank: 1, priority_reason: "needed first" });
    expect(row.milestones_out.find(m => m.position === 0)).toMatchObject({ priority_rank: null });
  });

  it("records that ranking failed, so a partial failure is not a clean success", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    assignBacklogPriorityMock.mockRejectedValue(new Error("ranking exploded"));
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(spy.generationRows[0]).toMatchObject({
      outcome:    "ok",     // the track is fine
      ranked:     false,    // but the learner got no suggested order
      rank_model: null,
    });
  });

  it("sums both model calls into the token columns", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES, 1000, 200));
    assignBacklogPriorityMock.mockResolvedValue({
      model: "claude-sonnet-4-6", inputTokens: 120, outputTokens: 40, assignments: [],
    });
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL");

    expect(spy.generationRows[0]).toMatchObject({ tokens_in: 1120, tokens_out: 240 });
  });

  it("measures the learner's answers without copying them", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({
      goalAnswers: {
        data: [
          { question: "Why?", answer: "I keep breaking window functions at work" },
          { question: "Why?", answer: "partitions confuse me" },
        ],
        error: null,
      },
    });

    await generateTrack(client, "user-1", "SQL", "goal-9");

    const row = spy.generationRows[0];
    expect(row).toMatchObject({ answer_count: 2, context_used: false });
    expect(row.answer_chars).toBeGreaterThan(0);
    expect(row.context_uptake).not.toBeNull();

    // The whole point of R4: numbers, never the words.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain("keep breaking window functions");
    expect(serialised).not.toContain("partitions confuse me");
  });

  it("does not bill a replay to a learner, because usage_logs cannot hold it", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client, spy } = makeSupabase({});

    await generateTrack(client, "user-1", "SQL", undefined, undefined, { isReplay: true });

    expect(logUsageMock).not.toHaveBeenCalled();
    expect(spy.generationRows[0]).toMatchObject({ is_replay: true, tokens_in: 100 });
  });

  it("never lets a failed provenance write break the build", async () => {
    messagesCreate.mockResolvedValue(claudeReply(THREE_MILESTONES));
    const { client } = makeSupabase({});
    const original = client.from.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).from = (table: string) =>
      table === "track_generations"
        ? { insert: async () => { throw new Error("provenance table is gone"); } }
        : original(table);

    await expect(generateTrack(client, "user-1", "SQL")).resolves.toBe("track-1");
  });
});
