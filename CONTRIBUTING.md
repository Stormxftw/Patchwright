# Contributing

Thanks for wanting to improve this experiment.

This project is intentionally small and conservative. The goal is not to build a giant autonomous engineering platform. The goal is to explore a practical GitHub-native loop where Codex can pick up well-scoped work, create a draft PR, and hand control back to humans.

## How To Contribute

1. Fork the repo.
2. Create a branch.
3. Make a focused change.
4. Run checks.
5. Open a pull request.

Suggested branch names:

```text
feature/<short-name>
fix/<short-name>
docs/<short-name>
experiment/<short-name>
```

## Good PRs

A good PR should:

- Explain what changed.
- Explain why it matters.
- Include manual test notes.
- Avoid unrelated refactors.
- Preserve the conservative safety model.

## Local Checks

Run:

```powershell
npm run check
```

If you test against a real GitHub Project, use a disposable test board or a clearly marked test issue.

## Safety Rules

Please do not add default behavior that:

- Auto-merges PRs.
- Deletes branches or issues.
- Runs `git reset --hard`.
- Stages unrelated dirty files.
- Prints secrets.
- Requires storing tokens in config files.

If you add a risky feature, make it explicit, documented, and off by default.

## Pull Request Review

PRs are welcome, but maintainers may ask for changes before merging. This is an experiment, so clear explanations and small patches are much easier to review than broad rewrites.
