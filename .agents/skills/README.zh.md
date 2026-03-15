# Skills 管理说明

本目录是仓库内 skills 的唯一维护来源（single source of truth）。

## 新增 Skill 流程

1. 在 `.agents/skills/<skill-name>/` 下创建新目录。
2. 添加 `SKILL.md`，包含：
   - YAML frontmatter 中的 `name` 和 `description`
   - 正文中的精简流程说明
3. （可选）如需 Codex UI 元数据，添加 `agents/openai.yaml`。
4. 若该 skill 需要作为仓库公共 skill 跟踪，请将 `<skill-name>` 追加到 `.agents/skills/public-skills.txt`。

## 命名规则

- 仅使用小写字母、数字和连字符（`-`）。
- 优先使用简短、动作导向的名称（例如：`gh-create-pr`）。

## Claude 兼容

每个新增的公共 skill，请执行：

```bash
pnpm skills:sync
```

`skills:sync` 会自动创建/更新 `.claude/skills/<skill-name>/`，作为公共 skill 目录的镜像：

- `SKILL.md` 会从 `.agents/skills/<skill-name>/SKILL.md` 复制过去。
- `scripts/`、`assets/` 这类仓库内辅助文件也会一起镜像。
- `__pycache__/`、`*.pyc`、`.DS_Store` 这类派生文件会继续被忽略。
- 不允许使用符号链接；check 会强制要求为普通文件以保证兼容性。

## 白名单跟踪规则

公共白名单由 `.agents/skills/public-skills.txt` 定义。

- 写入该文件的 skill 会同步到 `.agents/skills/.gitignore` 和 `.claude/skills/.gitignore`。
- 私有/仅本地使用的 skill 不应写入 `public-skills.txt`。
- 每行只写一个 skill 名称。注释行必须以 `#` 开头，不能写行尾注释。

更新 `public-skills.txt` 后，请执行：

```bash
pnpm skills:sync
```

然后校验：

```bash
pnpm skills:check
```

上述脚本会自动维护并校验：

- `.agents/skills/.gitignore`
- `.claude/skills/.gitignore`
- `.claude/skills/<skill-name>/` 与 `.agents/skills/<skill-name>/` 的内容一致性

## GitHub 分发

仓库里的公共 skill 也可以通过
[`vercel-labs/skills`](https://github.com/vercel-labs/skills) 进行安装和更新管理。

有些面向最终用户的 skill 会单独维护在独立仓库里。
例如，`cherry-chat-research` 现在维护在：

- `https://github.com/ifastcc/cherry-skills`

示例：

```bash
npx skills add ifastcc/cherry-skills --skill cherry-chat-research -a codex -a claude-code
npx skills check
npx skills update
```

仍然留在当前仓库内的 skills，则继续沿用现有维护方式：

- 所有源码都在 `.agents/skills`
- `public-skills.txt` 仍然是公共白名单
- 每次改动后运行 `pnpm skills:sync` 和 `pnpm skills:check`
