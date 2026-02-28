/**
 * Cherry Studio → Sync Server 增量推送
 *
 * 零侵入设计：只需在 entryPoint.tsx 中 import 此文件即可启用同步。
 * 逻辑：每 SYNC_INTERVAL 毫秒轮询一次，对比 Topic 快照（ID + updatedAt），
 *        将新增/更新/删除的 Topic 推送到同步服务器。
 *
 * 配置方式（优先级从高到低）：
 *   1. localStorage（运行时覆盖，DevTools Console 中设置）：
 *      localStorage.setItem('cherry-sync-server', 'http://your-server:3456')
 *      localStorage.setItem('cherry-sync-token', 'your-token')
 *   2. .env 文件（项目根目录，参考 .env.sync 模板）：
 *      RENDERER_VITE_SYNC_SERVER=http://your-server:3456
 *      RENDERER_VITE_SYNC_TOKEN=your-token
 */
import { loggerService } from '@logger'
import db from '@renderer/databases'

const logger = loggerService.withContext('TopicSync')

// ── 配置 ──────────────────────────────────────────────────────────────

const SYNC_INTERVAL = 30_000 // 30 秒
const BATCH_SIZE = 20 // 批量上传时每批最大数量
const INIT_DELAY = 8_000 // 初始化延迟（等 Dexie + Redux persist 准备好）
const REQUEST_TIMEOUT = 15_000
const CONFIG_CACHE_TTL = 30_000

let cachedServer: string | null = null
let cachedToken: string | null = null
let cachedConfigAt = 0
let cachedLocalOverrides = ''

async function getConfig() {
  const localServer = localStorage.getItem('cherry-sync-server') || ''
  const localToken = localStorage.getItem('cherry-sync-token') || ''
  const localOverrides = `${localServer}|${localToken}`
  const now = Date.now()

  if (
    cachedServer !== null &&
    cachedToken !== null &&
    cachedLocalOverrides === localOverrides &&
    now - cachedConfigAt < CONFIG_CACHE_TTL
  ) {
    return { server: cachedServer, token: cachedToken }
  }

  let server = localServer || import.meta.env.RENDERER_VITE_SYNC_SERVER || ''
  let token = localToken || import.meta.env.RENDERER_VITE_SYNC_TOKEN || ''

  try {
    // 尝试读取本地配置文件 (支持极低侵入的分发模式)
    const appInfo = await window.api.getAppInfo()
    if (appInfo && appInfo.appDataPath) {
      const configPath = `${appInfo.appDataPath}/cherry-sync.json`
      const configText = await window.api.fs.readText(configPath).catch(() => null)
      if (configText) {
        const configJson = JSON.parse(configText)
        if (configJson.server && !localStorage.getItem('cherry-sync-server')) {
          server = configJson.server
        }
        if (configJson.token && !localStorage.getItem('cherry-sync-token')) {
          token = configJson.token
        }
      }
    }
  } catch (error) {
    // 忽略读取配置文件失败
  }

  cachedServer = server.replace(/\/+$/, '')
  cachedToken = token
  cachedConfigAt = now
  cachedLocalOverrides = localOverrides

  return { server: cachedServer, token: cachedToken }
}

interface TopicFullData {
  topicId: string
  name: string
  assistantId: string | null
  assistantName: string
  createdAt: string | null
  updatedAt: string | null
  messages: Array<{
    id: string
    role: string
    createdAt: string
    status: string
    model?: unknown
    usage?: unknown
    metrics?: unknown
    mentions?: unknown
    blocks: unknown[]
  }>
}

type SyncActionStatus = 'applied' | 'noop' | 'stale' | 'not_found' | 'error'

interface SyncActionResult {
  ok: boolean
  topicId: string
  status: SyncActionStatus
  seq?: number
  revision?: number
  error?: string
}

// ── 状态 ──────────────────────────────────────────────────────────────

const SNAPSHOT_KEY_PREFIX = 'cherry-sync-snapshot:' // localStorage key prefix for persisted snapshot

function snapshotStorageKey(server: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${server || 'default'}`
}

/** 从 localStorage 恢复上次的快照（App 重启后不丢失） */
function loadPersistedSnapshot(server: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(snapshotStorageKey(server))
    if (!raw) return new Map()
    const entries: [string, string][] = JSON.parse(raw)
    return new Map(entries)
  } catch {
    return new Map()
  }
}

/** 将快照持久化到 localStorage */
function savePersistedSnapshot(server: string, snapshot: Map<string, string>) {
  try {
    localStorage.setItem(snapshotStorageKey(server), JSON.stringify([...snapshot.entries()]))
  } catch {
    // localStorage 满了之类的极端情况，忽略
  }
}

let previousSnapshot: Map<string, string> | null = null // null = 尚未初始化
let previousSnapshotServer: string | null = null
let isSyncRunning = false
const TERMINAL_STATUSES = new Set<SyncActionStatus>(['applied', 'noop', 'stale', 'not_found'])

import store from '@renderer/store'

// ── 工具函数 ──────────────────────────────────────────────────────────

/** 从 Redux Store 提取 Topic 元数据快照（完全消除 localStorage parse 的性能问题） */
function getTopicSnapshotFromStore(): Map<string, string> {
  try {
    const state = store.getState()
    const assistants = state.assistants?.assistants || []

    const snapshot = new Map<string, string>()
    for (const assistant of assistants) {
      for (const topic of assistant.topics || []) {
        if (topic.id) {
          snapshot.set(topic.id, topic.updatedAt || topic.createdAt || '')
        }
      }
    }
    return snapshot
  } catch (e) {
    logger.error('Failed to read store snapshot:', e instanceof Error ? e : new Error(String(e)))
    return new Map()
  }
}

/** 获取 Topic 元数据（名字、assistantId 等），来自 Redux Store */
function getTopicMeta(topicId: string): {
  name: string
  assistantId: string | null
  assistantName: string
  createdAt: string | null
  updatedAt: string | null
} | null {
  try {
    const state = store.getState()
    const assistants = state.assistants?.assistants || []

    for (const assistant of assistants) {
      const found = (assistant.topics || []).find((t: { id: string }) => t.id === topicId)
      if (found) {
        return {
          name: found.name || '未命名',
          assistantId: assistant.id || null,
          assistantName: assistant.name || '',
          createdAt: found.createdAt || null,
          updatedAt: found.updatedAt || null
        }
      }
    }
    return null
  } catch {
    return null
  }
}

/** 从 IndexedDB 读取 Topic 完整消息数据并组装 */
async function getTopicFullData(topicId: string): Promise<TopicFullData | null> {
  try {
    const topic = await db.topics.get(topicId)
    if (!topic) return null

    const messages = topic.messages || []
    if (messages.length === 0) {
      const meta = getTopicMeta(topicId)
      return {
        topicId,
        name: meta?.name || '未命名',
        assistantId: meta?.assistantId || null,
        assistantName: meta?.assistantName || '',
        createdAt: meta?.createdAt || null,
        updatedAt: meta?.updatedAt || null,
        messages: []
      }
    }

    // 批量获取所有相关的 message blocks
    const allBlockIds = messages.flatMap((m) => (m.blocks || []).map(String))
    const blocks = allBlockIds.length > 0 ? await db.message_blocks.where('id').anyOf(allBlockIds).toArray() : []

    const blockMap = new Map(blocks.map((b) => [b.id, b]))
    const meta = getTopicMeta(topicId)

    return {
      topicId,
      name: meta?.name || '未命名',
      assistantId: meta?.assistantId || null,
      assistantName: meta?.assistantName || '',
      createdAt: meta?.createdAt || null,
      updatedAt: meta?.updatedAt || null,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        createdAt: msg.createdAt,
        status: msg.status,
        model: msg.model,
        usage: msg.usage,
        metrics: msg.metrics,
        mentions: msg.mentions,
        blocks: (msg.blocks || []).map((bid) => blockMap.get(String(bid))).filter(Boolean)
      }))
    }
  } catch (e) {
    logger.error(`Failed to get topic data for ${topicId}`, e instanceof Error ? e : new Error(String(e)))
    return null
  }
}

// ── HTTP 工具 ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function toSyncActionResult(
  fallbackTopicId: string,
  payload: unknown,
  fallbackError = 'invalid_response'
): SyncActionResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, topicId: fallbackTopicId, status: 'error', error: fallbackError }
  }

  const item = payload as Record<string, unknown>
  const statusRaw = typeof item.status === 'string' ? item.status : 'error'
  const status = (['applied', 'noop', 'stale', 'not_found', 'error'].includes(statusRaw)
    ? statusRaw
    : 'error') as SyncActionStatus

  return {
    ok: item.ok === true || status !== 'error',
    topicId: (item.topicId as string) || fallbackTopicId,
    status,
    seq: typeof item.seq === 'number' ? item.seq : undefined,
    revision: typeof item.revision === 'number' ? item.revision : undefined,
    error: typeof item.error === 'string' ? item.error : undefined
  }
}

async function apiPostTopic(topic: TopicFullData): Promise<SyncActionResult> {
  const { server, token } = await getConfig()
  if (!server) return { ok: false, topicId: topic.topicId, status: 'error', error: 'missing_server' }
  try {
    const resp = await fetchWithTimeout(`${server}/api/topics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(topic)
    })
    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`POST /api/topics failed: ${resp.status} ${text}`)
      return { ok: false, topicId: topic.topicId, status: 'error', error: `http_${resp.status}` }
    }

    return toSyncActionResult(topic.topicId, decoded)
  } catch (e) {
    logger.error('POST /api/topics network error', e instanceof Error ? e : new Error(String(e)))
    return { ok: false, topicId: topic.topicId, status: 'error', error: 'network_error' }
  }
}

async function apiPostBatch(topics: TopicFullData[]): Promise<Map<string, SyncActionResult>> {
  const { server, token } = await getConfig()
  const out = new Map<string, SyncActionResult>()

  if (!server) {
    for (const topic of topics) {
      out.set(topic.topicId, {
        ok: false,
        topicId: topic.topicId,
        status: 'error',
        error: 'missing_server'
      })
    }
    return out
  }

  try {
    const resp = await fetchWithTimeout(`${server}/api/topics/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ topics })
    })

    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`POST /api/topics/batch failed: ${resp.status} ${text}`)
      for (const topic of topics) {
        out.set(topic.topicId, {
          ok: false,
          topicId: topic.topicId,
          status: 'error',
          error: `http_${resp.status}`
        })
      }
      return out
    }

    const results =
      decoded &&
      typeof decoded === 'object' &&
      Array.isArray((decoded as Record<string, unknown>).results)
        ? ((decoded as Record<string, unknown>).results as unknown[])
        : []

    for (const topic of topics) {
      out.set(topic.topicId, {
        ok: false,
        topicId: topic.topicId,
        status: 'error',
        error: 'missing_result'
      })
    }

    for (const item of results) {
      const topicId = (item as Record<string, unknown>)?.topicId
      if (typeof topicId !== 'string' || !topicId) continue
      out.set(topicId, toSyncActionResult(topicId, item))
    }
  } catch (e) {
    logger.error('POST /api/topics/batch network error', e instanceof Error ? e : new Error(String(e)))
    for (const topic of topics) {
      out.set(topic.topicId, {
        ok: false,
        topicId: topic.topicId,
        status: 'error',
        error: 'network_error'
      })
    }
  }

  return out
}

async function apiDeleteBatch(topicIds: string[]): Promise<Map<string, SyncActionResult>> {
  const { server, token } = await getConfig()
  const out = new Map<string, SyncActionResult>()
  if (!server) {
    for (const topicId of topicIds) {
      out.set(topicId, { ok: false, topicId, status: 'error', error: 'missing_server' })
    }
    return out
  }

  try {
    const resp = await fetchWithTimeout(`${server}/api/topics/delete-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ topicIds })
    })

    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`POST /api/topics/delete-batch failed: ${resp.status} ${text}`)
      for (const topicId of topicIds) {
        out.set(topicId, { ok: false, topicId, status: 'error', error: `http_${resp.status}` })
      }
      return out
    }

    const results =
      decoded &&
      typeof decoded === 'object' &&
      Array.isArray((decoded as Record<string, unknown>).results)
        ? ((decoded as Record<string, unknown>).results as unknown[])
        : []

    for (const topicId of topicIds) {
      out.set(topicId, { ok: false, topicId, status: 'error', error: 'missing_result' })
    }

    for (const item of results) {
      const topicId = (item as Record<string, unknown>)?.topicId
      if (typeof topicId !== 'string' || !topicId) continue
      out.set(topicId, toSyncActionResult(topicId, item))
    }
  } catch (e) {
    logger.error('POST /api/topics/delete-batch network error', e instanceof Error ? e : new Error(String(e)))
    for (const topicId of topicIds) {
      out.set(topicId, { ok: false, topicId, status: 'error', error: 'network_error' })
    }
  }

  return out
}

let syncTimeout: ReturnType<typeof setTimeout> | null = null
let lastAssistantsState: unknown = null

function logSyncResult({
  added,
  updated,
  deleted,
  applied,
  noop,
  stale,
  failed
}: {
  added: number
  updated: number
  deleted: number
  applied: number
  noop: number
  stale: number
  failed: number
}) {
  const message =
    `Sync completed: +${added} ~${updated} -${deleted}; ` +
    `applied=${applied}, noop=${noop}, stale=${stale}, failed=${failed}`

  if (failed > 0) {
    logger.warn(message, { logToMain: true })
    return
  }

  if (applied > 0) {
    logger.info(message)
    return
  }

  logger.verbose(message)
}

// ── 同步主循环 ────────────────────────────────────────────────────────

async function syncOnce(): Promise<void> {
  const { server } = await getConfig()
  if (!server) return // 未配置同步服务器，静默跳过
  if (isSyncRunning) return
  isSyncRunning = true

  try {
    const currentSnapshot = getTopicSnapshotFromStore()

    // 首次运行：从 localStorage 恢复快照（可能为空）
    if (previousSnapshot === null || previousSnapshotServer !== server) {
      previousSnapshot = loadPersistedSnapshot(server)
      previousSnapshotServer = server
      logger.info(
        `Initialized: ${currentSnapshot.size} local topics, ` + `${previousSnapshot.size} in last synced snapshot`
      )
      // 不 return —— 继续往下 diff，这样：
      // - 全新安装（空快照）→ 所有 Topic 视为"新增" → 全量推送
      // - 重启（有快照）→ 只推送变更的 Topic
    }

    // 计算 diff
    const added: string[] = []
    const updated: string[] = []
    const deleted: string[] = []

    for (const [id, updatedAt] of currentSnapshot) {
      if (!previousSnapshot.has(id)) {
        added.push(id)
      } else if (previousSnapshot.get(id) !== updatedAt) {
        updated.push(id)
      }
    }

    for (const id of previousSnapshot.keys()) {
      if (!currentSnapshot.has(id)) {
        deleted.push(id)
      }
    }

    if (added.length === 0 && updated.length === 0 && deleted.length === 0) {
      return // 无变更
    }

    const nextSnapshot = new Map(previousSnapshot)
    let appliedCount = 0
    let noopCount = 0
    let staleCount = 0
    let failedCount = 0

    // 处理新增 + 更新：获取完整数据并上传
    const toUpload = [...added, ...updated]
    if (toUpload.length > 0) {
      // 分批上传
      for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE)
        const topicsData: TopicFullData[] = []

        for (const id of batch) {
          const data = await getTopicFullData(id)
          if (data) topicsData.push(data)
        }

        if (topicsData.length === 1) {
          const one = topicsData[0]
          const result = await apiPostTopic(one)
          if (TERMINAL_STATUSES.has(result.status)) {
            const marker = currentSnapshot.get(one.topicId)
            if (marker !== undefined) nextSnapshot.set(one.topicId, marker)
          }
          if (result.status === 'applied') appliedCount++
          else if (result.status === 'noop' || result.status === 'not_found') noopCount++
          else if (result.status === 'stale') staleCount++
          else failedCount++
        } else if (topicsData.length > 1) {
          const results = await apiPostBatch(topicsData)
          for (const topic of topicsData) {
            const result = results.get(topic.topicId)
            if (result && TERMINAL_STATUSES.has(result.status)) {
              const marker = currentSnapshot.get(topic.topicId)
              if (marker !== undefined) nextSnapshot.set(topic.topicId, marker)
            }

            const status = result?.status ?? 'error'
            if (status === 'applied') appliedCount++
            else if (status === 'noop' || status === 'not_found') noopCount++
            else if (status === 'stale') staleCount++
            else failedCount++
          }
        }
      }
    }

    // 处理删除
    for (let i = 0; i < deleted.length; i += BATCH_SIZE) {
      const batch = deleted.slice(i, i + BATCH_SIZE)
      const results = await apiDeleteBatch(batch)
      for (const id of batch) {
        const result = results.get(id)
        if (result && TERMINAL_STATUSES.has(result.status)) {
          nextSnapshot.delete(id)
        }

        const status = result?.status ?? 'error'
        if (status === 'applied') appliedCount++
        else if (status === 'noop' || status === 'not_found') noopCount++
        else if (status === 'stale') staleCount++
        else failedCount++
      }
    }

    logSyncResult({
      added: added.length,
      updated: updated.length,
      deleted: deleted.length,
      applied: appliedCount,
      noop: noopCount,
      stale: staleCount,
      failed: failedCount
    })

    // 更新快照（内存 + 持久化）
    previousSnapshot = nextSnapshot
    savePersistedSnapshot(server, nextSnapshot)
  } catch (e) {
    logger.error('Sync loop error', e instanceof Error ? e : new Error(String(e)))
  } finally {
    isSyncRunning = false
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────

async function start() {
  const { server } = await getConfig()
  if (!server) {
    logger.info('No sync server configured. Set .env RENDERER_VITE_SYNC_SERVER or localStorage "cherry-sync-server".')
    return
  }

  logger.info(`Starting sync to ${server} via Redux store subscription (debounce=${SYNC_INTERVAL}ms)`)

  // 立即执行一次（建立基线）
  syncOnce()

  // 监听 Redux Store 变化
  store.subscribe(() => {
    const currentState = store.getState()
    const currentAssistantsState = currentState.assistants?.assistants

    // 只有当 assistants 状态的内存引用发生变化时，才认为可能需要同步
    if (currentAssistantsState !== lastAssistantsState) {
      lastAssistantsState = currentAssistantsState

      // 防抖：重置倒计时
      if (syncTimeout) {
        clearTimeout(syncTimeout)
      }
      syncTimeout = setTimeout(() => {
        syncOnce()
      }, SYNC_INTERVAL)
    }
  })
}

// 等待 Redux 持久化恢复后再初始化
setTimeout(start, INIT_DELAY)
