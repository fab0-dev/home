#!/usr/bin/env node
// Prepares a GitHub organization for a fab0 pipeline (ARCHITECTURE O.1, spec R6.17): the issue types its items
// take, and in each repository the status labels its steps move them through, with fab0/pause and fab0/cancel.
// It reads what exists first, makes only what is missing, and changes nothing that exists, so a second run writes
// nothing. It prints its plan, and writes only with --apply.
//
// It runs as a person who may make issue types and labels (an organization owner), never as the fab0 App, which
// only reads (B.15). The token comes from GH_TOKEN or `gh auth token` and is never printed (M.2). It needs Node
// alone: no package to install. Released to fab0-dev/home's setup/ by fab0's release-home workflow.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const USAGE = `Usage: node fab0-setup.mjs <organization> <repository> [<repository> ...] [options]

Prepares a GitHub organization for a fab0 pipeline: the issue types its items
take, and in each repository the status labels its steps move them through,
with fab0/pause and fab0/cancel. It reads what exists, plans what is missing,
and changes nothing that exists. Nothing is written without --apply.

Options:
  --labels <a,b,...>  the status labels (default: Todo,Ready,InProgress,InReview,Done)
  --types <a,b,...>   the issue types (default: Feature,Story,Task)
  --apply             make the changes the plan lists
  --help              show this help

Run it as an organization owner. It takes the token from GH_TOKEN, or from
\`gh auth token\` when GitHub CLI is signed in, and never prints it.`;

const DEFAULT_LABELS = ["Todo", "Ready", "InProgress", "InReview", "Done"];
const DEFAULT_TYPES = ["Feature", "Story", "Task"];
// The labels fab0 reads on a run's root item and people set (ARCHITECTURE H.5, L.1).
const FAB0_LABELS = [
  { name: "fab0/pause", color: "fbca04", description: "Holds the fab0 run this item starts; remove it to resume" },
  { name: "fab0/cancel", color: "b60205", description: "Cancels the fab0 run this item starts" },
];
const STATUS_COLORS = ["c5def5", "bfdadc", "fef2c0", "d4c5f9", "c2e0c6"];

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const PAGE = 100;

class Refusal extends Error {}

let token = "";

class GitHubError extends Error {
  constructor(method, path, status, message) {
    // GitHub's message is the one text from outside that is printed: the token is taken out should it hold it.
    super(`GitHub answered ${status} to ${method} ${path}: ${token ? message.split(token).join("***") : message}`);
    this.status = status;
  }
}

const say = (text = "") => process.stdout.write(`${text}\n`);
const complain = (text) => process.stderr.write(`${text}\n`);

function readToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function request(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "fab0-setup",
      "x-github-api-version": "2022-11-28",
      ...(body && { "content-type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new GitHubError(method, path, response.status, String(answer.message ?? response.statusText));
  return answer;
}

// Every page of a list: a page shorter than a full one is the last.
async function list(path) {
  const all = [];
  for (let page = 1; ; page++) {
    const items = await request("GET", `${path}?per_page=${PAGE}&page=${page}`);
    all.push(...items);
    if (items.length < PAGE) return all;
  }
}

// GitHub's 404 for a read, said as what is missing.
const missing = (message) => (error) => {
  throw error.status === 404 ? new Refusal(message) : error;
};

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
// The names, once each as GitHub counts them, case aside.
const names = (all) =>
  all.map((name) => name.trim()).filter((name, i, each) => name && each.findIndex((other) => same(other, name)) === i);

function readArguments() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        labels: { type: "string" },
        types: { type: "string" },
        apply: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
  } catch (error) {
    throw new Refusal(`${error.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) return null;
  const [org, ...given] = positionals;
  if (!org || given.length === 0) throw new Refusal(`Name the organization and at least one repository.\n\n${USAGE}`);
  const repos = given.map((repo) => {
    const name = repo.startsWith(`${org}/`) ? repo.slice(org.length + 1) : repo;
    if (name.includes("/")) throw new Refusal(`${repo} is not a repository of ${org}.`);
    return name;
  });
  const labels = values.labels === undefined ? DEFAULT_LABELS : names(values.labels.split(","));
  const types = values.types === undefined ? DEFAULT_TYPES : names(values.types.split(","));
  if (labels.length === 0 || types.length === 0) throw new Refusal("--labels and --types each need at least one name.");
  if (labels.some((label) => FAB0_LABELS.some((own) => same(own.name, label)))) {
    throw new Refusal("fab0/pause and fab0/cancel are always made; leave them out of --labels.");
  }
  return { org, repos: names(repos), labels, types, apply: values.apply };
}

// Each step is a name fab0 wants, what GitHub has under it (`found`, matched case aside), and what to do.
async function plan({ org, repos, labels, types }) {
  const account = await request("GET", `/users/${encodeURIComponent(org)}`).catch(
    missing(`There is no GitHub account named ${org}.`),
  );
  if (account.type !== "Organization") {
    throw new Refusal(
      `${org} is a user account. Issue types exist only in organizations, so fab0 runs pipelines for organizations only.`,
    );
  }

  const existingTypes = await list(`/orgs/${encodeURIComponent(org)}/issue-types`);
  const typeSteps = types.map((name) => {
    const found = existingTypes.find((each) => same(each.name, name));
    return { name, found, action: !found ? "create" : found.is_enabled === false ? "enable" : "exists" };
  });

  const wanted = [
    ...labels.map((name, i) => ({
      name,
      color: STATUS_COLORS[i % STATUS_COLORS.length],
      description: `fab0 pipeline status, ${i + 1} of ${labels.length}`,
    })),
    ...FAB0_LABELS,
  ];
  const labelSteps = [];
  for (const repo of repos) {
    const path = `/repos/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/labels`;
    const existing = await list(path).catch(
      missing(`There is no repository ${org}/${repo}, or the token can't read it.`),
    );
    for (const label of wanted) {
      const found = existing.find((each) => same(each.name, label.name));
      labelSteps.push({ name: label.name, found, action: found ? "exists" : "create", repo, path, label });
    }
  }
  return { typeSteps, labelSteps };
}

// A name GitHub already has, in another case.
const differs = (step) => step.found !== undefined && step.found.name !== step.name;
const WORDS = { create: "to create", enable: "to enable (it is disabled)", exists: "exists" };

function show({ org, repos }, { typeSteps, labelSteps }) {
  const all = [...typeSteps, ...labelSteps];
  const width = Math.max(...all.map((step) => step.name.length)) + 2;
  const line = (step) =>
    `  ${step.name.padEnd(width)}${WORDS[step.action]}${differs(step) ? `, named ${step.found.name} on GitHub` : ""}`;
  say(`fab0 setup for the organization ${org}`);
  say();
  say("Issue types");
  for (const step of typeSteps) say(line(step));
  for (const repo of repos) {
    say();
    say(`Labels in ${org}/${repo}`);
    for (const step of labelSteps.filter((each) => each.repo === repo)) say(line(step));
  }
  say();
  if (all.some(differs)) {
    say("fab0 matches names exactly, but GitHub holds a name only once whatever its case, so these");
    say("can't be added: rename them on GitHub, or use GitHub's names in the pipeline.");
    say();
  }
}

function summary(typeSteps, labelSteps) {
  const tally = (steps, action) => steps.filter((step) => step.action === action).length;
  const count = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return [
    ["create", tally(typeSteps, "create"), "issue type"],
    ["enable", tally(typeSteps, "enable"), "issue type"],
    ["create", tally(labelSteps, "create"), "label"],
  ]
    .filter(([, n]) => n > 0)
    .map(([verb, n, noun]) => `${verb} ${count(n, noun)}`)
    .join(", ");
}

// The writes made so far: a failure after one leaves what was made.
let made = 0;

async function apply({ org }, { typeSteps, labelSteps }) {
  const types = `/orgs/${encodeURIComponent(org)}/issue-types`;
  for (const step of typeSteps) {
    if (step.action === "create") {
      await request("POST", types, { name: step.name, is_enabled: true });
      say(`Created the issue type ${step.name}`);
    } else if (step.action === "enable") {
      // An update takes the type whole: its description and colour are sent back as they are.
      const { id, name, description, color } = step.found;
      const body = { name, is_enabled: true, ...(description != null && { description }), ...(color && { color }) };
      await request("PUT", `${types}/${id}`, body);
      say(`Enabled the issue type ${step.name}`);
    } else {
      continue;
    }
    made++;
  }
  for (const step of labelSteps) {
    if (step.action !== "create") continue;
    await request("POST", step.path, step.label);
    say(`Created the label ${step.name} in ${org}/${step.repo}`);
    made++;
  }
}

async function main() {
  const options = readArguments();
  if (!options) {
    say(USAGE);
    return;
  }
  token = readToken();
  if (!token) {
    throw new Refusal("No GitHub token: set GH_TOKEN, or sign in to GitHub CLI with `gh auth login`.");
  }
  const steps = await plan(options);
  show(options, steps);
  const changes = summary(steps.typeSteps, steps.labelSteps);
  if (!changes) {
    say(`Nothing to do: ${options.org} has every issue type and each repository every label.`);
    return;
  }
  if (!options.apply) {
    say(`Plan: ${changes}.`);
    say("Nothing was written. Run again with --apply to make these changes.");
    return;
  }
  say(`Applying: ${changes}.`);
  await apply(options, steps);
  say("Done. A second run plans nothing.");
}

main().catch((error) => {
  if (error instanceof Refusal) {
    complain(error.message);
  } else if (error instanceof GitHubError) {
    complain(error.message);
    if (error.status === 401) complain("The token was refused. Check GH_TOKEN, or sign in again with `gh auth login`.");
    if (error.status === 403 || error.status === 404) {
      complain("Making issue types and labels needs an organization owner's token.");
    }
    if (made > 0) complain("What was made before this stays; run again to make the rest.");
  } else {
    complain(`fab0 setup stopped: ${error.message}`);
  }
  process.exitCode = 1;
});
