import { claudeClient } from "@/lib/claude/client";
import { sessionAssessmentPrompt, parseClaudeJson } from "./prompts";
import type { Room } from "@/types";

const anthropic = claudeClient();

export interface QAPair {
  question:       string;
  transcript:     string;
  feedback:       string;
  usedBestAnswer: boolean;
}

export async function generateSessionAssessment(
  room: Room,
  questionsAndAnswers: QAPair[],
): Promise<string> {
  const res = await anthropic.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [
      {
        role:    "user",
        content: sessionAssessmentPrompt({ room, questionsAndAnswers }),
      },
    ],
  });

  const text = res.content[0].type === "text" ? res.content[0].text : "";
  const parsed = parseClaudeJson<{ assessment: string }>(text);
  return parsed.assessment;
}
