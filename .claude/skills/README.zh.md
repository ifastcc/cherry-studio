# Claude Skills 镜像说明

本目录是面向 Claude 的公共 skill 目录镜像。

- 不要直接在 `.claude/skills` 下创建新 skill。
- 所有 skill 仅在 `.agents/skills` 中创建和维护。
- 更新 `.agents/skills/public-skills.txt` 后，执行 `pnpm skills:sync`。
- `pnpm skills:check` 会校验 `.claude/skills/<skill>/` 与 `.agents/skills/<skill>/` 内容一致。
- 镜像目录里可以包含 `scripts/`、`assets/` 这类仓库内辅助文件。
