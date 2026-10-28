/**
 * Run one plan-served call through the installed `claude` binary.
 *
 * The only part of subscription mode that touches a process or the disk.
 * Everything it decides is delegated: the invocation to `cliArgs`, the reading
 * of the output to `parseResult`. What it owns is the lifecycle, and two
 * tripwires that act while the process is still running:
 *
 *   • If the start-up event names any credential but the plan, the process is
 *     killed at once — before it can send a request an API key would pay for.
 *   • If the CLI starts its automatic "Output token limit hit" continuations,
 *     it is killed at the first one. Each continuation re-sends the whole
 *     prompt against the plan's limits, and the API would have stopped there.
 *
 * No `server-only` import, on purpose: see `cliArgs.ts`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type Anthropic from "@anthropic-ai/sdk";
import type { TextCall } from "../textInput";
import { buildInvocation, childEnv, type CliInvocation } from "./cliArgs";
import { parseEventLine, initApiKeySource, isContinuation, PLAN_KEY_SOURCE, toMessage, type CliEvent } from "./parseResult";
import { SubscriptionCallError } from "./errors";

export interface RunnerConfig {
  /** The program to start, normally "claude". */
  command: string;
  /** Arguments placed before the invocation's own; lets a test run a stand-in script with node. */
  commandArgs: readonly string[];
  /** The Hugh-only Claude login (`CLAUDE_CONFIG_DIR`). */
  configDir: string;
  timeoutMs: number;
  /** Concurrent processes allowed; further calls queue. */
  maxConcurrent: number;
}

// A plain counting semaphore. A track build and an Ask turn can overlap; a
// burst of processes would only spend the plan's limits faster.
let running = 0;
const queue: Array<() => void> = [];

async function acquire(limit: number): Promise<void> {
  if (running < limit) {
    running++;
    return;
  }
  // The releasing call hands its slot straight over, so `running` is unchanged.
  await new Promise<void>(resolve => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) next();
  else running--;
}

// Said once per process: learn/chat sends a cache hint on every turn, and the
// fact doesn't change between them.
let reportedCacheHint = false;

function reportDroppedCacheHint(invocation: CliInvocation): void {
  if (!invocation.droppedCacheHint || reportedCacheHint) return;
  reportedCacheHint = true;
  console.info("[subscription] cache_control is not applied on the plan path; Claude Code manages its own prompt cache.");
}

export async function runClaudeCli(
  call: TextCall,
  maxRetries: number | undefined,
  config: RunnerConfig,
): Promise<Anthropic.Message> {
  await acquire(config.maxConcurrent);
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "hugh-claude-"));
    const systemFile = join(dir, "system.txt");
    const invocation = buildInvocation(call, systemFile, maxRetries);
    reportDroppedCacheHint(invocation);
    await writeFile(systemFile, invocation.systemPrompt, "utf8");
    const run = await runProcess(config, dir, invocation);
    return toMessage(run.events, { maxTokens: call.max_tokens, stoppedAtContinuation: run.stoppedAtContinuation });
  } finally {
    if (dir) {
      // A leftover temp folder holds one system prompt and is not worth failing
      // an answered call over — but it is reported, not ignored.
      await rm(dir, { recursive: true, force: true })
        .catch(error => console.warn(`[subscription] could not remove ${dir}:`, error));
    }
    release();
  }
}

type StopReason = "billed" | "continuation" | "timeout";

function runProcess(
  config: RunnerConfig,
  cwd: string,
  invocation: CliInvocation,
): Promise<{ events: CliEvent[]; stoppedAtContinuation: boolean }> {
  return new Promise((resolve, reject) => {
    // Next.js declares NODE_ENV as always present on `process.env`. That holds
    // for Hugh's own process, not a child's: the allow-list leaves it out on
    // purpose, so the CLI never runs in "development" because Hugh does.
    const env = childEnv(process.env, config.configDir, invocation.env) as NodeJS.ProcessEnv;
    // stdin, stdout and stderr are all pipes by default.
    const child = spawn(config.command, [...config.commandArgs, ...invocation.args], {
      cwd,
      env,
      windowsHide: true,
    });

    const events: CliEvent[] = [];
    let stderr = "";
    let stopped: StopReason | null = null;
    let reportedSource = "";

    const stop = (why: StopReason) => {
      if (stopped) return;
      stopped = why;
      child.kill();
    };
    const timer = setTimeout(() => stop("timeout"), config.timeoutMs);

    child.on("error", error => {
      clearTimeout(timer);
      reject(new SubscriptionCallError("failed", `Could not start "${config.command}": ${error.message}`));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });

    createInterface({ input: child.stdout }).on("line", line => {
      if (stopped) return;
      const event = parseEventLine(line);
      if (!event) return;
      events.push(event);

      const source = initApiKeySource(event);
      if (source !== null && source !== PLAN_KEY_SOURCE) {
        reportedSource = source;
        stop("billed");
      } else if (isContinuation(event)) {
        stop("continuation");
      }
    });

    child.on("close", () => {
      clearTimeout(timer);
      if (stopped === "timeout") {
        reject(new SubscriptionCallError("timeout", `Claude Code did not finish within ${config.timeoutMs} ms.`));
      } else if (stopped === "billed") {
        reject(new SubscriptionCallError("billed_to_key",
          `Claude Code reported "${reportedSource}" instead of the Claude plan and was stopped before answering.`));
      } else if (events.length === 0) {
        const detail = stderr.trim().slice(0, 300);
        reject(new SubscriptionCallError("failed", `Claude Code produced no output.${detail ? ` ${detail}` : ""}`));
      } else {
        resolve({ events, stoppedAtContinuation: stopped === "continuation" });
      }
    });

    // A process that dies early closes its stdin; the write then fails with
    // EPIPE. The real cause is reported by the close handler above.
    child.stdin.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") console.warn("[subscription] stdin:", error);
    });
    child.stdin.end(invocation.prompt, "utf8");
  });
}
