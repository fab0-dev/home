# The fab0 pipeline catalogue

Everything a fab0 pipeline can say, for the assistant that writes one and the person who reads it. A pipeline uses only the entries listed here; anything else is an error. The JSON Schema `https://schema.fab0.dev/pipeline.v1.json` checks the same shapes, and `validate_pipeline` checks the rest.

## Contents

- The document: the file, the skeleton of one pipeline, its top-level keys
- Types and steps: item types, step keys, `if`, status labels, `on_done`
- Triggers (`on`): `status`, `joined`, `closed`, `dependencies`, `pr`, `review`, `children`, `timer`
- Gates (`gates`): `label`, `command`, `review`, `dependencies`, `children`, `after`, `timer`
- Actions (`do`): `agent.routine`, `agent.record`, `github.label`
- Artifacts: `makes: pr`, `makes: issues`, `outputs`
- Approval (`approve`): `none`, `auto` (with reviewer steps), `via: merge`, `via: review`, `via: label`, `via: command`
- Limits: defaults, ranges, where each is set
- Validation codes: every error and warning, with its fix

## The document

A repository's pipelines live in one file, `.fab0/pipelines.yml`: a YAML stream with one pipeline per document, the documents separated by a line `---`. The file's first line is the schema modeline. Each document's content is its pipeline's version, so editing one document leaves the others' versions as they are.

The file holds at most 100 documents and 10 MB, one document at most 1 MB, and one pipeline at most 200 steps.

The skeleton of one document, which validates with no error:

```yaml
# yaml-language-server: $schema=https://schema.fab0.dev/pipeline.v1.json
version: 1
name: story-delivery
description: A Story implemented by an agent, and merged by a lead.
people:
  leads: [octocat]
status:
  labels: [Todo, Ready, InProgress, InReview, Done]
  end: Done
start: { type: Story, status: Ready, by: [leads] }
escalate: [leads]
types:
  Story:
    steps:
      implement:
        on: { status: Ready }
        do: agent.routine
        skill: implement
        model: medium
        makes: pr
        approve: { human: [leads], via: merge }
        on_done: [{ label: Done }]
```

| Key | Required | Meaning |
| --- | --- | --- |
| `version` | yes | `1` |
| `name` | yes | the pipeline's name, unique in the file: lowercase letters, digits and hyphens. It names the pipeline across versions, so don't rename it without reason |
| `description` | no | one line, shown by `validate_pipeline` and `get_run` |
| `repos` | no | names for repositories of the installation, `name: owner/repo`. Steps name repositories by these names; the pipeline's own repository is always `self` |
| `people` | no | names for lists of GitHub logins, `name: [login, ...]`. A `by`, `human` or `escalate` list may mix these names and logins. GitHub teams are not read |
| `status` | yes | `labels`: the status labels, in their usual order; `end`: the status that ends a run when its root item holds it |
| `start` | yes | what starts a run: an item of `type` that gets the label `status`, optionally set by someone in `by`. The start type is the root of the type tree |
| `escalate` | yes | who answers escalations: at least one name or login |
| `bots` | no | bot logins (`name[bot]`) whose GitHub events may wake and start this pipeline's runs; every other bot's are ignored. A bot never counts as a person in a `by` list |
| `limits` | no | run-wide limits (Limits) |
| `types` | yes | the item types and their steps (Types and steps) |

## Types and steps

```yaml
types:
  Feature:                 # a GitHub issue type of the organization
    steps: { ... }
  Story:
    parent: Feature        # Stories are sub-issues of Features
    steps: { ... }
```

Each key of `types` is an issue type of the organization. Every type but `start.type` names its `parent`, and the types form one tree under the start type. An item of a type outside the tree takes no part in a run.

A step is keyed by its name, unique within its type: lowercase letters, digits and hyphens. Its keys:

| Key | Meaning | On |
| --- | --- | --- |
| `on` | its trigger: exactly one entry (Triggers) | every step but a reviewer |
| `if` | a filter on the trigger item's labels; when false, the round is skipped | every step |
| `gates` | conditions that hold the round until each holds (Gates) | every step |
| `do` | its action (Actions) | every step |
| `skill`, `model`, `repo`, `as`, `makes`, `kind`, `spawn`, `outputs` | what an agent works on and returns (Actions, Artifacts) | `agent.*` steps |
| `label`, `target`, `as` | the label change a `github.label` step makes | `github.label` steps |
| `approve` | how its result is approved (Approval) | every step but a reviewer and `github.label` |
| `reviews` | the step of the same type this reviewer step reviews | reviewer steps |
| `on_done` | label changes made once its result is approved | every step but `github.label` |
| `limits` | `retries`, `revisions`, `timeout`, `review_timeout`, `act_timeout` for this step | every step |
| `escalate` | who answers this step's escalations, instead of the pipeline's | every step |

A round is one run of a step on one item: it starts when the trigger holds, waits for its gates, and ends approved, rejected or skipped. A round is retried and revised within its limits.

`if` reads the trigger item's labels when the round starts. Labels are its only filter:

```yaml
if: { labels: { has: [ui], lacks: [skip-ui] } }
```

Status labels. An item holds one status at a time: setting a status label removes the item's other status labels. Any other label is added alongside. Labels that start with `fab0/` are set by people only; no pipeline sets one.

`on_done` lists label changes made once the step's result is approved, after its merge, by the step's person. `target` is `self` (the default), `parent` or `root`. A change that sets a status doesn't undo a person who moved the item on in the meantime. Each change costs an act, a GitHub change the person's Claude Code makes; where the next step can start from an `after` gate instead, prefer the gate:

```yaml
on_done: [{ label: InReview }, { label: Done, target: parent }]
```

## Triggers (`on`)

A trigger is a condition on the item's current state. It starts a new round when it holds and no round of the step started since the moment it became true (its "since" time). A person setting a status label again sets a new moment, so a new round starts. A step has exactly one trigger entry, plus the filter keys that entry takes.

### `status`

`github.issues.status`. The item holds this status label. Its moment is when the label was set.

- Filter keys: `by`, who set the label; a change made by an act never counts.
- Envelope: the item, the label, who set it.

```yaml
on: { status: Ready, by: [leads] }
```

### `joined`

`github.issues.created` and `github.issues.linked`. The item joined the run, never the root: `created`, made after the run started (by a planner step, say); `linked`, an item that existed before, linked by hand or in the tree when the run started; or `any`.

- Filter keys: none.
- Envelope: the item, and for `created` its author.

```yaml
on: { joined: created }
```

### `closed`

`github.issues.closed`. The item is closed with this reason: `completed`, `not_planned` or `any`. Its moment is the close.

- Filter keys: none.
- Envelope: the item, the reason.

```yaml
on: { closed: completed }
```

### `dependencies`

`github.issues.dependency`. The item had blockers, and none is open now. Its moment is the last blocker's close. The only value is `resolved`.

- Filter keys: none.
- Envelope: the item, its blockers.

```yaml
on: { dependencies: resolved }
```

### `pr`

`github.pr.opened`, `github.pr.merged` and `github.pr.closed`. A pull request bound to the item (one whose body carries fab0's marker lines for it) is `opened`, `merged`, or `closed` unmerged.

- Filter keys: `step`, only pull requests made by that step's rounds.
- Envelope: the item, the pull request.

```yaml
on: { pr: merged, step: implement }
```

### `review`

`github.pr.review`. Someone's latest review of a bound pull request is `approved` or `changes_requested`.

- Filter keys: `by` and `step`. `by` counts only reviews by these people; `step` only pull requests made by that step's rounds.
- Envelope: the item, the pull request, the review.

```yaml
on: { review: approved, by: [leads] }
```

### `children`

`fab0.children`. All (`all`) or any (`any`) of the item's children of `type` hold this status, leaving out children closed as not planned. `all` needs at least one counted child. Its moment is when the last (or first) counted child reached it.

- Filter keys: none; `type` is part of the entry.
- Envelope: the item, its children.

```yaml
on: { children: { type: Story, all: Done } }
```

### `timer`

`fab0.timer`. This long has passed since the item entered its current status. A duration is a number and a unit: `m`, `h` or `d`.

- Filter keys: none.
- Envelope: the item.

```yaml
on: { timer: 2d }
```

There is no trigger on another step's result: use an `after` gate or a reviewer step. There is no trigger on CI checks: an agent waits for CI before it reports, and branch rules guard merges.

## Gates (`gates`)

Gates hold a round until every one of them holds. A gate never starts a round on its own. Each human gate (`label`, `command`, `review`) names who may give its signal in `by`, and a signal made by an agent acting for that person, or by an act, never counts.

### `label`

`human.label`. The item holds this label, set by someone in `by`.

- Filter keys: `by`, required.

```yaml
gates: [{ label: approved, by: [leads] }]
```

### `command`

`human.comment`. Someone in `by` wrote this command on the item since the round started. A command is a `/` and lowercase letters, digits and hyphens.

- Filter keys: `by`, required.

```yaml
gates: [{ command: /go, by: [leads] }]
```

### `review`

`human.review`. Someone in `by` approved a pull request bound to the item since the round started. The only value is `approved`. GitHub refuses a pull request's author's own review, so `by` needs someone besides the author.

- Filter keys: `by`, required.

```yaml
gates: [{ review: approved, by: [leads] }]
```

### `dependencies`

`fab0.dependencies-resolved`. The item has no open blocker. The only value is `resolved`.

- Filter keys: none.

```yaml
gates: [{ dependencies: resolved }]
```

### `children`

`fab0.children-complete`. As the `children` trigger: all or any of the item's children of `type` hold the status.

- Filter keys: none; `type` is part of the entry.

```yaml
gates: [{ children: { type: Task, all: Done } }]
```

### `after`

`fab0.after`. The latest round of this step, of the same type, on the same item is approved or skipped. Use it to chain steps on one status without a label change.

- Filter keys: none.

```yaml
gates: [{ after: spec }]
```

### `timer`

`fab0.timer`. This long has passed since the round started.

- Filter keys: none.

```yaml
gates: [{ timer: 1h }]
```

## Actions (`do`)

An agent step's keys:

| Key | Meaning |
| --- | --- |
| `skill` | required: the skill the session invokes, from the work repository's `.claude/skills/` |
| `model` | required on `agent.routine`: the model class, `small`, `medium` or `large`. With the person and the repository it picks the registered routine |
| `repo` | where the session works: a name from `repos`, `self` (the default), or `from_label`, which reads the item's `repo:<name>` label and falls back to the item's own repository |
| `as` | on `agent.routine`, whose routine runs it: `assignee` (the default, the item's assignee) or `starter` (who started the run) |
| `makes`, `kind`, `spawn`, `outputs` | what it returns (Artifacts) |

### `agent.routine`

The step runs as a Claude Code routine, an agent session registered by a person for a repository and a model class.

```yaml
implement:
  on: { status: Ready }
  gates: [{ dependencies: resolved }]
  do: agent.routine
  skill: implement
  model: medium
  repo: from_label
  makes: pr
  approve: { human: [leads], via: merge }
```

### `agent.record`

The step waits in a person's queue, and their own Claude Code does it with the fab0 plugin. `skill` says what they are asked to do. `by` lists who may take it besides the assignee.

```yaml
design:
  on: { status: Ready }
  do: agent.record
  skill: write-design
  by: [leads]
  makes: pr
  kind: markdown
  approve: { human: [leads], via: merge }
```

### `github.label`

The step changes one label, as an act made by the assignee (or, with `as: starter`, the run's starter) through their Claude Code. `label` is the label to set; `target` is `self` (the default), `parent` or `root`. It has no `approve` and no `on_done`.

```yaml
accept:
  on: { children: { type: Story, all: Done } }
  do: github.label
  label: InReview
```

There is no merge action: a step's pull request is merged as part of its act once its result is approved (Approval).

## Artifacts

What an agent step makes and returns, set with `makes` (`pr`, `issues` or `none`, the default) and `outputs`.

### `makes: pr`

The artifact `pr`: a pull request in the work repository, carrying fab0's marker lines. `kind` says what it holds: `code` (the default), `spec`, `plan` or `markdown`. A spec, a plan or a document is delivered as a pull request, so a person reviews it on GitHub. The step returns `{ "pr": "owner/repo#n" }`. Only a step with `makes: pr` takes `kind`, or `approve` `via: merge` or `via: review`.

```yaml
spec:
  on: { status: Ready }
  do: agent.routine
  skill: write-spec
  model: large
  makes: pr
  kind: spec
  approve: { human: [leads], via: merge }
```

### `makes: issues`

The artifact `issue-set`: the issues the step creates, as sub-issues of its item. `spawn` is required with it: `type`, a type whose `parent` is the step's type, and `budget`, at least 1, the most it may create. The step returns `{ "issues": ["owner/repo#n", ...] }`. Agents create the issues with a status, so their steps start once the planner's round is approved. Approve a spawning step with `auto` or `human`, so a review stands between rounds of planning.

```yaml
plan:
  on: { status: Ready }
  do: agent.routine
  skill: plan-feature
  model: large
  makes: issues
  spawn: { type: Story, budget: 10 }
  approve: { human: [leads], via: command }
```

### `outputs`

The artifacts `report` and `json`: data the step returns when it reports, validated against `schema`, an inline JSON Schema object. It goes with any `makes`.

```yaml
estimate:
  on: { status: Todo }
  do: agent.routine
  skill: estimate
  model: small
  outputs:
    schema:
      type: object
      properties: { points: { type: integer, minimum: 1 } }
      required: [points]
```

## Approval (`approve`)

How a step's result is approved; `none` when left out. On approval, the merge of the step's pull request at the approved head and its `on_done` labels are the step's act, made by its person; the step is done once fab0 sees them on GitHub. `human` lists names from `people` and logins, and may not be empty.

Branch rules. The merge act is made as the pull request's author. A repository rule that requires an approving review from someone else refuses it under `none` and `auto`, since a reviewer step's verdict isn't a GitHub review: there, use `via: review` or `via: merge`.

### `none`

Approved when the agent reports with valid outputs.

```yaml
approve: none
```

### `auto`

Approved when the reviewer step that reviews this step returns `approve` for this attempt and revision.

```yaml
approve: auto
```

A reviewer step has `reviews`, naming a step of the same type with `approve: auto`, an agent action with its keys, and no `on` or `approve`. It runs each time the reviewed step reaches review, and returns `{ "verdict": "approve" | "changes" | "reject", "findings": "<markdown>" }`: `changes` revises the reviewed step with the findings, `reject` rejects its round. A step has at most one reviewer, and a reviewer never reviews a reviewer.

```yaml
implement:
  on: { status: Ready }
  do: agent.routine
  skill: implement
  model: medium
  makes: pr
  approve: auto
review:
  reviews: implement
  do: agent.routine
  skill: review-code
  model: large
```

### `via: merge`

Approved when someone in `human` merges the step's pull request: the merge is the approval, so it costs no act. Needs `makes: pr`.

```yaml
approve: { human: [leads], via: merge }
```

### `via: review`

Approved when someone in `human` approves the step's pull request on GitHub. Its merge is then an act of the step's person. Needs `makes: pr`.

```yaml
approve: { human: [leads], via: review }
```

### `via: label`

Approved when someone in `human` sets `label` (default `approved`) on the item. A pull request's merge is then an act.

```yaml
approve: { human: [leads], via: label, label: approved }
```

### `via: command`

Approved when someone in `human` writes `command` (default `/approve`) on the item or its pull request. A pull request's merge is then an act.

```yaml
approve: { human: [leads], via: command, command: /approve }
```

## Limits

Set run-wide under the document's `limits`; the five marked "pipeline or step" can also be set under a step's `limits`, replacing the pipeline's for that step. A duration is a number and a unit: `m`, `h` or `d`.

| Key | Default | Range | Set on | Meaning |
| --- | --- | --- | --- | --- |
| `retries` | `2` | up to `5` | pipeline or step | attempts after the first, per round |
| `revisions` | `3` | up to `10` | pipeline or step | revisions per attempt |
| `timeout` | `2h` | up to `12h` | pipeline or step | how long an agent's session may take |
| `review_timeout` | `14d` | up to `90d` | pipeline or step | how long a result may wait for approval |
| `act_timeout` | `30m` | up to `24h` | pipeline or step | how long an act may take, from its handover until fab0 sees its changes |
| `launch_timeout` | `10m` | up to `30m` | pipeline | how long a started routine has to take its step |
| `settle` | `2m` | up to `30m` | pipeline | the settle window: how long after an agent's or an act's work on an item a person's signal there still isn't counted, and within which review requests make one revision |
| `stall_timeout` | `30d` | up to `180d` | pipeline | how long a stalled run (nothing left to run, and the root not at its end status) waits on the root's assignee before it fails |
| `resync_interval` | `15m` | `15m` to `24h` | pipeline | how often a run is checked against GitHub |
| `items` | `200` | up to `1000` | pipeline | items per run |
| `generations` | `3` | up to `6` | pipeline | how many levels of spawned items below the root |

```yaml
limits: { items: 150, generations: 2 }
```

## Validation codes

`validate_pipeline` answers each problem with its `code`, its `document` (the index in the file) and `name`, its `path` (the keys from the document's root), its `line` in the file, a `message` and a `fix`. Errors make their pipeline invalid; a YAML error or a file cap rejects the whole file. Warnings don't block, and are often intended.

### `schema`

Error. The document doesn't match the schema: a missing key, an unknown key, or a value of the wrong type or form. Also a trigger filter the entry doesn't take, `kind` without `makes: pr`, and a file that isn't valid YAML, which rejects the whole file.

Fix: Go to the path in the message. Add the missing key, remove the unknown one, or write the value in the form this catalogue gives. For YAML, fix the syntax at the line: indentation, a missing `:`, an unclosed bracket or quote.

### `file-cap`

Error. The file is over 10 MB or 100 documents, a document over 1 MB, or a pipeline over 200 steps.

Fix: Split a pipeline that does two jobs into two documents, or remove pipelines no longer used.

### `duplicate-name`

Error. Two documents have the same `name`.

Fix: Rename the new one. Keep an existing pipeline's name, since it identifies the pipeline across versions.

### `unknown-type`

Error. A `parent`, `start.type`, `spawn.type` or `children.type` names no key of `types`.

Fix: Add the type under `types`, or correct the name to one listed there. Types are the organization's GitHub issue types, so check its spelling with the person.

### `type-tree`

Error. The types don't form one tree under `start.type`: a type other than the start type has no `parent`, the start type has one, or parents form a cycle.

Fix: Give every type but the start type a `parent` that leads back to the start type, and remove the start type's `parent`.

### `unknown-status`

Error. A status in `on`, `start`, `on_done`, `children` or `status.end` isn't in `status.labels`.

Fix: Add the status to `status.labels`, or use one already listed. Status labels are case-sensitive.

### `unknown-step`

Error. `reviews` or `after` names no step of the same type.

Fix: Name a step of the same type. A step of another type can't be reviewed or waited for: use a `children` trigger or gate instead.

### `unknown-repo`

Error. A step's `repo` isn't a name from `repos`, `self` or `from_label`.

Fix: Add the repository under `repos` as `name: owner/repo`, or use `self`.

### `unknown-person`

Error. An entry of a `by`, `human` or `escalate` list is neither a name from `people` nor a GitHub login.

Fix: Add a `people` group with that name, or write the person's GitHub login. Teams are not supported: list their members.

### `missing-by`

Error. A `label`, `command` or `review` gate has no `by`, or an `approve` has an empty `human` list.

Fix: Name who may give the signal: a `people` name or GitHub logins. Ask the person if you don't know.

### `trigger-count`

Error. A step has no `on`, or an `on` with more than one entry; or a reviewer step has an `on`.

Fix: Give the step exactly one trigger entry. To wait for more conditions, keep one as the trigger and make the others gates. Remove a reviewer's `on`: it runs when the step it reviews does.

### `agent-keys`

Error. An `agent.*` step has no `skill`, or an `agent.routine` step no `model`.

Fix: Add `skill`, the name of a skill in the work repository's `.claude/skills/`, and for a routine `model`: `small`, `medium` or `large`.

### `auto-needs-reviewer`

Error. A step has `approve: auto`, and no reviewer step reviews it.

Fix: Add a reviewer step of the same type with `reviews: <this step>`, or choose another `approve`.

### `reviewer-target`

Error. A reviewer step reviews another reviewer, a second reviewer reviews the same step, or the reviewed step's `approve` isn't `auto`.

Fix: Keep one reviewer per step, and set the reviewed step's `approve: auto`. Remove the extra reviewer.

### `merge-needs-pr`

Error. `approve` is `via: merge` or `via: review` on a step without `makes: pr`.

Fix: Add `makes: pr` if the step opens a pull request; otherwise approve `via: label` or `via: command`.

### `spawn-needs-issues`

Error. A step has `spawn` without `makes: issues`, or `makes: issues` without `spawn`.

Fix: Add the missing key: `makes: issues` with `spawn: { type, budget }`.

### `spawn-type`

Error. `spawn.type` isn't a child type of the step's type: its `parent` is another type.

Fix: Spawn the type whose `parent` is this step's type, or move the step to the spawned type's parent.

### `limit-cap`

Error. A limit is above its cap, or `resync_interval` below `15m`.

Fix: Use a value within the limit's range in Limits.

### `reserved-label`

Error. An `on_done` or a `github.label` step sets a label that starts with `fab0/`.

Fix: Choose another label. `fab0/` labels are set by people only.

### `unreachable-status`

Warning. A trigger or `children` condition waits for a status on a type, and nothing in the pipeline sets it there: no `on_done` or `github.label` aimed at that type, no step that spawns it, and not the start status. Only a person can set it.

Fix: If a person moves items to that status, nothing is needed. Otherwise add an `on_done` or a `github.label` step that sets it.

### `unapproved-spawn`

Warning. A step that spawns issues has `approve: none`, so the items it creates start their steps at once, unreviewed.

Fix: Use `approve: auto` with a reviewer step, or `approve: { human, via }`, so a review stands between rounds of planning.

### `end-unreachable`

Warning. Nothing sets `status.end` on the start type, so only a person can end a run. Often intended: a person accepts the work.

Fix: If a person ends runs, nothing is needed. Otherwise add an `on_done` or a `github.label` step on the start type that sets the end status.

### `merge-act`

Warning. A `makes: pr` step is approved by a person `via: review`, `label` or `command`, so after the approval its merge is a separate act of the step's person.

Fix: Use `via: merge` when the approver can merge the pull request: the merge is then the approval. Keep the other mode if the approver can't merge.
