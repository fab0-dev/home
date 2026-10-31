// The session's token usage, for complete_step's `usage` in a routine (J.5, agent interface section 12.1). It runs
// under Node 22 or newer, with no dependency.
//
//   node usage.mjs
//
// It reads the newest ~/.claude/projects/*/<session>.jsonl, the transcript Claude Code writes for the session that
// CLAUDE_CODE_SESSION_ID names, and sums each model's input, output, cache-read and cache-write tokens over its
// assistant messages, counting each message id once. A message whose prompt, its input, cache-read and cache-write
// tokens, is over 100,000 tokens is summed in a row of its own for its model, with `long: true`, since some models are
// priced higher for it (stage 5 spec R5.18). It prints them as JSON, as fab0's Usage:
//
//   [{ "model": "...", "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, { ..., "long": true }]
//
// With no session, no transcript or no assistant message, it prints nothing: no usage, never zeros.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Claude Code writes a session's transcript directly in its project's folder, ~/.claude/projects/<project>/, beside
// the session's own folder of subagents and tool results, which aren't read.
function transcript(session) {
  const projects = join(homedir(), ".claude", "projects");
  let newest;
  let at = -1;
  try {
    for (const project of readdirSync(projects)) {
      const path = join(projects, project, `${session}.jsonl`);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isFile() && stat.mtimeMs > at) [newest, at] = [path, stat.mtimeMs];
    }
  } catch {
    return undefined;
  }
  return newest;
}

const session = process.env.CLAUDE_CODE_SESSION_ID ?? "";
const path = session === "" ? undefined : transcript(session);
if (path === undefined) process.exit(0);

// A message is written once per content block, each line with the message's usage so far: the last line counts.
const messages = new Map();
for (const line of readFileSync(path, "utf8").split("\n")) {
  // Only assistant lines carry usage; the rest, often most of the bytes, aren't parsed.
  if (!line.includes('"assistant"')) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  const message = entry?.message;
  if (entry?.type !== "assistant" || entry.isSidechain === true || typeof message?.id !== "string") continue;
  if (typeof message.model !== "string" || message.model === "<synthetic>" || typeof message.usage !== "object")
    continue;
  messages.set(message.id, { model: message.model, usage: message.usage });
}

// A row per model and per whether the message's prompt is long.
const LONG = 100_000;
const rows = new Map();
for (const { model, usage } of messages.values()) {
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const long = input + cacheRead + cacheWrite > LONG;
  const key = JSON.stringify([model, long]);
  const sum = rows.get(key) ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(long && { long }) };
  sum.input += input;
  sum.output += usage.output_tokens ?? 0;
  sum.cacheRead += cacheRead;
  sum.cacheWrite += cacheWrite;
  rows.set(key, sum);
}
if (rows.size > 0) process.stdout.write(`${JSON.stringify([...rows.values()])}\n`);
