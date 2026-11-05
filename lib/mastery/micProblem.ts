/**
 * Why the browser's speech recognition stopped, in terms a learner can act on.
 *
 * Mastery's only input is the mic, so a mic that has stopped must not look like
 * one that is waiting (CLAUDE.md rule 5). Pure, so the mapping is tested without
 * a browser.
 */
export type MicProblem = "blocked" | "no-mic" | "no-service";

/**
 * The problem behind a SpeechRecognition `error` code, or null when the code is
 * an expected event: `no-speech` is silence and `aborted` is us stopping it. An
 * unknown code counts as the service failing, so nothing new can pass for
 * listening.
 */
export function micProblemFor(error: string): MicProblem | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "blocked";
    case "audio-capture":
      return "no-mic";
    default:
      return "no-service";
  }
}

export const MIC_PROBLEM_MESSAGE: Record<MicProblem, string> = {
  blocked:      "Your browser has blocked the microphone, so Hugh can't hear you. Allow it for this site, then try again.",
  "no-mic":     "Hugh can't find a microphone. Connect one, then try again.",
  "no-service": "Your browser's speech service isn't answering, so Hugh can't hear you. Check your connection, then try again.",
};
