import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
const mocks = vi.hoisted(() => ({ ai: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: mocks.ai }; } }));
import { assignBacklogPriority } from "./priority";
import { textReservation, type TextCall } from "@/lib/claude/textInput";

beforeEach(() => vi.clearAllMocks());
function database(summary = "A learner milestone") {
  const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn(), update: vi.fn() };
  for (const key of ["select", "eq", "update"] as const) chain[key].mockReturnValue(chain);
  chain.order.mockResolvedValue({ data: [{ id: "milestone", title: "SQL", summary }] });
  return { from: () => chain } as unknown as SupabaseClient;
}
it("ranking cannot spend when its own admission is denied", async () => {
  await expect(assignBacklogPriority(database(), "track", "SQL", async () => { throw new Error("budget refused"); })).rejects.toThrow("budget refused");
  expect(mocks.ai).not.toHaveBeenCalled();
});
it("bounds the complete ranking prompt including database content", async () => {
  await expect(assignBacklogPriority(database("x".repeat(140000)), "track", "SQL", async call => { textReservation(call); })).rejects.toThrow(/context/);
  expect(mocks.ai).not.toHaveBeenCalled();
});
it("admits the prompt actually sent and disables hidden retries", async () => {
  const guard = vi.fn<(call: TextCall) => Promise<void>>().mockResolvedValue(undefined);
  mocks.ai.mockResolvedValue({ content: [{ type: "text", text: '{"ordered":[{"n":1,"reason":"foundation"}]}' }], usage: { input_tokens: 50, output_tokens: 20 } });
  const result = await assignBacklogPriority(database(), "track", "SQL", guard);
  expect(guard).toHaveBeenCalledWith(mocks.ai.mock.calls[0][0]);
  expect(mocks.ai.mock.calls[0][1]).toEqual({ maxRetries: 0 });
  expect(result?.assignments).toHaveLength(1);
});
