# Patchwright

<img src="tools/codex-daemon/public/assets/option-c-hammer-terminal.png" alt="Patchwright hammer terminal logo" width="96">

Patchwright is an experimental local daemon that treats a GitHub Project board like a queue for Codex CLI work.

The short version:

```text
GitHub Project issue -> packet check -> optional localization -> Codex CLI works locally -> draft PR -> human review
```

This is not an official OpenAI project. It is a personal experiment for exploring how far a lightweight, GitHub-native R&D loop can go before it becomes too risky, too complicated, or too opinionated.

## Brand Assets

Patchwright uses the hammer-terminal mark from the Round 3 branding kit. The mark is meant to signal a small local tool that turns issue packets into reviewed patches.

Included assets:

- `tools/codex-daemon/public/assets/option-c-hammer-terminal.svg` - primary dashboard mark.
- `tools/codex-daemon/public/assets/option-c-hammer-terminal.png` - README and fallback raster mark.
- `tools/codex-daemon/public/assets/patchwright-round3-contact-sheet.png` - branding contact sheet from the kit.

Palette:

- Background: `#090B10`
- Card: `#0F141D`
- Text: `#F3F4F6`
- Muted: `#98A2B3`
- Forge amber: `#FFB454`
- Violet: `#7C5CFF`
- Validation green: `#37D67A`

## Why This Exists

I wanted a workflow where GitHub stays the source of truth:

- Issues describe the work.
- A project board decides what is ready.
- Codex does the local implementation attempt.
- Pull requests stay the review boundary.
- Humans still approve merges.

The inspiration is simple: if an AI coding agent is going to help with real engineering work, it needs more than a prompt. It needs a queue, lifecycle states, evidence, guardrails, and a clean way to hand work back to people.

Patchwright is a small attempt at that.

## What It Does

The daemon can:

- Read GitHub Projects v2 items with `gh project item-list`.
- Pick one `Ready` issue.
- Check that the issue has a complete task packet.
- Move incomplete packets to `Needs info` without running Codex.
- Move it to `In progress`.
- Assign it to a configured GitHub user.
- Add a `codex:claimed` label.
- Comment on the issue with a run id.
- Create or switch to a branch.
- Run a read-only localization pass first when the packet is complete but not localized.
- Run `codex exec --json` against the local repo.
- Save Codex output under `.codex-daemon/`.
- Run packet-provided validation commands, with lightweight fallback verification.
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
    "done": "DONE_OPTION_ID",
    "blocked": "BLOCKED_OPTION_ID",
    "needsInfo": "NEEDS_INFO_OPTION_ID",
    "abandoned": "ABANDONED_OPTION_ID"
  },
  "assignee": "GITHUB_USERNAME",
  "packetIncompleteStatus": "needsInfo",
  "packetRequiredFields": ["goal", "scope", "acceptanceCriteria", "validationCommands"],
  "maxValidationCommands": 5
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

Dry runs print the selected issue, packet completeness, selected worker role, planned validation commands, branch, and Codex command without mutating GitHub or git.

Run one task:

```powershell
npm run daemon:once
```

Watch continuously:

```powershell
npm run daemon:watch
```

Open the local dashboard:

```powershell
npm run daemon:dashboard
```

Then open:

```text
http://127.0.0.1:3765
```

The dashboard is read-only. It serves a live view from `.codex-daemon/runs.jsonl` and each run's saved `events.jsonl` and `final.md`, so worker cards update as the daemon claims an issue, starts Codex, records output, detects changed files, runs validation, and opens a draft PR.

Use a different dashboard port:

```powershell
npm run daemon:dashboard -- --port 3770
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

## Real Workflow Smoke Test

Use a disposable issue before trusting a new daemon setup with real work.

1. Create an issue that uses the required packet shape and limits the change to one harmless file.
2. Add the issue to the GitHub Project board.
3. Set `Daemon Status` to `Ready`.
4. Run:

```powershell
npm run daemon:dry-run
```

Expected dry-run output should show:

```text
Packet status: complete
Worker role: fixer
Validation commands: npm run check && npm test
Planned status: In progress
```

Then run one real task:

```powershell
npm run daemon:once
```

Expected real-run outcome:

- Issue is assigned and labeled `codex:claimed`.
- Project status moves to `In progress`, then `In review`.
- A feature branch is pushed.
- A draft PR is opened.
- The PR includes only files created or changed by the daemon run.
- The issue evidence comment includes packet status, worker role, validation results, changed files, and final git status after commit.
- If the worker changes files outside `Allowed Paths`, the daemon moves the issue to `Blocked`, comments with the out-of-scope files, and does not commit or open a PR.

## Safety Model

The daemon is intentionally cautious:

- Default mode is dry-run if no mode is supplied.
- Real runs stop on a dirty worktree unless `--allow-dirty` is passed.
- If `--allow-dirty` is passed, existing dirty files are recorded before Codex runs.
- The daemon commits only files that were not already dirty at baseline.
- When `Allowed Paths` are provided, the daemon refuses to commit files outside those paths.
- Runtime state is written under `.codex-daemon/`, which should be gitignored.
- Common token and key patterns are redacted from daemon logs and issue comments.
- No auto-merge behavior exists in v1.

## Issue Quality Matters

Daemon-ready issues must include a small task packet. The daemon requires Goal, Scope, Acceptance Criteria, and Validation Commands before it will claim the issue for implementation.

Good:

```md
## Goal

Add a migration that creates profiles, organizations, and organization_members with RLS policies scoped by organization membership.

## Scope

- Add the migration only.
- Do not change application UI.

## Allowed Paths

- supabase/migrations/**

## Acceptance Criteria

- [ ] Tables are created with organization-scoped RLS.
- [ ] Existing migrations still apply cleanly.

## Validation Commands

- npm run check
- supabase db reset
```

Bad:

```text
Fix backend stuff.
```

Required issue shape:

```md
## Goal

One-sentence objective.

## Scope

- What should change.
- What should not change.

## Allowed Paths

- Optional path or glob list. Helps the daemon skip read-only localization.

## Suspect Files

- Optional file list when exact paths are known.

## Constraints

- Optional implementation constraints.

## Acceptance Criteria

- [ ] Concrete pass/fail outcome.

## Validation Commands

- npm run check
```

If `Allowed Paths` and `Suspect Files` are both missing, or the scope appears broad, the daemon runs a read-only localization pass before the fixer. It still uses exactly one write-capable Codex worker for the implementation attempt.

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
