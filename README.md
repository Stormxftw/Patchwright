# Codex R&D Daemon

An experimental local daemon that treats a GitHub Project board like a queue for Codex CLI work.

The short version:

```text
GitHub Project issue -> daemon claims it -> Codex CLI works locally -> draft PR -> human review
```

This is not an official OpenAI project. It is a personal experiment for exploring how far a lightweight, GitHub-native R&D loop can go before it becomes too risky, too complicated, or too opinionated.

## Why This Exists

I wanted a workflow where GitHub stays the source of truth:

- Issues describe the work.
- A project board decides what is ready.
- Codex does the local implementation attempt.
- Pull requests stay the review boundary.
- Humans still approve merges.

The inspiration is simple: if an AI coding agent is going to help with real engineering work, it needs more than a prompt. It needs a queue, lifecycle states, evidence, guardrails, and a clean way to hand work back to people.

This daemon is a small attempt at that.

## What It Does

The daemon can:

- Read GitHub Projects v2 items with `gh project item-list`.
- Pick one `Ready` issue.
- Move it to `In progress`.
- Assign it to a configured GitHub user.
- Add a `codex:claimed` label.
- Comment on the issue with a run id.
- Create or switch to a branch.
- Run `codex exec --json` against the local repo.
- Save Codex output under `.codex-daemon/`.
- Run lightweight verification.
- Commit only files changed by the daemon run.
- Push the branch.
- Open a draft PR.
- Move the issue to `In review`.
- Leave an evidence comment.

It does not:

- Auto-merge PRs.
- Close issues automatically.
- Bypass Codex sandboxing with dangerous flags.
- Intentionally stage unrelated dirty files.
- Replace human judgment.

## Why It Might Not Be The Best Idea

This is an experiment, and it has sharp edges.

AI agents are not magic workers. They can misunderstand requirements, over-edit, miss tests, or produce code that looks plausible but is wrong. A daemon makes that more powerful, which also makes it easier to create mess faster.

Some reasons this may not be the best approach:

- GitHub Project APIs are awkward and have generated field IDs.
- Local worktrees are easy to dirty or conflict.
- Long-running autonomous coding can burn tokens and time.
- A bad issue description can create a bad implementation.
- Verification is only as good as the checks available.
- You still need humans to review, test, and decide what ships.

That is why this daemon is intentionally conservative. It is PR-only automation. The pull request is the handoff, not the finish line.

## Current Status

Experimental.

Use this if you are comfortable reading the code, changing the config, and recovering manually when automation gets stuck.

This project is meant to be forked, modified, and improved.

## Requirements

- Windows, macOS, or Linux with a normal shell.
- Node.js 20 or newer.
- Git.
- GitHub CLI authenticated with project scope.
- Codex CLI installed and authenticated.
- A GitHub Projects v2 board.

The GitHub CLI token needs project access. You can usually refresh it with:

```powershell
gh auth refresh -s project
```

## Board Contract

Create a GitHub Projects v2 board with a custom single-select field named:

```text
Daemon Status
```

Recommended options:

```text
Backlog
Ready
In progress
In review
Done
Blocked
Needs info
Abandoned
```

The daemon uses this workflow:

```text
Backlog -> Ready -> In progress -> In review -> Done
```

Only `Ready` issues are picked by default.

Optional fields:

```text
Priority: P0, P1, P2, P3
Size: XS, S, M, L, XL
Estimate: number
Start date: date
Target date: date
```

Recommended labels:

```text
codex:claimed
codex:blocked
codex:ready
codex:daemon
```

## Setup

Clone this repo into the repository where you want the daemon to run, or copy `tools/codex-daemon` into that repo.

The daemon is currently repo-local: it assumes it lives inside the target repo and uses that repo as its working directory.

Copy the example config:

```powershell
New-Item -ItemType Directory -Path .codex-daemon -Force
Copy-Item tools/codex-daemon/config.example.json .codex-daemon/config.json
```

Edit:

```text
.codex-daemon/config.json
```

Fill in:

```json
{
  "repo": "OWNER/REPO",
  "owner": "OWNER",
  "projectNumber": 1,
  "projectId": "PROJECT_V2_NODE_ID",
  "projectStatusFieldName": "Daemon Status",
  "statusFieldId": "PROJECT_V2_DAEMON_STATUS_FIELD_ID",
  "statusOptions": {
    "backlog": "BACKLOG_OPTION_ID",
    "ready": "READY_OPTION_ID",
    "inProgress": "IN_PROGRESS_OPTION_ID",
    "inReview": "IN_REVIEW_OPTION_ID",
    "done": "DONE_OPTION_ID"
  },
  "assignee": "GITHUB_USERNAME"
}
```

You can get field IDs with:

```powershell
gh project field-list <PROJECT_NUMBER> --owner <OWNER> --format json
```

You can inspect project items with:

```powershell
gh project item-list <PROJECT_NUMBER> --owner <OWNER> --limit 100 --format json
```

## Commands

Dry run:

```powershell
npm run daemon:dry-run
```

Run one task:

```powershell
npm run daemon:once
```

Watch continuously:

```powershell
npm run daemon:watch
```

Allow Backlog fallback:

```powershell
npm run daemon:dry-run -- --include-backlog
```

Allow a real run with existing dirty files:

```powershell
npm run daemon:once -- --allow-dirty
```

Recover from a stale local lock:

```powershell
npm run daemon:once -- --recover
```

## Safety Model

The daemon is intentionally cautious:

- Default mode is dry-run if no mode is supplied.
- Real runs stop on a dirty worktree unless `--allow-dirty` is passed.
- If `--allow-dirty` is passed, existing dirty files are recorded before Codex runs.
- The daemon commits only files that were not already dirty at baseline.
- Runtime state is written under `.codex-daemon/`, which should be gitignored.
- Common token and key patterns are redacted from daemon logs and issue comments.
- No auto-merge behavior exists in v1.

## Issue Quality Matters

Daemon-ready issues should be concrete.

Good:

```text
Add a migration that creates profiles, organizations, and organization_members with RLS policies scoped by organization membership. Verify with the app build and migration checks.
```

Bad:

```text
Fix backend stuff.
```

Suggested issue shape:

```md
## Purpose

Why this work exists.

## Scope

- What should change.
- What should not change.

## Acceptance Criteria

- [ ] Concrete pass/fail outcome.
- [ ] Verification command or evidence.

## Notes

Relevant constraints or links.
```

## Contributing

Fork it. Branch it. Break it in interesting ways. Open a PR.

Useful contribution areas:

- Better GitHub Projects v2 handling.
- Safer dirty-worktree tracking.
- More portable shell support.
- Better structured run output.
- Config validation.
- Tests for the issue selection and claim lifecycle.
- Better docs for non-Windows environments.
- GitHub Actions examples.
- Optional hosted control plane ideas.

Please keep the default behavior conservative. Draft PRs are good. Auto-merge should remain out of scope unless it is heavily guarded and clearly optional.

## License

MIT. Use it, fork it, learn from it, and make it better.
