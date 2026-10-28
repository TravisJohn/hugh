/**
 * Turn one Hugh text call into one `claude -p` invocation.
 *
 * The aim is parity with the API call the route would otherwise make: same
 * model, same system prompt, same output ceiling, no thinking, no tools, and
 * nothing from the owner's own Claude Code setup in the prompt. Every switch
 * below was checked against a recorded run (docs/claude-subscription-local-mode.md §8).
 *
 * Pure: no process, no filesystem. The runner writes the system prompt to the
 * file named here and feeds `prompt` on stdin — Windows caps a command line at
 * 32,767 characters, and Hugh's syllabus-grounded system prompts are longer.
 *
 * No `server-only` import, on purpose: `lib/tracker/generateMilestones.ts` reaches
 * this module and is also run by offline `tsx` scripts.
 */
import type { TextCall, TextMessage } from "../textInput";

/**
 * Used when a call has no system prompt. Claude Code substitutes its own
 * coding-agent prompt when given none, which would be a far bigger departure
 * from the API call (which has no system prompt at all) than one neutral line.
 */
export const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";

/** The Anthropic SDK's default, used when a caller does not pass `maxRetries`. */
const SDK_DEFAULT_RETRIES = 2;

export interface CliInvocation {
  args: string[];
  /** Claude Code switches only; `childEnv` adds the OS basics and the config dir. */
  env: Record<string, string>;
  systemPrompt: string;
  prompt: string;
  /** The call asked for a cache breakpoint the CLI cannot express. Reported, not hidden. */
  droppedCacheHint: boolean;
}

/**
 * Build the invocation. `maxRetries` mirrors the SDK option of the same name:
 * the usage gate admits one attempt at a time and passes 0, and Claude Code's
 * own default of 10 would otherwise multiply that one admitted call.
 */
export function buildInvocation(call: TextCall, systemPromptFile: string, maxRetries?: number): CliInvocation {
  const retries = maxRetries === undefined ? SDK_DEFAULT_RETRIES : Math.max(0, Math.floor(maxRetries));
  return {
    args: [
      "-p",
      "--model", call.model,
      "--output-format", "stream-json", "--verbose",
      "--system-prompt-file", systemPromptFile,
      "--tools", "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--max-turns", "1",
    ],
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS:          String(call.max_tokens),
      CLAUDE_CODE_MAX_RETRIES:                String(retries),
      // Today's API calls send no `thinking` parameter, so these models do not think.
      MAX_THINKING_TOKENS:                    "0",
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING:  "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS:         "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY:        "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // Also skips the background model call that titles a session.
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE:     "1",
    },
    systemPrompt: call.system?.trim() ? call.system : NEUTRAL_SYSTEM_PROMPT,
    prompt: renderPrompt(call.messages),
    droppedCacheHint: call.cache_control !== undefined,
  };
}

const TRANSCRIPT_PREAMBLE =
  "Below is the conversation so far, oldest turn first. Write the assistant's next " +
  "reply to the final user turn, following your instructions exactly. Output only that reply.";

/**
 * The CLI takes one prompt, not a message list, so the conversation is written
 * out as a marked transcript.
 *
 * A single message gets the same shape, deliberately. Passed bare, 8 of 17
 * single-message Ask Hugh samples came back as something other than clean
 * JSON; with every call in this shape, strict JSON rose from 12 to 16 of 20
 * (stage 6 contract check, docs §13). Claude Code adds its own notes after
 * Hugh's instructions, and the preamble's "following your instructions
 * exactly" points the model back at them.
 *
 * A closing tag inside a turn is escaped so text that happens to contain
 * `</user>` cannot end its own turn early and impersonate the next one.
 */
export function renderPrompt(messages: readonly TextMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) throw new Error("A Claude call needs at least one message.");
  if (last.role !== "user") throw new Error("A Claude call must end with a user turn.");

  const turns = messages.map(m =>
    `<${m.role}>\n${m.content.replace(/<\/(user|assistant)>/gi, "<\\/$1>")}\n</${m.role}>`,
  );
  return `${TRANSCRIPT_PREAMBLE}\n\n${turns.join("\n\n")}`;
}

/**
 * OS variables the binary needs to start and find its own files on Windows.
 * An allow-list, not a deny-list: Hugh's server holds the Anthropic key, the
 * Supabase service-role key and the OpenAI key, and `claude -p` bills any
 * ANTHROPIC_API_KEY it can see. Nothing outside this list reaches the child.
 */
const OS_VARS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "USERNAME",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "TEMP", "TMP", "LANG",
]);

/**
 * The child's whole environment. Windows environment names are
 * case-insensitive (`Path` and `PATH` are one variable), so they are matched
 * upper-cased; the invocation's switches and the config dir are applied last.
 */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  configDir: string,
  invocationEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && OS_VARS.has(name.toUpperCase())) env[name] = value;
  }
  return { ...env, ...invocationEnv, CLAUDE_CONFIG_DIR: configDir };
}
