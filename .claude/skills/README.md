# Claude Skills Mirror

This directory is a synced mirror for Claude-compatible public skill directories.

- Do not create new skills directly under `.claude/skills`.
- Create and maintain skills under `.agents/skills` only.
- Update `.agents/skills/public-skills.txt`, then run `pnpm skills:sync`.
- `pnpm skills:check` verifies `.claude/skills/<skill>/` matches `.agents/skills/<skill>/`.
- Mirrored directories may include repo-local helpers such as `scripts/` or `assets/`.
