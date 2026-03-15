# 这个 Fork 怎么用

如果你只想知道这个 Fork 和上游版有什么区别，可以先记一句话：

- 它在原版 Cherry Studio 上，多了三样更适合本地 Agent 工作流的东西：`Topic 同步`、`对外 History / MCP API`，以及一个单独维护的 `cherry-chat-research` 技能仓库。

这份说明不讲设计理念，只讲你能拿它做什么，以及从哪里开始。

## 1. Topic 同步

这是用来同步本地 Topic 的。

适合这几种场景：

- 你有多台设备，想同步聊天记录
- 你换机器了，想把原来的 Topic 带过去
- 你想把本地数据持续推到自己的同步服务

入口：

- `设置 -> 数据设置 -> Topic 同步`

先配这两项：

- `同步服务器`
- `同步令牌`

常用模式：

- `仅推送`：适合一台设备主写，最稳
- `手动拉取`：先看预览，再决定要不要拉下来
- `自动安全拉取`：自动应用无冲突的变更
- `全自动（拉取 + 推送）`：只有在你已经很确定同步策略时再开

常用操作：

- `检测连接`
- `立即同步`
- `预览拉取`
- `应用安全拉取`

如果你只是自己单机使用，不需要多设备同步，这一块可以先不配。

## 2. 对外 API / MCP

这是把 Cherry Studio 变成一个本地数据入口和能力入口。

入口：

- `设置 -> API 服务器`

打开后你会看到：

- 本地地址，比如 `http://127.0.0.1:23333`
- API 密钥
- `/api-docs` 文档入口

常用接口分两类：

- `GET /v1/history/*`
  - 读 topic 列表
  - 读消息
  - 读 transcript
  - 搜索历史消息
- `GET /v1/mcps`
- `GET /v1/mcps/:server_id`
- `ALL /v1/mcps/:server_id/mcp`
  - 把本地 MCP 服务通过 API 暴露给外部工具

适合拿来做：

- 外部 Agent 读你的聊天历史
- 脚本或本地工具复用 Cherry 里的上下文
- 让别的工具通过 Cherry 访问本地 MCP 能力

注意：

- 本机访问默认也需要 API 密钥
- 这不是公开服务，建议只在本机或你自己控制的网络里用

## 3. `cherry-chat-research` 技能

这个 skill 现在单独维护在：

- `https://github.com/ifastcc/cherry-chat-research`

这个 skill 不是固定报表生成器。

它更像一个“聊天历史研究员”：

- 它会自己看 topic
- 自己搜索线索
- 自己读 transcript
- 最后再决定怎么写报告

如果你想让 Agent 研究“我最近到底在想什么”“我反复纠缠的主题是什么”“我的聊天里有什么长期模式”，它就是干这个的。

安装：

```bash
npx skills add ifastcc/cherry-chat-research --skill cherry-chat-research -a codex -a claude-code
```

使用前先做两步：

1. 在 Cherry Studio 里打开 `API 服务器`
2. 确认服务已经运行

大多数情况下，不用再手动设置环境变量。

这个 Fork 会把本地连接信息写到一个连接文件里，skill 会优先自动发现它。

如果你之前是从 `ifastcc/cherry-studio` 安装的旧版本，重新跑一遍上面的安装命令就行。

如果自动发现失败，再手动指定：

```bash
export CHERRY_API_BASE_URL=http://127.0.0.1:23333/v1
export CHERRY_API_KEY=你的_API_密钥
```

这个 skill 适合做：

- 最近关注主题回顾
- 一段时间内的聊天研究
- 更自由的用户画像
- HTML 报告、长文总结、洞察型输出

## 4. 我该从哪开始

如果你只是想先试一件事，按这个顺序就够了：

1. 先打开 `API 服务器`
2. 看一下 `/api-docs`
3. 再决定你要做哪条线：
   `Topic 同步`、`History API`、或者 `cherry-chat-research`

最常见的起步方式是：

- 想同步记录：先配 `Topic 同步`
- 想给外部工具调用：先开 `API 服务器`
- 想直接做聊天历史研究：先装 `cherry-chat-research`

## 5. 这个 Fork 更适合谁

它更适合下面这类用法：

- 你把 Cherry 当本地 AI 工作台来用
- 你想把聊天历史继续交给外部 Agent 处理
- 你希望本地 MCP 能力能被别的工具直接调用

如果你只需要一个稳定的桌面聊天客户端，而且不打算折腾同步、API 或技能，那上游版通常就够了。
