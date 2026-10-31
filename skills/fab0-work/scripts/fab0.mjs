// fab0-work's client of fab0's /api/v1/work/ (agent interface sections 9 and 12.1), for a routine's session, where
// the plugin's MCP tools aren't installed. It runs under Node 22 or newer, with no dependency.
//
//   node fab0.mjs <operation> --api <api> <<'FAB0_BODY'
//   { "token": "<token>", and the rest of the operation's body, on one line }
//   FAB0_BODY
//
// It takes the step, act or test token from the body's `token`, and posts the rest of the body to
// <api>/work/<operation> with the token as the bearer. The token is never this script's argument, which a process
// listing shows (stage 5 spec R5.29); the command's text, heredoc included, still holds it.
//
// It prints fab0's answer as JSON. It exits 1 when fab0 answers an error, which it prints as fab0 gives it
// ({ error, message, retryAfter? }), and 2 when it sends nothing: for an argument other than the operation and --api
// (--token among them), an api that isn't https, a body that isn't a JSON object, or a body whose `token` isn't a fab0
// step, act or test token. It never prints the token, or any part of a body it can't parse.
//
// To complete_step and report_act it adds the session's usage, as the bundled usage.mjs reads it from the transcript,
// unless the body holds `usage` (stage 5 spec R5.18). It sends only each row's difference from what fab0 has accepted
// from this session, kept in a file under the system's temporary directory named by CLAUDE_CODE_SESSION_ID and written
// only after an `accepted` answer. When usage.mjs fails, prints nothing or prints something that isn't usage, or takes
// over 10 seconds, the report is sent without usage.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OPERATIONS = ["claim_step", "get_envelope", "complete_step", "fail_step", "attach_artifact", "report_act"];
const USAGE = `usage: fab0.mjs <${OPERATIONS.join("|")}> --api https://<host>/api/v1 <<< '{ "token": "<token>", … }'`;

// fab0's answer, as JSON. It never holds the token, whatever fab0 or an error says. Called only once `token` is set.
function answer(json, code) {
  process.stdout.write(`${JSON.stringify(json, null, 2).replaceAll(token, "[token]")}\n`);
  process.exit(code);
}

// A refusal's reason never quotes the arguments or the body.
function refuse(reason) {
  process.stderr.write(`fab0.mjs: ${reason}\n${USAGE}\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({ options: { api: { type: "string" } }, allowPositionals: true });
} catch {
  refuse(`the arguments aren't an operation and --api; the token goes in the body's "token"`);
}
const [operation, ...rest] = args.positionals;

if (!OPERATIONS.includes(operation) || rest.length > 0) refuse("the operation isn't one of /api/v1/work/'s");
let api;
try {
  api = new URL(args.values.api ?? "");
} catch {
  refuse("--api isn't a URL");
}
if (api.protocol !== "https:") refuse("--api must be an https URL");
if (api.username !== "" || api.password !== "" || api.search !== "" || api.hash !== "")
  refuse("--api must be https://<host>/api/v1, with no credentials, query or fragment");

let input = "";
if (!process.stdin.isTTY) for await (const chunk of process.stdin) input += chunk;
let body;
try {
  body = JSON.parse(input);
} catch {
  refuse("the body on standard input isn't JSON");
}
if (typeof body !== "object" || body === null || Array.isArray(body)) refuse("the body isn't a JSON object");
// A step, act or test token: fab0_s_…, fab0_a_… or fab0_t_…. It is sent as the bearer only, never in the body.
if (typeof body.token !== "string" || !/^fab0_[sat]_[A-Za-z0-9_-]+$/.test(body.token))
  refuse(`the body's "token" isn't a fab0 step, act or test token`);
const token = body.token;
delete body.token;

// The session's usage: a row per model and `long`, as fab0's Usage.
const COUNTS = ["input", "output", "cacheRead", "cacheWrite"];
const keyOf = (row) => JSON.stringify([row.model, row.long === true]);
const isRow = (row) =>
  typeof row?.model === "string" &&
  (row.long === undefined || row.long === true) &&
  COUNTS.every((count) => Number.isSafeInteger(row[count]) && row[count] >= 0);
const rowOf = (row, count) => ({
  model: row.model,
  ...Object.fromEntries(COUNTS.map((name) => [name, count(name)])),
  ...(row.long && { long: true }),
});
const rowsIn = (text) => {
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) && rows.every(isRow) ? rows : [];
  } catch {
    return [];
  }
};

// usage.mjs runs as its own process, since it exits when it finds no transcript. Its error, timeout or partial output
// is no usage.
function sessionUsage() {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("usage.mjs", import.meta.url))], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    // SIGKILL, so a usage.mjs that ignores SIGTERM can't hold the report back.
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  return run.status === 0 ? rowsIn(run.stdout) : [];
}

// The record of what fab0 has accepted from this session; encoded, any session id is one file name.
const session = process.env.CLAUDE_CODE_SESSION_ID ?? "";
const record = join(tmpdir(), `fab0-usage-${encodeURIComponent(session)}.json`);
// The rows fab0 will have accepted from this session once it accepts this report, and the rows this report adds.
const kept = new Map();
const added = [];
if (["complete_step", "report_act"].includes(operation) && !Object.hasOwn(body, "usage") && session !== "") {
  try {
    for (const row of rowsIn(readFileSync(record, "utf8"))) kept.set(keyOf(row), row);
  } catch {
    // No record yet: nothing accepted.
  }
  for (const row of sessionUsage()) {
    const key = keyOf(row);
    const before = kept.get(key);
    const more = rowOf(row, (name) => Math.max(0, row[name] - (before?.[name] ?? 0)));
    if (!COUNTS.some((name) => more[name] > 0)) continue;
    added.push(more);
    kept.set(
      key,
      rowOf(row, (name) => Math.max(row[name], before?.[name] ?? 0)),
    );
  }
  if (added.length > 0) body.usage = added;
}

let response;
try {
  response = await fetch(`${api.href.replace(/\/+$/, "")}/work/${operation}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    // A redirect would carry the bearer elsewhere.
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
} catch (error) {
  answer({ error: "unreachable", message: String(error?.message ?? error) }, 1);
}

const text = await response.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  answer({ error: "unexpected", message: `fab0 answered ${response.status} with no JSON` }, 1);
}
// Only an accepted report's usage counts as sent; a refused or failed one's is sent again with the next. The record is
// written to a new file beside it and renamed over it, so a reader never sees half a record.
if (added.length > 0 && response.ok && json?.answer === "accepted") {
  const next = `${record}.${randomUUID()}`;
  try {
    writeFileSync(next, JSON.stringify([...kept.values()]), { mode: 0o600, flag: "wx" });
    renameSync(next, record);
  } catch {
    // A record that can't be written stays as it was, so the next report sends these rows again, and fab0 counts
    // them twice: more usage rather than none.
    rmSync(next, { force: true });
  }
}
answer(json, response.ok ? 0 : 1);
