---
name: fab0-pipelines
description: Writes and changes fab0 pipelines in a repository's .fab0/pipelines.yml, one pipeline at a time, from a person's description, raw ideas, a recipe from fab0-dev/home or an existing pipeline. Validates each draft with the fab0 MCP tools until no error is left, commits it through a pull request, and syncs it after the merge. Use when the person asks to write, change, fix or explain a fab0 pipeline or .fab0/pipelines.yml, describes how work should flow through their GitHub issues and pull requests (planning, specs, implementation, review, approval, status labels), or names a fab0 recipe.
license: MIT
compatibility: Needs the fab0 MCP server (the fab0 plugin for Claude Code), git, and the GitHub CLI (gh) signed in as the person.
metadata:
  version: "1"
  plugin: "0.4.0"
---

# Write fab0 pipelines

fab0 runs pipelines over a team's GitHub issues and pull requests. A repository's pipelines live in one file, `.fab0/pipelines.yml`, one pipeline per YAML document. This skill writes or changes one of those documents with the person, checks it with fab0, and commits it through a pull request. After the merge, fab0 makes it active.

[catalogue.md](catalogue.md) lists everything a pipeline can say: the document's keys, every trigger, gate, action, artifact, approval mode and limit, each with an example, and every validation code with its fix. Read it before you write.

## Rules

- Write only what catalogue.md lists. Never invent a key, an entry or a value. If the person asks for something the catalogue can't express, say so, and offer the nearest thing it can.
- Change one document at a time. Leave every other document of the file exactly as it is: each document's text is its pipeline's version.
- Keep the modeline `# yaml-language-server: $schema=https://schema.fab0.dev/pipeline.v1.json` as the file's first line.
- Work with the person's own `git` and `gh`. For every change on GitHub, use the REST API (`gh api`), never GraphQL. Never push to the default branch unless the person tells you to.

## 1. Read what exists

Work in a checkout of the repository. Its `owner/name` is in `git remote get-url origin`, and its default branch is `gh api repos/{owner}/{repo} --jq .default_branch`.

- Read `.fab0/pipelines.yml`, if it exists.
- Call `validate_pipeline` with `repo`. It answers what fab0 last synced: the file's state, and for each pipeline its `active` and `latest` version and the errors and warnings of the latest. A pipeline whose latest version was rejected still runs on its active one. Show the person any errors.
- Read the organization's issue types, `gh api orgs/{owner}/issue-types --jq '.[].name'`, and the repository's labels, `gh api repos/{owner}/{repo}/labels --paginate --jq '.[].name'`. If the issue types can't be read, ask the person for them.

## 2. Choose a start

Start from one of:

- **the person's description or raw ideas;**
- **a recipe**, a tested pipeline from `fab0-dev/home`. List their names with `gh api repos/fab0-dev/home/contents/recipes --jq '.[].name | select(endswith(".yml")) | rtrimstr(".yml")'`, and read one with `gh api repos/fab0-dev/home/contents/recipes/<name>.yml -H "Accept: application/vnd.github.raw+json"`. Change its types, status labels, people and repositories to the person's, and as little else as you can;
- **a document of the file,** to change.

Ask only what the catalogue can't default, and only what the start doesn't already answer:

- the item types, and which is the parent of which;
- the status labels, in order, and which one ends a run;
- who approves each step's result, and who answers escalations, as GitHub logins.

For everything else, use the catalogue's default, and tell the person which defaults you used.

## 3. Write one document

Write it from catalogue.md, starting from its skeleton, the recipe or the document being changed. A new document goes at the end of the file, after a line `---`; a changed one is edited in place.

- Use only catalogue entries, and only the issue types and labels read in 1, or new ones the person agrees to create.
- Keep the pipeline's `name` unique in the file, and each step's name unique in its type.
- Give every human gate (`label`, `command`, `review`) its `by`, every `approve` with `human` its list, and `escalate` at least one person. Name groups under `people`.

## 4. Validate until clean

1. Call `validate_pipeline` with `text`: the whole file, not only your document, so names are checked across documents.
2. If the answer has `problems` (a YAML error or a file cap), it has no documents: fix those first.
3. For each error of your document, go to its `line` and `path`, and apply its `fix`. When the fix leaves a choice, take it from the code's entry in catalogue.md, or ask the person.
4. Call `validate_pipeline` again with the whole file. Repeat until your document has no error.

If an error is still there after you applied its fix twice, stop, and show it to the person with what you tried. Show the person any errors in documents you didn't change. If they want those fixed, fix each document in its own pull request, after this one.

Warnings don't block. Show each one with what it means, from catalogue.md, and let the person decide whether to change the pipeline.

## 5. Commit

1. Show the person the document, and say in a few lines what it does: what starts a run, what each step does and who approves it, and what ends a run. Change it until they agree, and validate again after each change (4).
2. Create a branch (`git switch -c pipelines/<name>`), commit only `.fab0/pipelines.yml`, and push the branch.
3. Open the pull request with `gh api -X POST repos/{owner}/{repo}/pulls -f head=<branch> -f base=<default branch> -f title=<title> -f body=<body>`, not `gh pr create`. The body says what the pipeline does, as you described it to the person.
4. Show the person its link. fab0 reads the file only from the default branch, so nothing changes until it's merged.

## 6. Sync after the merge

Once the person says the pull request is merged, or `gh api repos/{owner}/{repo}/pulls/{number} --jq .merged` is `true`:

1. Call `sync_pipelines` with `repo`. Its `status`:
   - `synced`: the new versions are active;
   - `not-modified` or `unchanged`: fab0 already had this file;
   - `absent`: the default branch has no `.fab0/pipelines.yml`. Check that the merge landed;
   - `rejected`: the version was rejected, and the active one stays. Go to 2 for why;
   - `not-synced`: show the `reason`, and try again later.
2. Call `validate_pipeline` with `repo`, and check that the pipeline's `active` version is its `latest`. Show the person the result. If the latest has errors, go back to 4 with a new branch.

Tell the person that runs already started keep the version they began with, and new runs use the new one.
