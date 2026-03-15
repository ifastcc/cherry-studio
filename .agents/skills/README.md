# Skills Management

This directory is the single source of truth for repository skills.

## Add a New Skill

1. Create a new folder under `.agents/skills/<skill-name>/`.
2. Add a `SKILL.md` file with:
   - `name` and `description` in YAML frontmatter
   - concise workflow instructions in the body
3. (Optional) Add `agents/openai.yaml` if Codex UI metadata is needed.
4. If this skill should be shared in the repository, append `<skill-name>` to `.agents/skills/public-skills.txt`.

## Naming Rules

- Use lowercase letters, digits, and hyphens only.
- Prefer short, action-oriented names (for example: `gh-create-pr`).

## Claude Compatibility

For each new public skill, run:

```bash
pnpm skills:sync
```

`skills:sync` will create/update `.claude/skills/<skill-name>/` as a mirror of the public skill directory:

- `SKILL.md` is copied from `.agents/skills/<skill-name>/SKILL.md`.
- repo-local files such as `scripts/` or `assets/` are mirrored too.
- generated artifacts like `__pycache__/`, `*.pyc`, and `.DS_Store` stay ignored.
- symlinks are not allowed; check enforces regular files for compatibility.

## White-list Tracking Rules

The public white-list is defined in `.agents/skills/public-skills.txt`.

- Skills listed there are synced to both `.agents/skills/.gitignore` and `.claude/skills/.gitignore`.
- Private/local-only skills should stay out of `public-skills.txt`.
- Use one skill name per line. Comment lines must start with `#` and cannot be appended inline.

After updating `public-skills.txt`, run:

```bash
pnpm skills:sync
```

Then validate:

```bash
pnpm skills:check
```

The sync/check scripts manage and verify:

- `.agents/skills/.gitignore`
- `.claude/skills/.gitignore`
- `.claude/skills/<skill-name>/` content matches `.agents/skills/<skill-name>/`

## GitHub Distribution

Public skills in this repository can also be installed and managed with
[`vercel-labs/skills`](https://github.com/vercel-labs/skills).

Some end-user skills may live in separate repositories.
For example, `cherry-chat-research` is now maintained in:

- `https://github.com/ifastcc/cherry-skills`

Example:

```bash
npx skills add ifastcc/cherry-skills --skill cherry-chat-research -a codex -a claude-code
npx skills check
npx skills update
```

Use repository-native workflows for skills that still live here:

- edit under `.agents/skills`
- keep `public-skills.txt` as the whitelist
- run `pnpm skills:sync` and `pnpm skills:check`
