# Security

This project orchestrates local commands, GitHub issue state, Git branches, and Codex CLI. Treat it as developer tooling with real permissions.

## Supported Security Posture

The daemon is designed to be conservative by default:

- No auto-merge.
- No issue auto-close.
- No dangerous Codex sandbox bypass.
- No secret values in config files.
- Local runtime state is gitignored.
- Common token/key patterns are redacted from logs and comments.

## Sensitive Data

Do not commit:

- `.env` files.
- `.codex-daemon/` runtime state.
- GitHub tokens.
- OpenAI keys.
- Supabase service role keys.
- Private keys.
- Production database credentials.

Use environment variables or your existing authenticated CLIs instead.

## Reporting Issues

If you find a security issue, please open a GitHub issue with enough detail to reproduce it. If the issue involves a live secret, do not paste the secret into the issue.

## Threat Model Notes

The main risks are:

- A malicious or sloppy issue body causing bad code changes.
- A local dirty worktree getting mixed into an automated commit.
- A GitHub token with broad permissions being abused.
- Logs accidentally containing secrets.
- A daemon loop creating noisy PRs or comments.

The daemon reduces some of this risk with dry-run mode, dirty worktree checks, narrow commit staging, local locks, and redaction. It does not remove the need for human review.
