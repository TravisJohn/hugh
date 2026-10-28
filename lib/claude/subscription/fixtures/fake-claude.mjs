// A stand-in for `claude -p`, used only by runClaudeCli.test.ts.
//
// The system prompt names what to do, because the runner's environment
// allow-list (correctly) passes no test-only variable through:
//   fixture:<name>  replay fixtures/<name>.jsonl; after an API-key start-up
//                   event or a synthetic continuation, keep "running" for 10 s
//                   as the real CLI would, so the runner has to kill it
//   echo            answer with the prompt read from stdin
//   env             answer with this process's environment names and cwd
//   hang            print nothing for 10 s
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const mode = readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8").trim();
const stdin = await new Promise(resolve => {
  let data = "";
  process.stdin.setEncoding("utf8").on("data", c => (data += c)).on("end", () => resolve(data));
});

const print = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const answer = text => {
  print({ type: "system", subtype: "init", apiKeySource: "none", model: "claude-haiku-4-5" });
  print({ type: "result", subtype: "success", is_error: false, result: text, stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 } });
};

if (mode === "hang") {
  await sleep(10_000);
} else if (mode === "echo") {
  answer(stdin);
} else if (mode === "env") {
  answer(JSON.stringify({ names: Object.keys(process.env), cwd: process.cwd() }));
} else if (mode.startsWith("fixture:")) {
  const file = new URL(`./${mode.slice("fixture:".length)}.jsonl`, import.meta.url);
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    process.stdout.write(`${line}\n`);
    const event = JSON.parse(line);
    const keyed = event.subtype === "init" && event.apiKeySource !== "none";
    if (keyed || (event.type === "user" && event.isSynthetic)) await sleep(10_000);
  }
}
