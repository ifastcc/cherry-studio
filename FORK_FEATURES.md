# This Fork Adds

这个 Fork 保持跟随上游 Cherry Studio，同时额外加入了几类更偏本地 Agent 工作流的能力。

它不是另起炉灶的重写版，而是在原有产品基础上补强了三个方向：

- 话题同步
- 对外 API / MCP 能力
- 面向本地 Agent 的技能体系

## 1. 话题同步

这个 Fork 增加了本地 topic 数据与远端同步服务之间的同步能力。

重点不只是“上传/下载”，而是把同步做成一个可长期使用的机制：

- 支持手动触发和自动同步
- 支持 push only / manual pull / auto safe / auto full 等模式
- 支持冲突策略与失败重试
- 支持同步状态、最近结果、错误队列和连接状态展示

适合需要在多设备、多环境之间同步本地对话数据的人。

## 2. 对外 API 与 MCP 能力

这个 Fork 更强调把 Cherry Studio 变成一个可被外部工具调用的数据与能力节点。

当前对外能力主要包括：

- `GET /v1/history/*`
  - 面向本地历史数据读取
  - 支持 topic catalog、message search、transcript、message detail
- `GET /v1/mcps`
- `GET /v1/mcps/:server_id`
- `ALL /v1/mcps/:server_id/mcp`
  - 把本地 MCP server 以 API 方式暴露给外部 Agent / Tooling

这意味着 Cherry Studio 不只是一个桌面聊天应用，也可以作为：

- 本地聊天历史数据面
- 本地 MCP 能力网关
- 其他 Agent 的上游数据源

## 3. 本地技能

这个 Fork 加入了围绕 Cherry 本地数据面的 skill 能力，重点是：

- 不是把聊天历史做成固定统计报表
- 而是让外部 Agent 直接基于本地历史做研究、分析和表达

其中最重要的是 `cherry-chat-research`：

- 通过本地 `/v1/history` API 读取真实历史数据
- 支持导出可读的 research workspace
- 让模型自己决定研究路径，而不是先被预定义分析模板限制

这更适合做：

- 用户画像
- 最近关注主题研究
- 长期母题与变化趋势阅读
- 更自由的报告、网页或洞察型输出

## 这个 Fork 适合谁

如果你希望 Cherry Studio 更偏向下面这些用途，这个 Fork 会更合适：

- 本地优先的数据与 Agent 工作流
- 对话历史的二次研究与复用
- 让外部工具直接访问 Cherry 的能力与上下文
- 在原版产品基础上继续做个人化定制

## 设计取向

这个 Fork 的取向很简单：

- 尽量保留上游主干能力
- 尽量把新增能力做成可组合、可对外暴露的接口
- 尽量让 Agent 自己做研究，而不是把结论硬编码进产品

如果你把 Cherry Studio 看成一个“本地 AI 工作台”，这个 Fork 主要做的，就是把它往“本地 Agent Operating Surface”这个方向再推一步。
