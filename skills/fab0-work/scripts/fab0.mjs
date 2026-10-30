// fab0-work's client of fab0's /api/v1/work/ (agent interface sections 9 and 12.1), for a routine's session, where
// the plugin's MCP tools aren't installed. It runs under Node 22 or newer, with no dependency.
//
//   node fab0.mjs <operation> --api <api> --token <token> <<'FAB0_BODY'
//   { the operation's body on one line, without the token }
//   FAB0_BODY
//
// It posts the body ({} when standard input is empty) to <api>/work/<operation>, with the step, act or test token as
// the bearer, and prints fab0's answer as JSON. It exits 1 when fab0 answers an error, which it prints as fab0 gives
// it ({ error, message, retryAfter? }), and 2 when it sends nothing. It refuses an api that isn't https, and never
// prints the token.

import { parseArgs } from "node:util";

const OPERATIONS = ["claim_step", "get_envelope", "complete_step", "fail_step", "attach_artifact", "report_act"];
const USAGE = `usage: fab0.mjs <${OPERATIONS.join("|")}> --api https://<host>/api/v1 --token <token> < body.json`;

let token = "";
// What the script prints never holds the token, whatever fab0 or an error says.
const shown = (text) => (token === "" ? text : text.replaceAll(token, "[token]"));

function answer(json, code) {
  process.stdout.write(`${shown(JSON.stringify(json, null, 2))}\n`);
  process.exit(code);
}

function refuse(reason) {
  process.stderr.write(`fab0.mjs: ${shown(reason)}\n${USAGE}\n`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({ options: { api: { type: "string" }, token: { type: "string" } }, allowPositionals: true });
} catch {
  refuse("the arguments aren't an operation, --api and --token");
}
token = args.values.token ?? "";
const [operation, ...rest] = args.positionals;

if (!OPERATIONS.includes(operation) || rest.length > 0) refuse("the operation isn't one of /api/v1/work/'s");
// A step, act or test token: fab0_s_…, fab0_a_… or fab0_t_….
if (!/^fab0_[sat]_[A-Za-z0-9_-]+$/.test(token)) refuse("--token isn't a fab0 step, act or test token");
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
  body = JSON.parse(input.trim() === "" ? "{}" : input);
} catch {
  refuse("the body on standard input isn't JSON");
}
if (typeof body !== "object" || body === null || Array.isArray(body)) refuse("the body isn't a JSON object");

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
try {
  answer(JSON.parse(text), response.ok ? 0 : 1);
} catch {
  answer({ error: "unexpected", message: `fab0 answered ${response.status} with no JSON` }, 1);
}
