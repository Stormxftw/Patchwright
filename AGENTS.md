# Agent Instructions

- Keep changes small and easy to review.
- Do not commit secrets, tokens, local config, or `.codex-daemon/` runtime state.
- Preserve the conservative default behavior: dry-run first, draft PRs, no auto-merge.
- Prefer plain Node.js built-ins unless a dependency clearly earns its weight.
- Run `npm run check` after code changes.
- Update `README.md` when behavior or setup changes.
