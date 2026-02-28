# Cherry Studio Fork 同步主文档

本文是 `ifastcc/cherry-studio` 的同步功能主说明，覆盖：
- 这个 fork 相对上游新增了什么
- 如何和 `cherry-sync-server` 搭配
- 如何与 `cherry-reader` 协同使用
- 如何配置、排障、处理冲突

## 1. 这个 Fork 做了什么

相对于上游 Cherry Studio，本 fork 已把 Topic Sync 做成“设置页可配置”而不是纯隐藏模式，核心变化：

1. 内置 `Topic Sync` 设置面板
- 位置：`设置 -> 数据 -> Topic Sync`
- 可配置服务地址、Token、同步模式、冲突策略
- 可直接执行 `Sync Now / Check Connection / Pull Preview / Apply Safe Pull`
- 可直接执行冲突处理（`Resolve Local Wins / Resolve Server Wins`）

2. 同步模式可选
- `Push Only`：仅本地推送到服务器
- `Manual Pull`：手动预览并应用拉取
- `Auto Safe Pull`：自动拉取非冲突数据，遇冲突停下
- `Auto Full (Pull + Push)`：自动拉取 + 自动推送，并按策略处理冲突

3. 冲突策略可选
- `Local Wins`：保留本地版本，并回写服务器
- `Server Wins`：使用服务器版本覆盖本地

4. 可观测性增强
- 实时状态：连接、运行状态、上次检查/同步/拉取、HTTP 状态码
- 结果统计：新增/更新/删除、applied/noop/stale/failed
- 冲突队列：待处理冲突条数与预览

## 2. 与 cherry-sync-server 配合

服务端项目：
- [ifastcc/cherry-sync-server](https://github.com/ifastcc/cherry-sync-server)

### 2.1 启动服务端（最简）

```bash
export SYNC_TOKEN="your-secret-token"
export PORT=3456
node server.js
```

### 2.2 客户端配置

在 Cherry Studio 中打开：
- `设置 -> 数据 -> Topic Sync`

填写：
- `Sync Server`：例如 `http://127.0.0.1:3456`
- `Sync Token`：与服务端 `SYNC_TOKEN` 一致

点击：
- `Save`
- `Check Connection`（确认连接与鉴权）

## 3. 配置优先级（很重要）

当前生效配置优先级：

1. `localStorage`（设置页保存）
2. `cherry-sync.json`（应用数据目录）
3. `.env`（`RENDERER_VITE_SYNC_SERVER` / `RENDERER_VITE_SYNC_TOKEN`）

也就是说，设置页里保存过之后，会覆盖 `cherry-sync.json` 和 `.env`。

## 4. cherry-sync.json 兼容格式

如果你仍希望用文件分发配置（例如统一发给多人），可在 App Data 目录放：

```json
{
  "server": "http://你的服务器:3456",
  "token": "你的同步Token"
}
```

注意：
- 一旦用户在设置页保存了本地覆盖值，文件配置优先级会被压到后面
- 可在设置页点击 `Clear` 清除本地覆盖，恢复文件/.env 生效

## 5. 推荐同步策略

### 5.1 单人多设备（追求全自动）
- 模式：`Auto Full (Pull + Push)`
- 冲突策略：`Local Wins` 或 `Server Wins`（按你习惯）

### 5.2 多设备都频繁编辑（追求稳）
- 模式：`Auto Safe Pull` + 定期 `Pull Preview`/`Apply Safe Pull`
- 冲突策略：建议先 `Server Wins`，降低误覆盖风险

### 5.3 一主多从（主机写、其他只看）
- 主设备：`Auto Full`
- 从设备：`Auto Safe Pull` 或 `Manual Pull`

## 6. 与 cherry-reader 协同

`cherry-reader` 也已支持与同一 `cherry-sync-server` 做双向同步与冲突处理。

协同建议：
- 两端使用同一个 `server + token`
- 两端尽量统一冲突策略，避免行为认知不一致
- 若跨端大量并发编辑，优先用 `Auto Safe Pull` + 手动处理冲突

## 7. 常见问题排查

1. `Unauthorized` / 401
- Token 不一致或缺失
- 重新保存 Token 后点 `Check Connection`

2. `Offline` 或连接失败
- 服务端地址不可达
- 服务器未启动/端口未开放

3. 一直没有拉取到新数据
- 检查是否处于 `Push Only` 模式
- 检查 `Pull Cursor` 与 `Last Pull Result`

4. 冲突一直堆积
- 在设置页用 `Resolve Local Wins` 或 `Resolve Server Wins`
- 处理后再执行一次 `Sync Now`

## 8. 最佳实践（版本演进）

- 先升级 `cherry-sync-server`，再升级客户端
- 修改冲突策略前先做一次手动同步，避免旧冲突残留
- 若做大规模迁移，建议先导出备份再切到自动模式

---

如果你只关心“这份 fork 的同步怎么用”，本文就是主文档。  
上游 Cherry Studio 文档请以官方仓库为准，本 fork 的同步行为以本文为准。
