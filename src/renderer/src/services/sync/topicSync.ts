/**
 * Cherry Studio → Sync Server 增量推送
 *
 * 零侵入设计：只需在 entryPoint.tsx 中 import 此文件即可启用同步。
 * 逻辑：按配置的同步间隔轮询，对比 Topic 快照（ID + updatedAt），
 *        将新增/更新/删除的 Topic 推送到同步服务器。
 *
 * 配置方式（优先级从高到低）：
 *   1. localStorage（运行时覆盖，设置页中写入）：
 *      localStorage.setItem('cherry-sync-server', 'http://your-server:3456')
 *      localStorage.setItem('cherry-sync-token', 'your-token')
 */
import { loggerService } from '@logger'
import db from '@renderer/databases'
import store from '@renderer/store'
import { updateAssistants } from '@renderer/store/assistants'
import type { Topic } from '@renderer/types'
import type { Message as NewMessage, MessageBlock } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus, UserMessageStatus } from '@renderer/types/newMessage'

const logger = loggerService.withContext('TopicSync')

// ── 配置 ──────────────────────────────────────────────────────────────

const DEFAULT_SYNC_INTERVAL_MS = 30_000 // 30 秒
const MIN_SYNC_INTERVAL_MS = 10_000
const MAX_SYNC_INTERVAL_MS = 3_600_000
const BATCH_SIZE = 20 // 批量上传时每批最大数量
const INIT_DELAY = 8_000 // 初始化延迟（等 Dexie + Redux persist 准备好）
const REQUEST_TIMEOUT = 15_000
const CONFIG_CACHE_TTL = 30_000
const CONNECTIVITY_CACHE_TTL = 10_000
const MAX_PULL_ITEMS = 1000
const PULL_PAGE_LIMIT = 200
const SYNC_SERVER_KEY = 'cherry-sync-server'
const SYNC_TOKEN_KEY = 'cherry-sync-token'
const SYNC_RUNTIME_KEY = 'cherry-sync-runtime'
const SYNC_MODE_KEY = 'cherry-sync-mode'
const SYNC_CONFLICT_POLICY_KEY = 'cherry-sync-conflict-policy'
const SYNC_INTERVAL_KEY = 'cherry-sync-interval-ms'
const PULL_CURSOR_KEY_PREFIX = 'cherry-sync-pull-cursor:'

type ConfigSource = 'localStorage' | 'none'
type ConnectionStatus = 'unknown' | 'online' | 'offline' | 'unauthorized'
type SyncMode = 'push_only' | 'manual_pull' | 'auto_safe' | 'auto_full'
type ConflictPolicy = 'local_wins' | 'server_wins'
type PullConflictStrategy = 'stop' | ConflictPolicy
type SyncActionStatus = 'applied' | 'noop' | 'stale' | 'conflict' | 'not_found' | 'error'

interface PullConflictItem {
  seq: number
  topicId: string
  op: 'upsert' | 'delete'
  localUpdatedAt: number
  remoteUpdatedAt: number
  remoteClientUpdatedAt: number
  reason: 'local_newer' | 'remote_timestamp_missing'
}

interface PullSummary {
  total: number
  safe: number
  conflicts: number
  applied: number
  conflictResolvedLocal: number
  conflictResolvedServer: number
  writeBackQueued: number
  nextCursor: number
  blockedSeq: number | null
}

interface PullExecutionResult {
  summary: PullSummary
  pendingConflicts: PullConflictItem[]
}

interface SyncRuntimeResult {
  added: number
  updated: number
  deleted: number
  applied: number
  noop: number
  stale: number
  failed: number
}

interface SyncFailureItem {
  topicId: string
  op: 'upsert' | 'delete'
  status: SyncActionStatus
  error: string | null
}

interface SyncProgressState {
  phase: 'idle' | 'pull' | 'push_upsert' | 'push_delete'
  total: number
  processed: number
  failed: number
}

interface SyncRuntimeState {
  configured: boolean
  server: string
  tokenConfigured: boolean
  configSource: ConfigSource
  syncIntervalMs: number
  syncMode: SyncMode
  conflictPolicy: ConflictPolicy
  pullCursor: number
  connectionStatus: ConnectionStatus
  running: boolean
  lastCheckedAt: number | null
  lastSyncAt: number | null
  lastPullAt: number | null
  lastHttpStatus: number | null
  lastPullSummary: PullSummary | null
  pendingConflicts: PullConflictItem[]
  lastResult: SyncRuntimeResult | null
  lastFailures: SyncFailureItem[]
  syncProgress: SyncProgressState
  lastError: string | null
}

const DEFAULT_SYNC_RUNTIME_STATE: SyncRuntimeState = {
  configured: false,
  server: '',
  tokenConfigured: false,
  configSource: 'none',
  syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
  syncMode: 'push_only',
  conflictPolicy: 'local_wins',
  pullCursor: 0,
  connectionStatus: 'unknown',
  running: false,
  lastCheckedAt: null,
  lastSyncAt: null,
  lastPullAt: null,
  lastHttpStatus: null,
  lastPullSummary: null,
  pendingConflicts: [],
  lastResult: null,
  lastFailures: [],
  syncProgress: {
    phase: 'idle',
    total: 0,
    processed: 0,
    failed: 0
  },
  lastError: null
}

interface ConnectivityProbeResult {
  ok: boolean
  status: ConnectionStatus
  error: string | null
  httpStatus: number | null
}

interface ServerChangeItem {
  seq: number
  topicId: string
  op: 'upsert' | 'delete'
  revision: number
  updatedAt: number
  clientUpdatedAt: number
  topic?: TopicFullData
}

interface PullPlanItem {
  item: ServerChangeItem
  conflict: boolean
  localUpdatedAt: number
  remoteUpdatedAt: number
  remoteClientUpdatedAt: number
  reason?: PullConflictItem['reason']
}

let cachedServer = ''
let cachedToken = ''
let cachedSource: ConfigSource = 'none'
let cachedConfigAt = 0
let cachedLocalOverrides = ''
let cachedConnectivityAt = 0
let cachedConnectivityServer = ''
let cachedConnectivityToken = ''
let cachedConnectivityResult: ConnectivityProbeResult | null = null

function getSyncRuntimeState(): SyncRuntimeState {
  try {
    const raw = localStorage.getItem(SYNC_RUNTIME_KEY)
    if (!raw) return { ...DEFAULT_SYNC_RUNTIME_STATE }

    const parsed = JSON.parse(raw) as Partial<SyncRuntimeState>
    return {
      ...DEFAULT_SYNC_RUNTIME_STATE,
      ...parsed,
      pendingConflicts: Array.isArray(parsed.pendingConflicts) ? [...parsed.pendingConflicts] : [],
      lastPullSummary: parsed.lastPullSummary ? { ...parsed.lastPullSummary } : null,
      lastResult: parsed.lastResult ? { ...parsed.lastResult } : null,
      lastFailures: Array.isArray(parsed.lastFailures) ? [...parsed.lastFailures] : [],
      syncProgress: parsed.syncProgress
        ? {
            ...DEFAULT_SYNC_RUNTIME_STATE.syncProgress,
            ...parsed.syncProgress
          }
        : { ...DEFAULT_SYNC_RUNTIME_STATE.syncProgress }
    }
  } catch {
    return { ...DEFAULT_SYNC_RUNTIME_STATE }
  }
}

function updateSyncRuntimeState(patch: Partial<SyncRuntimeState>) {
  try {
    const nextState: SyncRuntimeState = {
      ...getSyncRuntimeState(),
      ...patch
    }
    localStorage.setItem(SYNC_RUNTIME_KEY, JSON.stringify(nextState))
    window.dispatchEvent(new CustomEvent('cherry-sync-runtime', { detail: nextState }))
  } catch {
    // localStorage 不可用时忽略（不影响同步主流程）
  }
}

function updateRuntimeConfig({ server, token, source }: { server: string; token: string; source: ConfigSource }) {
  const syncMode = getSyncMode()
  const conflictPolicy = getConflictPolicy()
  const syncIntervalMs = getSyncIntervalMs()
  const pullCursor = server ? getPullCursor(server) : 0

  updateSyncRuntimeState({
    configured: Boolean(server),
    server,
    tokenConfigured: Boolean(token),
    configSource: source,
    syncIntervalMs,
    syncMode,
    conflictPolicy,
    pullCursor
  })
}

function isSyncMode(value: unknown): value is SyncMode {
  return value === 'push_only' || value === 'manual_pull' || value === 'auto_safe' || value === 'auto_full'
}

function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return value === 'local_wins' || value === 'server_wins'
}

function getSyncMode(): SyncMode {
  const raw = (localStorage.getItem(SYNC_MODE_KEY) || '').trim()
  if (isSyncMode(raw)) {
    return raw
  }
  return 'push_only'
}

function getConflictPolicy(): ConflictPolicy {
  const raw = (localStorage.getItem(SYNC_CONFLICT_POLICY_KEY) || '').trim()
  if (isConflictPolicy(raw)) return raw
  return 'local_wins'
}

function normalizeSyncIntervalMs(raw: unknown): number {
  let value: number | null = null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = Math.floor(raw)
  } else if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) value = parsed
  }

  if (value === null) return DEFAULT_SYNC_INTERVAL_MS
  return Math.min(MAX_SYNC_INTERVAL_MS, Math.max(MIN_SYNC_INTERVAL_MS, value))
}

function getSyncIntervalMs(): number {
  return normalizeSyncIntervalMs(localStorage.getItem(SYNC_INTERVAL_KEY))
}

function getPullCursorKey(server: string): string {
  return `${PULL_CURSOR_KEY_PREFIX}${server || 'default'}`
}

function getPullCursor(server: string): number {
  const raw = localStorage.getItem(getPullCursorKey(server))
  const parsed = Number.parseInt(raw || '0', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function setPullCursor(server: string, cursor: number): void {
  const safeCursor = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0
  localStorage.setItem(getPullCursorKey(server), String(safeCursor))
}

function readConnectivityCache(server: string, token: string): ConnectivityProbeResult | null {
  const now = Date.now()
  const cacheValid =
    cachedConnectivityResult &&
    cachedConnectivityServer === server &&
    cachedConnectivityToken === token &&
    now - cachedConnectivityAt < CONNECTIVITY_CACHE_TTL

  return cacheValid ? cachedConnectivityResult : null
}

function writeConnectivityCache(server: string, token: string, result: ConnectivityProbeResult) {
  cachedConnectivityServer = server
  cachedConnectivityToken = token
  cachedConnectivityResult = result
  cachedConnectivityAt = Date.now()
}

async function probeConnectivity(server: string, token: string, force = false): Promise<ConnectivityProbeResult> {
  if (!server) {
    return {
      ok: false,
      status: 'unknown',
      error: null,
      httpStatus: null
    }
  }

  if (!force) {
    const cached = readConnectivityCache(server, token)
    if (cached) return cached
  }

  if (!token) {
    const result: ConnectivityProbeResult = {
      ok: false,
      status: 'unauthorized',
      error: 'missing_token',
      httpStatus: null
    }
    writeConnectivityCache(server, token, result)
    return result
  }

  try {
    const resp = await fetchWithTimeout(`${server}/api/sync/changes?cursor=0&limit=1`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    if (resp.ok) {
      const result: ConnectivityProbeResult = {
        ok: true,
        status: 'online',
        error: null,
        httpStatus: resp.status
      }
      writeConnectivityCache(server, token, result)
      return result
    }

    const unauthorized = resp.status === 401 || resp.status === 403
    const result: ConnectivityProbeResult = {
      ok: false,
      status: unauthorized ? 'unauthorized' : 'offline',
      error: unauthorized ? 'unauthorized' : `http_${resp.status}`,
      httpStatus: resp.status
    }
    writeConnectivityCache(server, token, result)
    return result
  } catch (error) {
    const result: ConnectivityProbeResult = {
      ok: false,
      status: 'offline',
      error: error instanceof Error ? error.message : 'network_error',
      httpStatus: null
    }
    writeConnectivityCache(server, token, result)
    return result
  }
}

async function refreshConnectivity(force = false): Promise<ConnectivityProbeResult> {
  const { server, token, source } = await getConfig()

  updateRuntimeConfig({
    server,
    token,
    source
  })

  const probe = await probeConnectivity(server, token, force)
  updateSyncRuntimeState({
    connectionStatus: probe.status,
    lastCheckedAt: Date.now(),
    lastHttpStatus: probe.httpStatus,
    lastError: probe.ok ? null : probe.error
  })

  return probe
}

async function getConfig(): Promise<{ server: string; token: string; source: ConfigSource }> {
  const localServer = localStorage.getItem(SYNC_SERVER_KEY) || ''
  const localToken = localStorage.getItem(SYNC_TOKEN_KEY) || ''
  const localOverrides = `${localServer}|${localToken}`
  const now = Date.now()

  if (cachedConfigAt > 0 && cachedLocalOverrides === localOverrides && now - cachedConfigAt < CONFIG_CACHE_TTL) {
    updateRuntimeConfig({
      server: cachedServer,
      token: cachedToken,
      source: cachedSource
    })
    return { server: cachedServer, token: cachedToken, source: cachedSource }
  }

  const server = localServer
  const token = localToken
  const source: ConfigSource = server ? 'localStorage' : 'none'

  cachedServer = server.replace(/\/+$/, '')
  cachedToken = token
  cachedSource = source
  cachedConfigAt = now
  cachedLocalOverrides = localOverrides

  // 配置发生变化时，失效连通性缓存
  cachedConnectivityAt = 0

  updateRuntimeConfig({
    server: cachedServer,
    token: cachedToken,
    source: cachedSource
  })

  return { server: cachedServer, token: cachedToken, source: cachedSource }
}

interface TopicFullData {
  topicId: string
  name: string
  assistantId: string | null
  assistantName: string
  createdAt: string | null
  updatedAt: string | null
  messages: Array<
    Record<string, unknown> & {
      id: string
      role: string
      blocks: unknown[]
    }
  >
}

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
let isPullRunning = false
const forcedUpsertTopicIds = new Set<string>()
const forcedDeleteTopicIds = new Set<string>()
const TERMINAL_STATUSES = new Set<SyncActionStatus>(['applied', 'noop', 'stale', 'not_found'])

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
      // Keep all message-level metadata (askId/modelId/multiModelMessageStyle/etc.)
      // so sync pull will not break multi-model grouping or layout switching.
      messages: messages.map((msg) => {
        const messageRecord = msg as Record<string, unknown>
        const { blocks: _ignoredBlocks, ...messageMeta } = messageRecord
        return {
          ...messageMeta,
          id: msg.id,
          role: msg.role,
          createdAt: msg.createdAt,
          status: msg.status,
          blocks: (msg.blocks || []).map((bid) => blockMap.get(String(bid))).filter(Boolean)
        }
      })
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

function shortenResponseText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact
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
  const status = (
    ['applied', 'noop', 'stale', 'conflict', 'not_found', 'error'].includes(statusRaw) ? statusRaw : 'error'
  ) as SyncActionStatus

  return {
    ok: item.ok === true || status !== 'error',
    topicId: (item.topicId as string) || fallbackTopicId,
    status,
    seq: typeof item.seq === 'number' ? item.seq : undefined,
    revision: typeof item.revision === 'number' ? item.revision : undefined,
    error: typeof item.error === 'string' ? item.error : undefined
  }
}

async function apiPostTopic(topic: TopicFullData, options?: { force?: boolean }): Promise<SyncActionResult> {
  const { server, token } = await getConfig()
  if (!server) return { ok: false, topicId: topic.topicId, status: 'error', error: 'missing_server' }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
    if (options?.force) {
      headers['X-Sync-Force'] = '1'
    }

    const body = JSON.stringify(topic)
    const bodyBytes = new TextEncoder().encode(body).length
    const resp = await fetchWithTimeout(`${server}/api/topics`, {
      method: 'POST',
      headers,
      body
    })
    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`POST /api/topics failed: ${resp.status} ${shortenResponseText(text)}`)
      if (resp.status === 413) {
        return { ok: false, topicId: topic.topicId, status: 'error', error: `payload_too_large_${bodyBytes}` }
      }
      return { ok: false, topicId: topic.topicId, status: 'error', error: `http_${resp.status}` }
    }

    return toSyncActionResult(topic.topicId, decoded)
  } catch (e) {
    logger.error('POST /api/topics network error', e instanceof Error ? e : new Error(String(e)))
    return { ok: false, topicId: topic.topicId, status: 'error', error: 'network_error' }
  }
}

async function apiPostBatch(
  topics: TopicFullData[],
  options?: { force?: boolean }
): Promise<Map<string, SyncActionResult>> {
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

  // Single topic fallback uses the non-batch endpoint to reduce payload wrapper overhead
  // and avoid repeated 413 responses from /batch for borderline payload sizes.
  if (topics.length === 1) {
    const topic = topics[0]
    const result = await apiPostTopic(topic, options)
    out.set(topic.topicId, result)
    return out
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
    if (options?.force) {
      headers['X-Sync-Force'] = '1'
    }

    const resp = await fetchWithTimeout(`${server}/api/topics/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ topics })
    })

    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`POST /api/topics/batch failed: ${resp.status} ${shortenResponseText(text)}`)
      if (resp.status === 413 && topics.length > 1) {
        const middle = Math.ceil(topics.length / 2)
        const left = await apiPostBatch(topics.slice(0, middle), options)
        const right = await apiPostBatch(topics.slice(middle), options)
        for (const [topicId, result] of left.entries()) {
          out.set(topicId, result)
        }
        for (const [topicId, result] of right.entries()) {
          out.set(topicId, result)
        }
        return out
      }
      for (const topic of topics) {
        const payloadBytes = new TextEncoder().encode(JSON.stringify(topic)).length
        out.set(topic.topicId, {
          ok: false,
          topicId: topic.topicId,
          status: 'error',
          error: resp.status === 413 ? `payload_too_large_${payloadBytes}` : `http_${resp.status}`
        })
      }
      return out
    }

    const results =
      decoded && typeof decoded === 'object' && Array.isArray((decoded as Record<string, unknown>).results)
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
      logger.error(`POST /api/topics/delete-batch failed: ${resp.status} ${shortenResponseText(text)}`)
      for (const topicId of topicIds) {
        out.set(topicId, { ok: false, topicId, status: 'error', error: `http_${resp.status}` })
      }
      return out
    }

    const results =
      decoded && typeof decoded === 'object' && Array.isArray((decoded as Record<string, unknown>).results)
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMessageBlockStatus(value: unknown): MessageBlockStatus {
  if (
    value === MessageBlockStatus.PENDING ||
    value === MessageBlockStatus.PROCESSING ||
    value === MessageBlockStatus.STREAMING ||
    value === MessageBlockStatus.SUCCESS ||
    value === MessageBlockStatus.ERROR ||
    value === MessageBlockStatus.PAUSED
  ) {
    return value
  }
  return MessageBlockStatus.SUCCESS
}

function toMessageStatus(value: unknown): NewMessage['status'] {
  if (value === UserMessageStatus.SUCCESS) {
    return value
  }

  if (
    value === AssistantMessageStatus.PROCESSING ||
    value === AssistantMessageStatus.PENDING ||
    value === AssistantMessageStatus.SEARCHING ||
    value === AssistantMessageStatus.SUCCESS ||
    value === AssistantMessageStatus.PAUSED ||
    value === AssistantMessageStatus.ERROR
  ) {
    return value
  }

  return AssistantMessageStatus.SUCCESS
}

function parseTimeMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function toIsoString(value: unknown): string {
  const parsed = parseTimeMs(value)
  if (parsed > 0) return new Date(parsed).toISOString()
  return new Date().toISOString()
}

function parseServerChangeItem(raw: unknown): ServerChangeItem | null {
  if (!isRecord(raw)) return null

  const seq = Number(raw.seq || 0)
  const topicId = typeof raw.topicId === 'string' ? raw.topicId : ''
  const opRaw = raw.op
  const op = opRaw === 'delete' ? 'delete' : opRaw === 'upsert' ? 'upsert' : null
  if (!topicId || !op || !Number.isFinite(seq) || seq <= 0) return null

  return {
    seq,
    topicId,
    op,
    revision: Number(raw.revision || 0),
    updatedAt: Number(raw.updatedAt || 0),
    clientUpdatedAt: Number(raw.clientUpdatedAt || 0),
    topic: isRecord(raw.topic) ? (raw.topic as TopicFullData) : undefined
  }
}

async function fetchServerChanges(
  server: string,
  token: string,
  cursor: number
): Promise<{ items: ServerChangeItem[]; nextCursor: number; hasMore: boolean }> {
  const resp = await fetchWithTimeout(
    `${server}/api/sync/changes?cursor=${cursor}&limit=${PULL_PAGE_LIMIT}&includePayload=1`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  )

  const text = await resp.text()
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = null
  }

  if (!resp.ok) {
    throw new Error(`pull_http_${resp.status}`)
  }

  const root = isRecord(payload) ? payload : {}
  const rawItems = Array.isArray(root.items) ? root.items : []
  const items = rawItems.map(parseServerChangeItem).filter(Boolean) as ServerChangeItem[]
  const nextCursor = Number(root.nextCursor ?? cursor)
  const hasMore = root.hasMore === true

  return {
    items,
    nextCursor: Number.isFinite(nextCursor) ? nextCursor : cursor,
    hasMore
  }
}

async function fetchAllServerChanges(
  server: string,
  token: string,
  cursor: number
): Promise<{ items: ServerChangeItem[]; nextCursor: number }> {
  const items: ServerChangeItem[] = []
  let currentCursor = cursor
  let pages = 0

  while (pages < 50 && items.length < MAX_PULL_ITEMS) {
    const page = await fetchServerChanges(server, token, currentCursor)
    pages += 1
    items.push(...page.items)
    currentCursor = page.nextCursor

    if (!page.hasMore) break
    if (page.items.length === 0) break
  }

  return {
    items: items.slice(0, MAX_PULL_ITEMS),
    nextCursor: currentCursor
  }
}

function cloneAssistantsForUpdate(): any[] {
  const assistants = store.getState().assistants?.assistants || []
  return assistants.map((assistant: any) => ({
    ...assistant,
    topics: Array.isArray(assistant.topics) ? [...assistant.topics] : []
  }))
}

function resolveAssistantId(assistants: any[], incoming: TopicFullData): string {
  if (incoming.assistantId && assistants.some((assistant) => assistant.id === incoming.assistantId)) {
    return incoming.assistantId
  }

  if (incoming.assistantName) {
    const byName = assistants.find((assistant) => assistant.name === incoming.assistantName)
    if (byName?.id) return byName.id
  }

  const defaultAssistantId = store.getState().assistants?.defaultAssistant?.id
  if (defaultAssistantId) return defaultAssistantId
  if (assistants[0]?.id) return assistants[0].id

  return incoming.assistantId || 'default'
}

function upsertTopicMetaInAssistants(assistants: any[], assistantId: string, topicMeta: Topic): boolean {
  let changed = false

  for (const assistant of assistants) {
    if (!Array.isArray(assistant.topics)) assistant.topics = []
    if (assistant.id !== assistantId) {
      const before = assistant.topics.length
      assistant.topics = assistant.topics.filter((topic: any) => topic.id !== topicMeta.id)
      if (assistant.topics.length !== before) changed = true
    }
  }

  const target = assistants.find((assistant) => assistant.id === assistantId)
  if (!target) return changed

  const index = target.topics.findIndex((topic: any) => topic.id === topicMeta.id)
  if (index >= 0) {
    target.topics[index] = {
      ...target.topics[index],
      ...topicMeta,
      messages: []
    }
    changed = true
  } else {
    target.topics.unshift({
      ...topicMeta,
      messages: []
    })
    changed = true
  }

  return changed
}

function removeTopicMetaFromAssistants(assistants: any[], topicId: string): boolean {
  let changed = false
  for (const assistant of assistants) {
    if (!Array.isArray(assistant.topics)) continue
    const before = assistant.topics.length
    assistant.topics = assistant.topics.filter((topic: any) => topic.id !== topicId)
    if (assistant.topics.length !== before) changed = true
  }
  return changed
}

function normalizeIncomingTopic(
  incoming: TopicFullData,
  assistantId: string
): { topicMeta: Topic; messages: NewMessage[]; blocks: MessageBlock[] } {
  const now = new Date().toISOString()
  const createdAt = typeof incoming.createdAt === 'string' && incoming.createdAt ? incoming.createdAt : now
  const updatedAt = typeof incoming.updatedAt === 'string' && incoming.updatedAt ? incoming.updatedAt : createdAt

  const blockMap = new Map<string, MessageBlock>()
  const messages: NewMessage[] = (Array.isArray(incoming.messages) ? incoming.messages : []).map((message, index) => {
    const messageRecord: Record<string, unknown> = isRecord(message) ? message : {}
    const messageId =
      typeof messageRecord.id === 'string' && messageRecord.id ? messageRecord.id : `${incoming.topicId}:msg:${index}`
    const role =
      messageRecord.role === 'user' || messageRecord.role === 'assistant' || messageRecord.role === 'system'
        ? messageRecord.role
        : 'assistant'

    const blocks = Array.isArray(messageRecord.blocks) ? messageRecord.blocks : []
    const blockIds: string[] = []

    for (const blockRaw of blocks) {
      if (!isRecord(blockRaw)) continue
      const blockRecord: Record<string, unknown> = blockRaw

      const blockId =
        typeof blockRecord.id === 'string' && blockRecord.id
          ? blockRecord.id
          : `${incoming.topicId}:${messageId}:block:${blockIds.length}`

      const block: MessageBlock = {
        ...(blockRecord as unknown as MessageBlock),
        id: blockId,
        messageId,
        createdAt: typeof blockRecord.createdAt === 'string' ? blockRecord.createdAt : toIsoString(blockRecord.createdAt),
        status: toMessageBlockStatus(blockRecord.status)
      }

      blockMap.set(blockId, block)
      blockIds.push(blockId)
    }

    const { blocks: _incomingBlocks, ...messageMeta } = messageRecord

    const normalizedMessage: NewMessage = {
      ...(messageMeta as Partial<NewMessage>),
      id: messageId,
      role,
      assistantId,
      topicId: incoming.topicId,
      createdAt: typeof messageRecord.createdAt === 'string' ? messageRecord.createdAt : toIsoString(messageRecord.createdAt),
      updatedAt:
        typeof messageRecord.updatedAt === 'string'
          ? messageRecord.updatedAt
          : messageRecord.updatedAt != null
            ? toIsoString(messageRecord.updatedAt)
            : undefined,
      status: toMessageStatus(messageRecord.status),
      mentions: Array.isArray(messageRecord.mentions) ? messageRecord.mentions : undefined,
      blocks: blockIds
    }

    return normalizedMessage
  })

  const topicMeta: Topic = {
    id: incoming.topicId,
    assistantId,
    name: incoming.name || '未命名',
    createdAt,
    updatedAt,
    messages: []
  }

  return {
    topicMeta,
    messages,
    blocks: [...blockMap.values()]
  }
}

async function applyUpsertToDb(topicId: string, messages: NewMessage[], blocks: MessageBlock[]): Promise<void> {
  await db.transaction('rw', db.topics, db.message_blocks, async () => {
    const oldTopic = await db.topics.get(topicId)
    const oldBlockIds = new Set<string>()

    for (const message of oldTopic?.messages || []) {
      for (const blockId of message.blocks || []) {
        if (blockId) oldBlockIds.add(String(blockId))
      }
    }

    if (blocks.length > 0) {
      await db.message_blocks.bulkPut(blocks as any)
    }

    await db.topics.put({
      id: topicId,
      messages
    })

    const newBlockIds = new Set(blocks.map((block) => String(block.id)))
    const staleIds = [...oldBlockIds].filter((id) => !newBlockIds.has(id))
    if (staleIds.length > 0) {
      await db.message_blocks.bulkDelete(staleIds)
    }
  })
}

async function applyDeleteToDb(topicId: string): Promise<void> {
  await db.transaction('rw', db.topics, db.message_blocks, async () => {
    const oldTopic = await db.topics.get(topicId)
    const blockIds = new Set<string>()
    for (const message of oldTopic?.messages || []) {
      for (const blockId of message.blocks || []) {
        if (blockId) blockIds.add(String(blockId))
      }
    }

    await db.topics.delete(topicId)
    if (blockIds.size > 0) {
      await db.message_blocks.bulkDelete([...blockIds])
    }
  })
}

function buildPullPlan(items: ServerChangeItem[]): PullPlanItem[] {
  const snapshot = getTopicSnapshotFromStore()
  const plan: PullPlanItem[] = []

  for (const item of items) {
    const localMarker = snapshot.get(item.topicId)
    if (localMarker === undefined) {
      plan.push({
        item,
        conflict: false,
        localUpdatedAt: 0,
        remoteUpdatedAt: Number(item.updatedAt || 0),
        remoteClientUpdatedAt: Number(item.clientUpdatedAt || 0)
      })
      continue
    }

    const localTs = parseTimeMs(localMarker)
    const remoteClientTs = Number(item.clientUpdatedAt || 0)
    const remoteUpdatedTs = Number(item.updatedAt || 0)
    const remoteTs = Number(item.clientUpdatedAt || item.updatedAt || 0)
    const conflict = remoteTs <= 0 ? true : localTs > remoteTs + 1000
    const reason: PullConflictItem['reason'] | undefined =
      remoteTs <= 0 ? 'remote_timestamp_missing' : conflict ? 'local_newer' : undefined

    plan.push({
      item,
      conflict,
      localUpdatedAt: localTs,
      remoteUpdatedAt: remoteUpdatedTs,
      remoteClientUpdatedAt: remoteClientTs,
      reason
    })
  }

  return plan
}

function toConflictItem(entry: PullPlanItem): PullConflictItem {
  return {
    seq: entry.item.seq,
    topicId: entry.item.topicId,
    op: entry.item.op,
    localUpdatedAt: entry.localUpdatedAt,
    remoteUpdatedAt: entry.remoteUpdatedAt,
    remoteClientUpdatedAt: entry.remoteClientUpdatedAt,
    reason: entry.reason || 'local_newer'
  }
}

function queueWriteBackFromLocalWins(topicIds: Iterable<string>): number {
  const snapshot = getTopicSnapshotFromStore()
  let queued = 0

  for (const topicId of topicIds) {
    if (!topicId) continue
    if (snapshot.has(topicId)) {
      forcedUpsertTopicIds.add(topicId)
      forcedDeleteTopicIds.delete(topicId)
    } else {
      forcedDeleteTopicIds.add(topicId)
      forcedUpsertTopicIds.delete(topicId)
    }
    queued += 1
  }

  return queued
}

function applyPullToSnapshot(
  server: string,
  applied: Array<{ topicId: string; op: 'upsert' | 'delete'; marker?: string }>
) {
  if (!previousSnapshot || previousSnapshotServer !== server) return

  for (const item of applied) {
    if (item.op === 'delete') {
      previousSnapshot.delete(item.topicId)
      continue
    }

    if (item.marker) {
      previousSnapshot.set(item.topicId, item.marker)
    }
  }

  savePersistedSnapshot(server, previousSnapshot)
}

async function pullFromServer({
  applySafe,
  skipConnectivityCheck = false,
  conflictStrategy = 'stop'
}: {
  applySafe: boolean
  skipConnectivityCheck?: boolean
  conflictStrategy?: PullConflictStrategy
}): Promise<PullExecutionResult | null> {
  if (isPullRunning) {
    logger.verbose('Pull skipped: another pull task is still running.')
    return null
  }

  isPullRunning = true
  try {
    const { server, token, source } = await getConfig()
    if (!server) {
      updateRuntimeConfig({ server, token, source })
      return null
    }

    if (applySafe && (previousSnapshot === null || previousSnapshotServer !== server)) {
      previousSnapshot = loadPersistedSnapshot(server)
      previousSnapshotServer = server
    }

    if (!skipConnectivityCheck) {
      const connectivity = await refreshConnectivity(true)
      if (!connectivity.ok) return null
    }

    const cursor = getPullCursor(server)
    updateRuntimeConfig({ server, token, source })

    const fetched = await fetchAllServerChanges(server, token, cursor)
    const plan = buildPullPlan(fetched.items)
    const safe = plan.filter((entry) => !entry.conflict).length
    const conflicts = plan.length - safe
    const firstConflictSeq = plan.find((entry) => entry.conflict)?.item.seq ?? null
    const allConflictItems = plan.filter((entry) => entry.conflict).map(toConflictItem)

    let appliedCount = 0
    let resolvedLocal = 0
    let resolvedServer = 0
    let writeBackQueued = 0
    let blockedSeq: number | null = applySafe ? null : firstConflictSeq
    let lastAppliedSeq = cursor
    const appliedForSnapshot: Array<{ topicId: string; op: 'upsert' | 'delete'; marker?: string }> = []
    const assistants = cloneAssistantsForUpdate()
    let assistantsChanged = false
    const localWinsCandidates = new Set<string>()

    if (applySafe) {
      for (const entry of plan) {
        if (entry.conflict) {
          if (conflictStrategy === 'stop') {
            blockedSeq = entry.item.seq
            break
          }

          if (conflictStrategy === 'local_wins') {
            localWinsCandidates.add(entry.item.topicId)
            resolvedLocal += 1
            lastAppliedSeq = entry.item.seq
            continue
          }
        }

        if (entry.item.op === 'delete') {
          await applyDeleteToDb(entry.item.topicId)
          if (removeTopicMetaFromAssistants(assistants, entry.item.topicId)) {
            assistantsChanged = true
          }
          appliedForSnapshot.push({ topicId: entry.item.topicId, op: 'delete' })
          appliedCount += 1
          if (entry.conflict) {
            resolvedServer += 1
          }
          lastAppliedSeq = entry.item.seq
          continue
        }

        if (!entry.item.topic) {
          blockedSeq = entry.item.seq
          break
        }

        const targetAssistantId = resolveAssistantId(assistants, entry.item.topic)
        const normalized = normalizeIncomingTopic(entry.item.topic, targetAssistantId)
        await applyUpsertToDb(entry.item.topic.topicId, normalized.messages, normalized.blocks)

        if (upsertTopicMetaInAssistants(assistants, targetAssistantId, normalized.topicMeta)) {
          assistantsChanged = true
        }

        appliedForSnapshot.push({
          topicId: entry.item.topic.topicId,
          op: 'upsert',
          marker: normalized.topicMeta.updatedAt || normalized.topicMeta.createdAt
        })
        appliedCount += 1
        if (entry.conflict) {
          resolvedServer += 1
        }
        lastAppliedSeq = entry.item.seq
      }

      if (assistantsChanged) {
        store.dispatch(updateAssistants(assistants))
      }

      if (localWinsCandidates.size > 0) {
        writeBackQueued = queueWriteBackFromLocalWins(localWinsCandidates)
      }
    }

    const nextCursor = applySafe ? (blockedSeq ? lastAppliedSeq : fetched.nextCursor) : cursor
    if (applySafe) {
      setPullCursor(server, nextCursor)
      applyPullToSnapshot(server, appliedForSnapshot)
    }

    const pendingConflicts = applySafe
      ? blockedSeq
        ? allConflictItems.filter((item) => item.seq >= blockedSeq)
        : []
      : allConflictItems

    const summary: PullSummary = {
      total: plan.length,
      safe,
      conflicts,
      applied: appliedCount,
      conflictResolvedLocal: resolvedLocal,
      conflictResolvedServer: resolvedServer,
      writeBackQueued,
      nextCursor,
      blockedSeq
    }

    updateSyncRuntimeState({
      pullCursor: nextCursor,
      lastPullAt: Date.now(),
      lastPullSummary: summary,
      pendingConflicts: pendingConflicts.slice(0, 100),
      lastError: applySafe && blockedSeq ? `Pull blocked by conflict at seq ${blockedSeq}` : null
    })

    return {
      summary,
      pendingConflicts
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateSyncRuntimeState({
      lastError: `Pull failed: ${message}`
    })
    logger.error('Pull failed', error instanceof Error ? error : new Error(message))
    return null
  } finally {
    isPullRunning = false
  }
}

let syncTimeout: ReturnType<typeof setTimeout> | null = null
let syncIntervalTimer: ReturnType<typeof setInterval> | null = null
let lastAssistantsState: unknown = null
let hasStarted = false

function restartSyncIntervalTimer() {
  if (syncIntervalTimer) {
    clearInterval(syncIntervalTimer)
    syncIntervalTimer = null
  }

  const intervalMs = getSyncIntervalMs()
  updateSyncRuntimeState({
    syncIntervalMs: intervalMs
  })

  syncIntervalTimer = setInterval(() => {
    syncOnce()
  }, intervalMs)
}

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

function buildFailureMessage(failures: SyncFailureItem[], failedCount: number): string {
  if (failedCount <= 0) return ''
  if (failures.length === 0) return `Some sync actions failed: ${failedCount}`

  const grouped = new Map<string, number>()
  for (const failure of failures) {
    const key = failure.error || failure.status
    grouped.set(key, (grouped.get(key) || 0) + 1)
  }

  const topReason = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0]
  if (!topReason) return `Some sync actions failed: ${failedCount}`

  return `Sync failed: ${failedCount} actions, top reason=${topReason[0]} (${topReason[1]})`
}

// ── 同步主循环 ────────────────────────────────────────────────────────

async function syncOnce(): Promise<void> {
  const { server } = await getConfig()
  if (isSyncRunning) return
  isSyncRunning = true
  const syncMode = getSyncMode()
  const conflictPolicy = getConflictPolicy()
  updateSyncRuntimeState({
    running: true,
    lastError: null,
    syncMode,
    conflictPolicy,
    pullCursor: server ? getPullCursor(server) : 0,
    syncProgress: {
      phase: 'pull',
      total: 0,
      processed: 0,
      failed: 0
    }
  })

  const connectivity = await refreshConnectivity()
  if (!connectivity.ok) {
    isSyncRunning = false
    updateSyncRuntimeState({
      running: false,
      syncProgress: {
        phase: 'idle',
        total: 0,
        processed: 0,
        failed: 0
      }
    })
    logger.verbose(`Sync skipped: connectivity=${connectivity.status}, error=${connectivity.error || 'none'}`)
    return
  }

  try {
    let didInitSnapshot = false
    if (previousSnapshot === null || previousSnapshotServer !== server) {
      previousSnapshot = loadPersistedSnapshot(server)
      previousSnapshotServer = server
      didInitSnapshot = true
    }

    if (syncMode === 'auto_safe' || syncMode === 'auto_full') {
      const pullResult = await pullFromServer({
        applySafe: true,
        skipConnectivityCheck: true,
        conflictStrategy: syncMode === 'auto_safe' ? 'stop' : conflictPolicy
      })
      if (pullResult) {
        const pullSummary = pullResult.summary
        updateSyncRuntimeState({
          syncProgress: {
            phase: 'pull',
            total: pullSummary.total,
            processed: pullSummary.applied,
            failed: pullSummary.conflicts
          }
        })

        if (pullSummary.conflicts > 0 && pullSummary.blockedSeq) {
          logger.warn(
            `Auto pull paused at seq=${pullSummary.blockedSeq ?? 'unknown'}; ` +
              `safe=${pullSummary.safe}, conflicts=${pullSummary.conflicts}, applied=${pullSummary.applied}`
          )
        } else if (pullSummary.conflictResolvedLocal > 0 || pullSummary.conflictResolvedServer > 0) {
          logger.info(
            `Auto full pull resolved conflicts: local=${pullSummary.conflictResolvedLocal}, ` +
              `server=${pullSummary.conflictResolvedServer}, writeBackQueued=${pullSummary.writeBackQueued}`
          )
        } else if (pullSummary.applied > 0) {
          logger.info(
            `Auto pull applied ${pullSummary.applied} changes; ` +
              `safe=${pullSummary.safe}, conflicts=${pullSummary.conflicts}`
          )
        } else if (pullSummary.total > 0) {
          logger.verbose(
            `Auto pull found ${pullSummary.total} changes; ` +
              `safe=${pullSummary.safe}, conflicts=${pullSummary.conflicts}`
          )
        }
      }
    }

    const currentSnapshot = getTopicSnapshotFromStore()

    // 首次运行：从 localStorage 恢复快照（可能为空）
    if (didInitSnapshot && previousSnapshot) {
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

    const forcedUpserts = [...forcedUpsertTopicIds]

    if (
      added.length === 0 &&
      updated.length === 0 &&
      deleted.length === 0 &&
      forcedUpserts.length === 0 &&
      forcedDeleteTopicIds.size === 0
    ) {
      return // 无变更
    }

    const nextSnapshot = new Map(previousSnapshot)
    let appliedCount = 0
    let noopCount = 0
    let staleCount = 0
    let failedCount = 0
    const failedActions: SyncFailureItem[] = []
    const recordFailure = (
      topicId: string,
      op: 'upsert' | 'delete',
      status: SyncActionStatus,
      error: string | null | undefined
    ) => {
      if (failedActions.length >= 100) return
      failedActions.push({
        topicId,
        op,
        status,
        error: error || null
      })
    }

    // 处理新增 + 更新 + 冲突回写（本地优先）
    const toUpload = [...new Set([...added, ...updated, ...forcedUpserts])]
    let uploadProcessed = 0
    let uploadFailed = 0
    const emitUploadProgress = (force = false) => {
      const total = toUpload.length
      if (!force && uploadProcessed % 5 !== 0 && uploadProcessed !== total) return
      updateSyncRuntimeState({
        syncProgress: {
          phase: 'push_upsert',
          total,
          processed: uploadProcessed,
          failed: uploadFailed
        }
      })
    }

    updateSyncRuntimeState({
      syncProgress: {
        phase: 'push_upsert',
        total: toUpload.length,
        processed: 0,
        failed: 0
      }
    })

    if (toUpload.length > 0) {
      const applyUploadTopics = async (topics: TopicFullData[], forceWrite: boolean) => {
        if (topics.length === 0) return

        if (topics.length === 1) {
          const one = topics[0]
          const result = await apiPostTopic(one, { force: forceWrite })
          if (TERMINAL_STATUSES.has(result.status)) {
            const marker = currentSnapshot.get(one.topicId)
            if (marker !== undefined) nextSnapshot.set(one.topicId, marker)
            if (forcedUpsertTopicIds.has(one.topicId)) {
              forcedUpsertTopicIds.delete(one.topicId)
            }
          }
          if (result.status === 'applied') appliedCount++
          else if (result.status === 'noop' || result.status === 'not_found') noopCount++
          else if (result.status === 'stale') staleCount++
          else {
            failedCount++
            uploadFailed++
            recordFailure(one.topicId, 'upsert', result.status, result.error)
          }
          uploadProcessed++
          emitUploadProgress()
          return
        }

        const results = await apiPostBatch(topics, { force: forceWrite })
        for (const topic of topics) {
          const result = results.get(topic.topicId)
          if (result && TERMINAL_STATUSES.has(result.status)) {
            const marker = currentSnapshot.get(topic.topicId)
            if (marker !== undefined) nextSnapshot.set(topic.topicId, marker)
            if (forcedUpsertTopicIds.has(topic.topicId)) {
              forcedUpsertTopicIds.delete(topic.topicId)
            }
          }

          const status: SyncActionStatus = result?.status ?? 'error'
          if (status === 'applied') appliedCount++
          else if (status === 'noop' || status === 'not_found') noopCount++
          else if (status === 'stale') staleCount++
          else {
            failedCount++
            uploadFailed++
            recordFailure(topic.topicId, 'upsert', status, result?.error)
          }
          uploadProcessed++
          emitUploadProgress()
        }
      }

      // 分批上传
      for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE)
        const topicsData: TopicFullData[] = []

        for (const id of batch) {
          const data = await getTopicFullData(id)
          if (!data) {
            if (forcedUpsertTopicIds.has(id)) {
              forcedUpsertTopicIds.delete(id)
              forcedDeleteTopicIds.add(id)
            }
            uploadProcessed++
            emitUploadProgress()
            continue
          }

          // 冲突后本地优先回写时，强制使用当前时间避免被服务端 stale 拒绝
          if (forcedUpsertTopicIds.has(id)) {
            data.updatedAt = new Date().toISOString()
          }

          topicsData.push(data)
        }

        const forcedTopics = topicsData.filter((topic) => forcedUpsertTopicIds.has(topic.topicId))
        const normalTopics = topicsData.filter((topic) => !forcedUpsertTopicIds.has(topic.topicId))

        await applyUploadTopics(normalTopics, false)
        await applyUploadTopics(forcedTopics, true)
      }
      emitUploadProgress(true)
    }

    // 处理删除
    const toDeleteSet = new Set([...deleted, ...forcedDeleteTopicIds])
    for (const id of toUpload) {
      toDeleteSet.delete(id)
      forcedDeleteTopicIds.delete(id)
    }
    const toDelete = [...toDeleteSet]
    let deleteProcessed = 0
    let deleteFailed = 0
    const emitDeleteProgress = (force = false) => {
      const total = toDelete.length
      if (!force && deleteProcessed % 5 !== 0 && deleteProcessed !== total) return
      updateSyncRuntimeState({
        syncProgress: {
          phase: 'push_delete',
          total,
          processed: deleteProcessed,
          failed: deleteFailed
        }
      })
    }

    updateSyncRuntimeState({
      syncProgress: {
        phase: 'push_delete',
        total: toDelete.length,
        processed: 0,
        failed: 0
      }
    })

    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const batch = toDelete.slice(i, i + BATCH_SIZE)
      const results = await apiDeleteBatch(batch)
      for (const id of batch) {
        const result = results.get(id)
        if (result && TERMINAL_STATUSES.has(result.status)) {
          nextSnapshot.delete(id)
          if (forcedDeleteTopicIds.has(id)) {
            forcedDeleteTopicIds.delete(id)
          }
        }

        const status: SyncActionStatus = result?.status ?? 'error'
        if (status === 'applied') appliedCount++
        else if (status === 'noop' || status === 'not_found') noopCount++
        else if (status === 'stale') staleCount++
        else {
          failedCount++
          deleteFailed++
          recordFailure(id, 'delete', status, result?.error)
        }
        deleteProcessed++
        emitDeleteProgress()
      }
    }
    emitDeleteProgress(true)

    logSyncResult({
      added: added.length,
      updated: updated.length,
      deleted: toDelete.length,
      applied: appliedCount,
      noop: noopCount,
      stale: staleCount,
      failed: failedCount
    })

    updateSyncRuntimeState({
      lastSyncAt: Date.now(),
      lastResult: {
        added: added.length,
        updated: updated.length,
        deleted: toDelete.length,
        applied: appliedCount,
        noop: noopCount,
        stale: staleCount,
        failed: failedCount
      },
      lastFailures: failedCount > 0 ? failedActions : [],
      lastError: failedCount > 0 ? buildFailureMessage(failedActions, failedCount) : null,
      syncProgress: {
        phase: 'idle',
        total: 0,
        processed: 0,
        failed: 0
      }
    })

    // 更新快照（内存 + 持久化）
    previousSnapshot = nextSnapshot
    savePersistedSnapshot(server, nextSnapshot)
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logger.error('Sync loop error', error)
    updateSyncRuntimeState({
      lastFailures: [],
      lastError: error.message,
      syncProgress: {
        phase: 'idle',
        total: 0,
        processed: 0,
        failed: 0
      }
    })
  } finally {
    isSyncRunning = false
    updateSyncRuntimeState({
      running: false,
      syncProgress: {
        phase: 'idle',
        total: 0,
        processed: 0,
        failed: 0
      }
    })
  }
}

async function triggerFullPushToServer(): Promise<void> {
  if (isSyncRunning) {
    logger.verbose('Full push skipped: sync loop is running.')
    return
  }

  const { server, token, source } = await getConfig()
  if (!server) {
    updateRuntimeConfig({ server, token, source })
    logger.warn('Full push skipped: sync server is not configured.')
    return
  }

  const currentSnapshot = getTopicSnapshotFromStore()

  previousSnapshot = new Map()
  previousSnapshotServer = server
  savePersistedSnapshot(server, previousSnapshot)

  forcedUpsertTopicIds.clear()
  forcedDeleteTopicIds.clear()
  for (const topicId of currentSnapshot.keys()) {
    forcedUpsertTopicIds.add(topicId)
  }

  updateSyncRuntimeState({
    configured: true,
    server,
    tokenConfigured: Boolean(token),
    configSource: source,
    pullCursor: getPullCursor(server),
    lastResult: null,
    lastFailures: [],
    lastError: null
  })

  logger.info(`Full push queued (${currentSnapshot.size} topics).`)
  await syncOnce()
}

// ── 启动 ──────────────────────────────────────────────────────────────

async function start() {
  if (hasStarted) return
  hasStarted = true

  const { server } = await getConfig()
  const intervalMs = getSyncIntervalMs()
  if (server) {
    logger.info(`Starting sync to ${server} (interval=${intervalMs}ms)`)
  } else {
    logger.info('No sync server configured. Waiting for config from settings.')
  }

  restartSyncIntervalTimer()

  // 立即执行一次（建立基线）
  syncOnce()

  // 提供手动触发入口，供设置页调用
  window.addEventListener('cherry-sync-force', () => {
    syncOnce()
  })

  window.addEventListener('cherry-sync-push-full', () => {
    triggerFullPushToServer()
  })

  // 提供连通性检查入口，供设置页调用
  window.addEventListener('cherry-sync-check', () => {
    refreshConnectivity(true)
  })

  // 设置同步模式（push_only / manual_pull / auto_safe / auto_full）
  window.addEventListener('cherry-sync-set-mode', (event) => {
    const detail = (event as CustomEvent<{ mode?: SyncMode }>).detail
    if (!isSyncMode(detail?.mode)) return
    localStorage.setItem(SYNC_MODE_KEY, detail.mode)
    updateSyncRuntimeState({
      syncMode: detail.mode
    })
    if (detail.mode === 'auto_safe' || detail.mode === 'auto_full') {
      syncOnce()
    }
  })

  // 设置冲突策略（local_wins / server_wins）
  window.addEventListener('cherry-sync-set-conflict-policy', (event) => {
    const detail = (event as CustomEvent<{ policy?: ConflictPolicy }>).detail
    if (!isConflictPolicy(detail?.policy)) return
    localStorage.setItem(SYNC_CONFLICT_POLICY_KEY, detail.policy)
    updateSyncRuntimeState({
      conflictPolicy: detail.policy
    })
  })

  window.addEventListener('cherry-sync-set-interval', (event) => {
    const detail = (event as CustomEvent<{ intervalMs?: number }>).detail
    const normalized = normalizeSyncIntervalMs(detail?.intervalMs)
    localStorage.setItem(SYNC_INTERVAL_KEY, String(normalized))
    restartSyncIntervalTimer()
  })

  window.addEventListener('cherry-sync-retry-failed-actions', async () => {
    if (isSyncRunning) {
      logger.verbose('Retry failed actions skipped: sync loop is running.')
      return
    }

    const runtime = getSyncRuntimeState()
    if (!runtime.lastFailures.length) return

    for (const failure of runtime.lastFailures) {
      if (!failure.topicId) continue
      if (failure.op === 'delete') {
        forcedDeleteTopicIds.add(failure.topicId)
        forcedUpsertTopicIds.delete(failure.topicId)
      } else {
        forcedUpsertTopicIds.add(failure.topicId)
        forcedDeleteTopicIds.delete(failure.topicId)
      }
    }

    updateSyncRuntimeState({
      lastError: null
    })
    logger.info(`Retry queued for ${runtime.lastFailures.length} failed actions`)
    await syncOnce()
  })

  window.addEventListener('cherry-sync-dismiss-errors', () => {
    updateSyncRuntimeState({
      lastError: null,
      lastFailures: []
    })
    logger.info('Sync errors dismissed by user action')
  })

  window.addEventListener('cherry-sync-rebuild-baseline', async () => {
    if (isSyncRunning) {
      logger.verbose('Rebuild baseline skipped: sync loop is running.')
      return
    }

    const { server, token, source } = await getConfig()
    if (!server) {
      updateRuntimeConfig({ server, token, source })
      return
    }

    const snapshot = getTopicSnapshotFromStore()
    previousSnapshot = new Map(snapshot)
    previousSnapshotServer = server
    savePersistedSnapshot(server, previousSnapshot)
    forcedUpsertTopicIds.clear()
    forcedDeleteTopicIds.clear()

    updateSyncRuntimeState({
      configured: true,
      server,
      tokenConfigured: Boolean(token),
      configSource: source,
      pullCursor: getPullCursor(server),
      lastResult: null,
      lastFailures: [],
      lastError: null
    })
    logger.info(`Sync baseline rebuilt from local snapshot (${snapshot.size} topics)`)
  })

  // 预览服务端增量（只分析，不写本地）
  window.addEventListener('cherry-sync-pull-preview', async () => {
    if (isSyncRunning) {
      logger.verbose('Pull preview skipped: sync loop is running.')
      return
    }

    const result = await pullFromServer({ applySafe: false })
    if (!result) return
    const summary = result.summary

    logger.info(
      `Pull preview: total=${summary.total}, safe=${summary.safe}, ` +
        `conflicts=${summary.conflicts}, cursor=${summary.nextCursor}`
    )
  })

  // 应用可安全拉取的增量，遇到冲突即停（保留 cursor 以便后续人工处理）
  window.addEventListener('cherry-sync-pull-apply', async () => {
    if (isSyncRunning) {
      logger.verbose('Pull apply skipped: sync loop is running.')
      return
    }

    const result = await pullFromServer({ applySafe: true, conflictStrategy: 'stop' })
    if (!result) return
    const summary = result.summary

    if (summary.conflicts > 0) {
      logger.warn(
        `Pull apply paused at seq=${summary.blockedSeq ?? 'unknown'}; ` +
          `safe=${summary.safe}, conflicts=${summary.conflicts}, applied=${summary.applied}`
      )
      return
    }

    if (summary.applied > 0) {
      logger.info(`Pull apply completed: applied=${summary.applied}, cursor=${summary.nextCursor}`)
    } else {
      logger.verbose('Pull apply completed: no safe server changes to apply.')
    }
  })

  // 手动处理冲突并回写（按指定策略）
  window.addEventListener('cherry-sync-resolve-conflicts', async (event) => {
    if (isSyncRunning) {
      logger.verbose('Resolve conflicts skipped: sync loop is running.')
      return
    }

    const detail = (event as CustomEvent<{ policy?: ConflictPolicy }>).detail
    const policy = isConflictPolicy(detail?.policy) ? detail.policy : getConflictPolicy()

    const result = await pullFromServer({
      applySafe: true,
      conflictStrategy: policy
    })
    if (!result) return

    const summary = result.summary
    logger.info(
      `Resolve conflicts (${policy}): local=${summary.conflictResolvedLocal}, ` +
        `server=${summary.conflictResolvedServer}, writeBackQueued=${summary.writeBackQueued}, ` +
        `blockedSeq=${summary.blockedSeq ?? 'none'}`
    )

    // local_wins 需要回写服务器，触发一次完整同步循环即可完成推送
    if (summary.writeBackQueued > 0) {
      await syncOnce()
    }
  })

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
      const debounceMs = getSyncIntervalMs()
      syncTimeout = setTimeout(() => {
        syncOnce()
      }, debounceMs)
    }
  })
}

// 等待 Redux 持久化恢复后再初始化
setTimeout(start, INIT_DELAY)
