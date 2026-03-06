/**
 * Cherry Studio → Sync Server 基于 Manifest 的双向同步
 *
 * 零侵入设计：只需在 entryPoint.tsx 中 import 此文件即可启用同步。
 * 核心：基于服务端 manifest（topicId → revision 清单）做协调，
 *        本地维护 syncedRevisions + dirty 集合替代旧的 snapshot diff。
 *        cursor 降级为可选优化保留。
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
const BATCH_GET_THRESHOLD = 5 // 超过此数量使用 batch-get 替代逐个 GET
const SYNC_SERVER_KEY = 'cherry-sync-server'
const SYNC_TOKEN_KEY = 'cherry-sync-token'
const SYNC_RUNTIME_KEY = 'cherry-sync-runtime'
const SYNC_MODE_KEY = 'cherry-sync-mode'
const SYNC_CONFLICT_POLICY_KEY = 'cherry-sync-conflict-policy'
const SYNC_INTERVAL_KEY = 'cherry-sync-interval-ms'
const PULL_CURSOR_KEY_PREFIX = 'cherry-sync-pull-cursor:'
const SYNCED_REVISIONS_KEY_PREFIX = 'cherry-sync-revisions:'
const DIRTY_TOPICS_KEY_PREFIX = 'cherry-sync-dirty-topics:'

type ConfigSource = 'localStorage' | 'none'
type ConnectionStatus = 'unknown' | 'online' | 'offline' | 'unauthorized'
type SyncMode = 'push_only' | 'manual_pull' | 'auto_safe' | 'auto_full'
type ConflictPolicy = 'local_wins' | 'server_wins'
type SyncActionStatus = 'applied' | 'noop' | 'stale' | 'conflict' | 'not_found' | 'error'

interface SyncRuntimeResult {
  added: number
  updated: number
  deleted: number
  applied: number
  noop: number
  stale: number
  conflict: number
  failed: number
}

interface SyncFailureItem {
  topicId: string
  op: 'upsert' | 'delete'
  status: SyncActionStatus
  error: string | null
}

interface SyncProgressState {
  phase: 'idle' | 'pull' | 'push_upsert' | 'push_delete' | 'manifest'
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
  syncMode: 'auto_safe',
  conflictPolicy: 'local_wins',
  pullCursor: 0,
  connectionStatus: 'unknown',
  running: false,
  lastCheckedAt: null,
  lastSyncAt: null,
  lastPullAt: null,
  lastHttpStatus: null,
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

interface ManifestEntry {
  revision: number
  deletedAt: number | null
}

interface ManifestResponse {
  changeSeq: number
  topicCount: number
  entries: Record<string, ManifestEntry>
}

// ── 配置与运行时状态 ─────────────────────────────────────────────────

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
  return 'auto_safe'
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

// ── Synced Revisions 存储层 ──────────────────────────────────────────

function syncedRevisionsKey(server: string): string {
  return `${SYNCED_REVISIONS_KEY_PREFIX}${server || 'default'}`
}

function loadSyncedRevisions(server: string): Map<string, number> {
  try {
    const raw = localStorage.getItem(syncedRevisionsKey(server))
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, number>
    const map = new Map<string, number>()
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        map.set(k, v)
      }
    }
    return map
  } catch {
    return new Map()
  }
}

function saveSyncedRevisions(server: string, revisions: Map<string, number>): void {
  try {
    const obj: Record<string, number> = {}
    for (const [k, v] of revisions) {
      obj[k] = v
    }
    localStorage.setItem(syncedRevisionsKey(server), JSON.stringify(obj))
  } catch {
    // ignore
  }
}

// ── Dirty Topics 存储层 ─────────────────────────────────────────────

function dirtyTopicsKey(server: string): string {
  return `${DIRTY_TOPICS_KEY_PREFIX}${server || 'default'}`
}

function loadDirtyTopicIds(server: string): Set<string> {
  try {
    const raw = localStorage.getItem(dirtyTopicsKey(server))
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(arr.filter((id) => typeof id === 'string' && id))
  } catch {
    return new Set()
  }
}

function saveDirtyTopicIds(server: string, ids: Set<string>): void {
  try {
    if (ids.size === 0) {
      localStorage.removeItem(dirtyTopicsKey(server))
      return
    }
    localStorage.setItem(dirtyTopicsKey(server), JSON.stringify([...ids]))
  } catch {
    // ignore
  }
}

function markTopicDirty(server: string, topicId: string): void {
  const ids = loadDirtyTopicIds(server)
  ids.add(topicId)
  saveDirtyTopicIds(server, ids)
}

// ── 连通性检查 ──────────────────────────────────────────────────────

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

// ── 数据结构 ────────────────────────────────────────────────────────

interface TopicFullData {
  topicId: string
  name: string
  assistantId: string | null
  assistantName: string
  createdAt: string | null
  updatedAt: string | null
  pinned?: boolean
  prompt?: string
  type?: string
  isNameManuallyEdited?: boolean
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
  pinned?: boolean
  prompt?: string
  type?: string
  isNameManuallyEdited?: boolean
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
          updatedAt: found.updatedAt || null,
          pinned: found.pinned || undefined,
          prompt: found.prompt || undefined,
          type: found.type || undefined,
          isNameManuallyEdited: found.isNameManuallyEdited || undefined
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
        pinned: meta?.pinned,
        prompt: meta?.prompt,
        type: meta?.type,
        isNameManuallyEdited: meta?.isNameManuallyEdited,
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
      pinned: meta?.pinned,
      prompt: meta?.prompt,
      type: meta?.type,
      isNameManuallyEdited: meta?.isNameManuallyEdited,
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── API 函数 ─────────────────────────────────────────────────────────

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

async function apiDeleteTopic(
  topicId: string,
  options?: { force?: boolean; expectedRevision?: number }
): Promise<SyncActionResult> {
  const { server, token } = await getConfig()
  if (!server) return { ok: false, topicId, status: 'error', error: 'missing_server' }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`
    }
    if (options?.force) {
      headers['X-Sync-Force'] = '1'
    }
    if (typeof options?.expectedRevision === 'number' && Number.isFinite(options.expectedRevision) && options.expectedRevision > 0) {
      headers['X-Sync-If-Revision'] = String(Math.floor(options.expectedRevision))
    }

    const resp = await fetchWithTimeout(`${server}/api/topics/${encodeURIComponent(topicId)}`, {
      method: 'DELETE',
      headers
    })

    const text = await resp.text()
    let decoded: unknown = null
    try {
      decoded = text ? JSON.parse(text) : null
    } catch (_) {}

    if (!resp.ok) {
      logger.error(`DELETE /api/topics/${topicId} failed: ${resp.status} ${shortenResponseText(text)}`)
      return { ok: false, topicId, status: 'error', error: `http_${resp.status}` }
    }

    return toSyncActionResult(topicId, decoded)
  } catch (e) {
    logger.error(`DELETE /api/topics/${topicId} network error`, e instanceof Error ? e : new Error(String(e)))
    return { ok: false, topicId, status: 'error', error: 'network_error' }
  }
}

async function apiDeleteBatch(
  topicIds: string[],
  options?: { force?: boolean; expectedRevisions?: Map<string, number> }
): Promise<Map<string, SyncActionResult>> {
  const { server, token } = await getConfig()
  const out = new Map<string, SyncActionResult>()
  if (!server) {
    for (const topicId of topicIds) {
      out.set(topicId, { ok: false, topicId, status: 'error', error: 'missing_server' })
    }
    return out
  }

  if (options?.expectedRevisions) {
    for (const topicId of topicIds) {
      const expectedRevision = options.expectedRevisions.get(topicId)
      const result = await apiDeleteTopic(topicId, {
        force: options.force,
        expectedRevision
      })
      out.set(topicId, result)
    }
    return out
  }

  try {
    const resp = await fetchWithTimeout(`${server}/api/topics/delete-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options?.force ? { 'X-Sync-Force': '1' } : {})
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

async function fetchManifest(server: string, token: string): Promise<ManifestResponse> {
  const resp = await fetchWithTimeout(`${server}/api/sync/manifest`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`
    }
  })

  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`manifest_http_${resp.status}`)
  }

  let decoded: unknown = null
  try {
    decoded = text ? JSON.parse(text) : null
  } catch {
    throw new Error('manifest_parse_error')
  }

  if (!isRecord(decoded)) {
    throw new Error('manifest_invalid_format')
  }

  const entries: Record<string, ManifestEntry> = {}
  const rawEntries = isRecord(decoded.entries) ? decoded.entries : {}
  for (const [topicId, entry] of Object.entries(rawEntries)) {
    if (!isRecord(entry)) continue
    entries[topicId] = {
      revision: Number(entry.revision || 0),
      deletedAt: entry.deletedAt == null ? null : Number(entry.deletedAt)
    }
  }

  return {
    changeSeq: Number(decoded.changeSeq || 0),
    topicCount: Number(decoded.topicCount || 0),
    entries
  }
}

async function fetchTopicById(server: string, token: string, topicId: string): Promise<TopicFullData | null> {
  try {
    const resp = await fetchWithTimeout(`${server}/api/topics/${topicId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    })

    if (resp.status === 404) return null
    const text = await resp.text()
    if (!resp.ok) {
      logger.error(`GET /api/topics/${topicId} failed: ${resp.status}`)
      return null
    }

    const decoded = text ? JSON.parse(text) : null
    if (!isRecord(decoded)) return null

    return (decoded.topic || decoded.data || decoded) as TopicFullData
  } catch (e) {
    logger.error(`Failed to fetch topic ${topicId}`, e instanceof Error ? e : new Error(String(e)))
    return null
  }
}

async function fetchTopicsBatch(
  server: string,
  token: string,
  topicIds: string[]
): Promise<Map<string, TopicFullData>> {
  const out = new Map<string, TopicFullData>()
  if (topicIds.length === 0) return out

  if (topicIds.length <= BATCH_GET_THRESHOLD) {
    for (const id of topicIds) {
      const data = await fetchTopicById(server, token, id)
      if (data) out.set(id, data)
    }
    return out
  }

  try {
    const resp = await fetchWithTimeout(`${server}/api/topics/batch-get`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ topicIds })
    })

    const text = await resp.text()
    if (!resp.ok) {
      logger.error(`POST /api/topics/batch-get failed: ${resp.status}`)
      // fallback to individual fetches
      for (const id of topicIds) {
        const data = await fetchTopicById(server, token, id)
        if (data) out.set(id, data)
      }
      return out
    }

    const decoded = text ? JSON.parse(text) : null
    if (!isRecord(decoded) || !Array.isArray(decoded.topics)) {
      return out
    }

    for (const item of decoded.topics) {
      if (!isRecord(item)) continue
      const topicId = item.topicId as string
      const topicData = (item.topic || item) as TopicFullData
      if (topicId && topicData) {
        out.set(topicId, topicData)
      }
    }
  } catch (e) {
    logger.error('POST /api/topics/batch-get error', e instanceof Error ? e : new Error(String(e)))
    // fallback to individual fetches
    for (const id of topicIds) {
      const data = await fetchTopicById(server, token, id)
      if (data) out.set(id, data)
    }
  }

  return out
}

// ── 数据归一化与 DB 写入 ────────────────────────────────────────────

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

function cloneAssistantsForUpdate(): any[] {
  const assistants = store.getState().assistants?.assistants || []
  return assistants.map((assistant: any) => ({
    ...assistant,
    topics: Array.isArray(assistant.topics) ? [...assistant.topics] : []
  }))
}

function resolveAssistantId(
  assistants: any[],
  incoming: TopicFullData
): { assistantId: string; createdAssistant: boolean } {
  if (incoming.assistantId && assistants.some((assistant) => assistant.id === incoming.assistantId)) {
    return { assistantId: incoming.assistantId, createdAssistant: false }
  }

  if (incoming.assistantName) {
    const byName = assistants.find((assistant) => assistant.name === incoming.assistantName)
    if (byName?.id) return { assistantId: byName.id, createdAssistant: false }
  }

  const incomingAssistantId = typeof incoming.assistantId === 'string' ? incoming.assistantId.trim() : ''
  const incomingAssistantName = typeof incoming.assistantName === 'string' ? incoming.assistantName.trim() : ''
  if (incomingAssistantId) {
    const template = store.getState().assistants?.defaultAssistant
    const nextAssistant = template
      ? {
          ...template,
          id: incomingAssistantId,
          name: incomingAssistantName || `Synced ${incomingAssistantId.slice(0, 8)}`,
          topics: [],
          messages: Array.isArray(template.messages) ? [...template.messages] : [],
          regularPhrases: Array.isArray(template.regularPhrases) ? [...template.regularPhrases] : [],
          settings: template.settings ? { ...template.settings } : template.settings
        }
      : {
          id: incomingAssistantId,
          name: incomingAssistantName || incomingAssistantId,
          topics: []
        }

    assistants.push(nextAssistant)
    return { assistantId: incomingAssistantId, createdAssistant: true }
  }

  const defaultAssistantId = store.getState().assistants?.defaultAssistant?.id
  if (defaultAssistantId) return { assistantId: defaultAssistantId, createdAssistant: false }
  if (assistants[0]?.id) return { assistantId: assistants[0].id, createdAssistant: false }

  return { assistantId: incoming.assistantId || 'default', createdAssistant: false }
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
  const createdAt = incoming.createdAt != null ? toIsoString(incoming.createdAt) : now
  const updatedAt = incoming.updatedAt != null ? toIsoString(incoming.updatedAt) : createdAt

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
        createdAt:
          typeof blockRecord.createdAt === 'string' ? blockRecord.createdAt : toIsoString(blockRecord.createdAt),
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
      createdAt:
        typeof messageRecord.createdAt === 'string' ? messageRecord.createdAt : toIsoString(messageRecord.createdAt),
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
    messages: [],
    ...(incoming.pinned != null ? { pinned: incoming.pinned } : {}),
    ...(incoming.prompt != null ? { prompt: incoming.prompt } : {}),
    ...(incoming.type != null ? { type: incoming.type as Topic['type'] } : {}),
    ...(incoming.isNameManuallyEdited != null ? { isNameManuallyEdited: incoming.isNameManuallyEdited } : {})
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

// ── 迁移函数 ────────────────────────────────────────────────────────

const OLD_SNAPSHOT_KEY_PREFIX = 'cherry-sync-snapshot:'
const OLD_FORCED_WRITEBACK_KEY = 'cherry-sync-forced-writeback'

function migrateFromSnapshotIfNeeded(server: string): void {
  const revisionsKey = syncedRevisionsKey(server)
  // 如果已有 syncedRevisions，说明已迁移过
  if (localStorage.getItem(revisionsKey)) return

  const oldSnapshotKey = `${OLD_SNAPSHOT_KEY_PREFIX}${server || 'default'}`
  const oldSnapshot = localStorage.getItem(oldSnapshotKey)

  // 首次运行新代码：将所有 topic 标记为 dirty，syncedRevision 设为 0
  const localSnapshot = getTopicSnapshotFromStore()
  const dirtyIds = new Set<string>()
  const revisions = new Map<string, number>()

  for (const topicId of localSnapshot.keys()) {
    revisions.set(topicId, 0) // 首次 manifest 同步会自动修正
    dirtyIds.add(topicId) // 所有 topic 标记为 dirty
  }

  saveSyncedRevisions(server, revisions)
  saveDirtyTopicIds(server, dirtyIds)

  // 清理旧数据
  if (oldSnapshot) {
    localStorage.removeItem(oldSnapshotKey)
  }
  const oldForced = localStorage.getItem(OLD_FORCED_WRITEBACK_KEY)
  if (oldForced) {
    localStorage.removeItem(OLD_FORCED_WRITEBACK_KEY)
  }

  logger.info(
    `Migrated from snapshot to manifest-based sync: ${localSnapshot.size} topics marked dirty, revisions initialized to 0`
  )
}

// ── 同步状态 ────────────────────────────────────────────────────────

let isSyncRunning = false
let syncTimeout: ReturnType<typeof setTimeout> | null = null
let syncIntervalTimer: ReturnType<typeof setInterval> | null = null
let lastAssistantsState: unknown = null
let lastAssistantsSnapshot: Map<string, string> | null = null
let hasStarted = false

const STORE_CHANGE_DEBOUNCE_MS = 5_000

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

// ── 同步主循环（manifest 协调） ──────────────────────────────────────

async function syncOnce(): Promise<void> {
  const { server, token } = await getConfig()
  if (isSyncRunning) return
  if (!server) return
  isSyncRunning = true

  const syncMode = getSyncMode()
  const conflictPolicy = getConflictPolicy()
  updateSyncRuntimeState({
    running: true,
    lastError: null,
    syncMode,
    conflictPolicy,
    pullCursor: getPullCursor(server),
    syncProgress: {
      phase: 'manifest',
      total: 0,
      processed: 0,
      failed: 0
    }
  })

  // 1. 连通性检查
  const connectivity = await refreshConnectivity()
  if (!connectivity.ok) {
    isSyncRunning = false
    updateSyncRuntimeState({
      running: false,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
    logger.verbose(`Sync skipped: connectivity=${connectivity.status}, error=${connectivity.error || 'none'}`)
    return
  }

  try {
    // 迁移检查
    migrateFromSnapshotIfNeeded(server)

    // 2. 拉取 manifest
    const manifest = await fetchManifest(server, token)

    // 3. 加载本地状态
    const syncedRevisions = loadSyncedRevisions(server)
    const dirtyTopicIds = loadDirtyTopicIds(server)
    const localSnapshot = getTopicSnapshotFromStore()
    const localTopicIds = new Set(localSnapshot.keys())

    // 4. 协调 (reconcile)
    const toFetchSet = new Set<string>()
    const toFetchUpdateSet = new Set<string>() // 区分拉取新增 vs 拉取更新
    const toDeleteLocalSet = new Set<string>()
    const toPushSet = new Set<string>()
    const toDeleteRemoteSet = new Set<string>()
    let conflictCount = 0
    const conflictItems: SyncFailureItem[] = []

    for (const [topicId, entry] of Object.entries(manifest.entries)) {
      const localHas = localTopicIds.has(topicId)
      const syncedRev = syncedRevisions.get(topicId) ?? -1
      const isDirty = dirtyTopicIds.has(topicId)
      const serverDeleted = entry.deletedAt != null

      if (serverDeleted) {
        // 服务端已删除
        if (localHas && !isDirty) {
          toDeleteLocalSet.add(topicId)
        } else if (localHas && isDirty) {
          // 本地有修改但服务端已删，按冲突策略处理
          if (syncMode === 'push_only') {
            // push_only 不拉取，保留本地
          } else if (syncMode === 'auto_full') {
            if (conflictPolicy === 'server_wins') {
              toDeleteLocalSet.add(topicId)
            } else {
              toPushSet.add(topicId) // local_wins: 复活到服务端
            }
          } else {
            // auto_safe: 记录冲突，不操作
            conflictCount++
            conflictItems.push({ topicId, op: 'upsert', status: 'conflict', error: 'server_deleted_local_dirty' })
          }
        }
        continue
      }

      if (!localHas) {
        // 服务端有、本地没有
        if (isDirty) {
          // 本地曾删除此 topic 但标记了 dirty（本地删除待推送）
          toDeleteRemoteSet.add(topicId)
        } else if (syncMode !== 'push_only') {
          toFetchSet.add(topicId)
          // 本地不存在 → 新增
        }
        continue
      }

      if (entry.revision > syncedRev) {
        // 服务端有新版本
        if (!isDirty) {
          if (syncMode !== 'push_only') {
            toFetchSet.add(topicId)
            toFetchUpdateSet.add(topicId) // 本地已有但版本落后 → 更新
          }
        } else {
          // 冲突：服务端和本地都有修改
          if (syncMode === 'auto_full') {
            if (conflictPolicy === 'server_wins') {
              toFetchSet.add(topicId)
              toFetchUpdateSet.add(topicId)
            } else {
              toPushSet.add(topicId) // local_wins: 强制推送
            }
          } else if (syncMode === 'auto_safe') {
            conflictCount++
            conflictItems.push({ topicId, op: 'upsert', status: 'conflict', error: 'both_modified' })
          }
          // push_only: 只推送，跳过拉取
        }
      }
    }

    // dirty topic → toPush
    for (const topicId of dirtyTopicIds) {
      if (localTopicIds.has(topicId)) {
        // 检查是否已在 toFetch 中被 server_wins 覆盖
        if (!toFetchSet.has(topicId)) {
          toPushSet.add(topicId)
        }
      } else {
        // 本地没有此 topic（已删除）→ 推送删除
        toDeleteRemoteSet.add(topicId)
      }
    }

    // 本地有、服务端没有且 dirty → toPush (新 topic)
    for (const topicId of localTopicIds) {
      if (!manifest.entries[topicId] && dirtyTopicIds.has(topicId)) {
        toPushSet.add(topicId)
      }
    }

    if (conflictCount > 0) {
      logger.warn(`Manifest reconcile: ${conflictCount} conflicts detected (auto_safe mode, skipping)`)
    }

    logger.verbose(
      `Manifest reconcile: toFetch=${toFetchSet.size}, toPush=${toPushSet.size}, ` +
        `toDeleteLocal=${toDeleteLocalSet.size}, toDeleteRemote=${toDeleteRemoteSet.size}, conflicts=${conflictCount}`
    )

    // 转为数组供后续遍历
    const toFetch = [...toFetchSet]
    const toDeleteLocal = [...toDeleteLocalSet]
    const toPush = [...toPushSet]
    const toDeleteRemote = [...toDeleteRemoteSet]

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
      failedActions.push({ topicId, op, status, error: error || null })
    }

    // 5. Pull: 从服务端拉取
    if (toFetch.length > 0) {
      updateSyncRuntimeState({
        syncProgress: { phase: 'pull', total: toFetch.length, processed: 0, failed: 0 }
      })

      const fetched = await fetchTopicsBatch(server, token, toFetch)
      const assistants = cloneAssistantsForUpdate()
      let assistantsChanged = false
      let pullProcessed = 0

      for (const topicId of toFetch) {
        const topicData = fetched.get(topicId)
        if (!topicData) {
          pullProcessed++
          continue
        }

        const resolvedAssistant = resolveAssistantId(assistants, topicData)
        if (resolvedAssistant.createdAssistant) assistantsChanged = true

        const normalized = normalizeIncomingTopic(topicData, resolvedAssistant.assistantId)
        await applyUpsertToDb(topicId, normalized.messages, normalized.blocks)

        if (upsertTopicMetaInAssistants(assistants, resolvedAssistant.assistantId, normalized.topicMeta)) {
          assistantsChanged = true
        }

        // 更新 syncedRevision
        const serverEntry = manifest.entries[topicId]
        if (serverEntry) {
          syncedRevisions.set(topicId, serverEntry.revision)
        }

        // 如果该 topic 非 dirty，则不需要再标记为 clean（它本来就不 dirty）
        // 如果是冲突且 server_wins，从 dirty 中移除
        dirtyTopicIds.delete(topicId)

        appliedCount++
        pullProcessed++
        if (pullProcessed % 10 === 0 || pullProcessed === toFetch.length) {
          updateSyncRuntimeState({
            syncProgress: { phase: 'pull', total: toFetch.length, processed: pullProcessed, failed: 0 }
          })
        }
      }

      if (assistantsChanged) {
        try {
          store.dispatch(updateAssistants(assistants))
        } catch (dispatchErr) {
          logger.error(
            'Failed to dispatch updateAssistants after pull',
            dispatchErr instanceof Error ? dispatchErr : new Error(String(dispatchErr))
          )
        }
      }
    }

    // 6. Push: 推送本地变更
    if (toPush.length > 0) {
      updateSyncRuntimeState({
        syncProgress: { phase: 'push_upsert', total: toPush.length, processed: 0, failed: 0 }
      })

      let pushProcessed = 0
      let pushFailed = 0
      const forceWrite = syncMode === 'auto_full' && conflictPolicy === 'local_wins'

      for (let i = 0; i < toPush.length; i += BATCH_SIZE) {
        const batch = toPush.slice(i, i + BATCH_SIZE)
        const topicsData: TopicFullData[] = []

        for (const id of batch) {
          const data = await getTopicFullData(id)
          if (!data) {
            // 本地数据不存在，从 dirty 集合移除防止无限重试
            logger.warn(`Topic ${id} not found in IndexedDB, removing from dirty set`)
            dirtyTopicIds.delete(id)
            pushProcessed++
            continue
          }
          topicsData.push(data)
        }

        if (topicsData.length === 0) continue

        const results = await apiPostBatch(topicsData, { force: forceWrite })
        for (const topic of topicsData) {
          const result = results.get(topic.topicId)
          const status: SyncActionStatus = result?.status ?? 'error'

          if (TERMINAL_STATUSES.has(status)) {
            // 更新 syncedRevision
            if (result?.revision != null) {
              syncedRevisions.set(topic.topicId, result.revision)
            }
            dirtyTopicIds.delete(topic.topicId)
          }

          if (status === 'applied') appliedCount++
          else if (status === 'noop' || status === 'not_found') noopCount++
          else if (status === 'stale') staleCount++
          else {
            failedCount++
            pushFailed++
            recordFailure(topic.topicId, 'upsert', status, result?.error)
          }
          pushProcessed++
        }

        if (pushProcessed % 5 === 0 || pushProcessed === toPush.length) {
          updateSyncRuntimeState({
            syncProgress: { phase: 'push_upsert', total: toPush.length, processed: pushProcessed, failed: pushFailed }
          })
        }
      }
    }

    // 7. 本地删除
    if (toDeleteLocal.length > 0) {
      const assistants = cloneAssistantsForUpdate()
      let assistantsChanged = false

      for (const topicId of toDeleteLocal) {
        await applyDeleteToDb(topicId)
        if (removeTopicMetaFromAssistants(assistants, topicId)) {
          assistantsChanged = true
        }
        syncedRevisions.delete(topicId)
        dirtyTopicIds.delete(topicId)
        appliedCount++
      }

      if (assistantsChanged) {
        try {
          store.dispatch(updateAssistants(assistants))
        } catch (dispatchErr) {
          logger.error(
            'Failed to dispatch updateAssistants after local delete',
            dispatchErr instanceof Error ? dispatchErr : new Error(String(dispatchErr))
          )
        }
      }
    }

    // 8. 远程删除
    if (toDeleteRemote.length > 0) {
      updateSyncRuntimeState({
        syncProgress: { phase: 'push_delete', total: toDeleteRemote.length, processed: 0, failed: 0 }
      })

      let deleteProcessed = 0
      let deleteFailed = 0

      for (let i = 0; i < toDeleteRemote.length; i += BATCH_SIZE) {
        const batch = toDeleteRemote.slice(i, i + BATCH_SIZE)
        const results = await apiDeleteBatch(batch, { expectedRevisions: syncedRevisions })

        for (const id of batch) {
          const result = results.get(id)
          const status: SyncActionStatus = result?.status ?? 'error'

          if (TERMINAL_STATUSES.has(status)) {
            syncedRevisions.delete(id)
            dirtyTopicIds.delete(id)
          }

          if (status === 'applied') appliedCount++
          else if (status === 'noop' || status === 'not_found') noopCount++
          else if (status === 'stale') staleCount++
          else {
            failedCount++
            deleteFailed++
            recordFailure(id, 'delete', status, result?.error)
          }
          deleteProcessed++
        }

        updateSyncRuntimeState({
          syncProgress: {
            phase: 'push_delete',
            total: toDeleteRemote.length,
            processed: deleteProcessed,
            failed: deleteFailed
          }
        })
      }
    }

    // 9. 持久化更新
    saveSyncedRevisions(server, syncedRevisions)
    saveDirtyTopicIds(server, dirtyTopicIds)

    // 10. 设置 cursor = manifest.changeSeq（可选优化）
    setPullCursor(server, manifest.changeSeq)

    const fetchNewCount = toFetch.length - toFetchUpdateSet.size
    const fetchUpdateCount = toFetchUpdateSet.size
    const allFailures = [...failedActions, ...conflictItems]

    logSyncResult({
      added: fetchNewCount,
      updated: fetchUpdateCount,
      deleted: toDeleteLocal.length + toDeleteRemote.length,
      applied: appliedCount,
      noop: noopCount,
      stale: staleCount,
      failed: failedCount
    })

    updateSyncRuntimeState({
      lastSyncAt: Date.now(),
      lastPullAt: toFetch.length > 0 ? Date.now() : getSyncRuntimeState().lastPullAt,
      pullCursor: manifest.changeSeq,
      lastResult: {
        added: fetchNewCount,
        updated: fetchUpdateCount,
        deleted: toDeleteLocal.length + toDeleteRemote.length,
        applied: appliedCount,
        noop: noopCount,
        stale: staleCount,
        conflict: conflictCount,
        failed: failedCount
      },
      lastFailures: allFailures.length > 0 ? allFailures : [],
      lastError:
        failedCount > 0
          ? buildFailureMessage(failedActions, failedCount)
          : conflictCount > 0
            ? `${conflictCount} conflict(s) detected in auto_safe mode, manual resolution needed`
            : null,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logger.error('Sync loop error', error)
    updateSyncRuntimeState({
      lastFailures: [],
      lastError: error.message,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  } finally {
    isSyncRunning = false
    updateSyncRuntimeState({
      running: false,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  }
}

// ── 强制推送 ────────────────────────────────────────────────────────

async function triggerFullPushToServer(options?: { pruneRemote?: boolean }): Promise<void> {
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

  isSyncRunning = true
  const pruneRemote = options?.pruneRemote === true

  try {
    updateSyncRuntimeState({
      running: true,
      lastError: null,
      lastResult: null,
      lastFailures: [],
      syncProgress: { phase: 'manifest', total: 0, processed: 0, failed: 0 }
    })

    // 1. 拉取 manifest
    const manifest = await fetchManifest(server, token)
    const localSnapshot = getTopicSnapshotFromStore()

    // 2. toPush = 全部本地 topic
    const toPush = [...localSnapshot.keys()]

    // 3. toDeleteRemote = manifest 中有但本地没有的
    const toDeleteRemote: string[] = []
    if (pruneRemote) {
      for (const topicId of Object.keys(manifest.entries)) {
        if (!localSnapshot.has(topicId) && manifest.entries[topicId].deletedAt == null) {
          toDeleteRemote.push(topicId)
        }
      }
    }

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
      failedActions.push({ topicId, op, status, error: error || null })
    }

    // 4. 批量推送
    updateSyncRuntimeState({
      syncProgress: { phase: 'push_upsert', total: toPush.length, processed: 0, failed: 0 }
    })

    const newSyncedRevisions = new Map<string, number>()
    let pushProcessed = 0

    for (let i = 0; i < toPush.length; i += BATCH_SIZE) {
      const batch = toPush.slice(i, i + BATCH_SIZE)
      const topicsData: TopicFullData[] = []

      for (const id of batch) {
        const data = await getTopicFullData(id)
        if (!data) {
          logger.warn(`Full push: topic ${id} not found in IndexedDB, skipping`)
          pushProcessed++
          continue
        }
        topicsData.push(data)
      }

      if (topicsData.length > 0) {
        const results = await apiPostBatch(topicsData, { force: true })
        for (const topic of topicsData) {
          const result = results.get(topic.topicId)
          const status: SyncActionStatus = result?.status ?? 'error'

          if (result?.revision != null) {
            newSyncedRevisions.set(topic.topicId, result.revision)
          }

          if (status === 'applied') appliedCount++
          else if (status === 'noop' || status === 'not_found') noopCount++
          else if (status === 'stale') staleCount++
          else {
            failedCount++
            recordFailure(topic.topicId, 'upsert', status, result?.error)
          }
          pushProcessed++
        }
      }

      updateSyncRuntimeState({
        syncProgress: { phase: 'push_upsert', total: toPush.length, processed: pushProcessed, failed: failedCount }
      })
    }

    // 5. 批量删除远程
    if (toDeleteRemote.length > 0) {
      updateSyncRuntimeState({
        syncProgress: { phase: 'push_delete', total: toDeleteRemote.length, processed: 0, failed: 0 }
      })

      for (let i = 0; i < toDeleteRemote.length; i += BATCH_SIZE) {
        const batch = toDeleteRemote.slice(i, i + BATCH_SIZE)
        const results = await apiDeleteBatch(batch)

        for (const id of batch) {
          const result = results.get(id)
          const status: SyncActionStatus = result?.status ?? 'error'
          if (status === 'applied') appliedCount++
          else if (status === 'noop' || status === 'not_found') noopCount++
          else {
            failedCount++
            recordFailure(id, 'delete', status, result?.error)
          }
        }
      }
    }

    // 6. 用返回值更新 syncedRevisions，清空 dirty
    saveSyncedRevisions(server, newSyncedRevisions)
    saveDirtyTopicIds(server, new Set())

    // cursor 更新到 manifest.changeSeq（推送后服务端 changeSeq 已更新，但 manifest 是推送前拉的）
    // 这里不精确没关系，下次 syncOnce 会重新拉 manifest
    setPullCursor(server, manifest.changeSeq)

    logger.info(
      `Full push completed: ${toPush.length} uploads, ${toDeleteRemote.length} remote deletes, ` +
        `applied=${appliedCount}, noop=${noopCount}, stale=${staleCount}, failed=${failedCount}`
    )

    updateSyncRuntimeState({
      lastSyncAt: Date.now(),
      pullCursor: manifest.changeSeq,
      lastResult: {
        added: 0,
        updated: toPush.length,
        deleted: toDeleteRemote.length,
        applied: appliedCount,
        noop: noopCount,
        stale: staleCount,
        conflict: 0,
        failed: failedCount
      },
      lastFailures: failedCount > 0 ? failedActions : [],
      lastError: failedCount > 0 ? buildFailureMessage(failedActions, failedCount) : null,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logger.error('Full push error', error)
    updateSyncRuntimeState({
      lastError: error.message,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  } finally {
    isSyncRunning = false
    updateSyncRuntimeState({
      running: false,
      syncProgress: { phase: 'idle', total: 0, processed: 0, failed: 0 }
    })
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────

async function start() {
  if (hasStarted) return
  hasStarted = true

  const { server } = await getConfig()
  const intervalMs = getSyncIntervalMs()
  if (server) {
    logger.info(`Starting manifest-based sync to ${server} (interval=${intervalMs}ms)`)
  } else {
    logger.info('No sync server configured. Waiting for config from settings.')
  }

  restartSyncIntervalTimer()

  // 立即执行一次
  syncOnce()

  // 手动触发入口
  window.addEventListener('cherry-sync-force', () => {
    syncOnce()
  })

  window.addEventListener('cherry-sync-push-full', () => {
    triggerFullPushToServer()
  })

  window.addEventListener('cherry-sync-push-full-prune', () => {
    triggerFullPushToServer({ pruneRemote: true })
  })

  // 连通性检查入口
  window.addEventListener('cherry-sync-check', () => {
    refreshConnectivity(true)
  })

  // 设置同步模式
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

  // 设置冲突策略
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

    const { server } = await getConfig()
    if (!server) return

    // 将失败的 topic 标记为 dirty
    for (const failure of runtime.lastFailures) {
      if (!failure.topicId) continue
      markTopicDirty(server, failure.topicId)
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

  // 预览服务端增量（用 manifest 做 dry-run）
  window.addEventListener('cherry-sync-pull-preview', async () => {
    if (isSyncRunning) {
      logger.verbose('Pull preview skipped: sync loop is running.')
      return
    }

    try {
      const { server, token } = await getConfig()
      if (!server) return
      const manifest = await fetchManifest(server, token)
      const syncedRevisions = loadSyncedRevisions(server)
      const localSnapshot = getTopicSnapshotFromStore()

      let newFromServer = 0
      let updatedOnServer = 0
      let deletedOnServer = 0

      for (const [topicId, entry] of Object.entries(manifest.entries)) {
        if (entry.deletedAt != null) {
          if (localSnapshot.has(topicId)) deletedOnServer++
          continue
        }
        if (!localSnapshot.has(topicId)) {
          newFromServer++
        } else if (entry.revision > (syncedRevisions.get(topicId) ?? -1)) {
          updatedOnServer++
        }
      }

      logger.info(
        `Pull preview: new=${newFromServer}, updated=${updatedOnServer}, deleted=${deletedOnServer}, ` +
          `manifest.topicCount=${manifest.topicCount}`
      )
    } catch (e) {
      logger.error('Pull preview failed', e instanceof Error ? e : new Error(String(e)))
    }
  })

  // 手动拉取
  window.addEventListener('cherry-sync-pull-apply', async () => {
    if (isSyncRunning) {
      logger.verbose('Pull apply skipped: sync loop is running.')
      return
    }
    await syncOnce()
  })

  window.addEventListener('cherry-sync-rebuild-baseline', async () => {
    if (isSyncRunning) {
      logger.verbose('Rebuild baseline skipped: sync loop is running.')
      return
    }

    try {
      const { server, token } = await getConfig()
      if (!server) return

      const manifest = await fetchManifest(server, token)
      const localSnapshot = getTopicSnapshotFromStore()
      const nextRevisions = new Map<string, number>()

      for (const topicId of localSnapshot.keys()) {
        nextRevisions.set(topicId, manifest.entries[topicId]?.revision ?? 0)
      }

      saveSyncedRevisions(server, nextRevisions)
      saveDirtyTopicIds(server, new Set())
      setPullCursor(server, manifest.changeSeq)

      updateSyncRuntimeState({
        pullCursor: manifest.changeSeq,
        lastFailures: [],
        lastError: null
      })

      logger.info(
        `Sync baseline rebuilt: localTopics=${localSnapshot.size}, manifestTopics=${manifest.topicCount}, cursor=${manifest.changeSeq}`
      )
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      logger.error('Rebuild baseline failed', error)
      updateSyncRuntimeState({
        lastError: error.message
      })
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

    // 强制执行一次同步，使用指定策略
    const savedPolicy = getConflictPolicy()
    localStorage.setItem(SYNC_CONFLICT_POLICY_KEY, policy)
    const savedMode = getSyncMode()
    localStorage.setItem(SYNC_MODE_KEY, 'auto_full')

    await syncOnce()

    // 恢复原策略
    localStorage.setItem(SYNC_CONFLICT_POLICY_KEY, savedPolicy)
    localStorage.setItem(SYNC_MODE_KEY, savedMode)
  })

  // 监听 Redux Store 变化 → 自动标记 dirty
  store.subscribe(() => {
    const currentState = store.getState()
    const currentAssistantsState = currentState.assistants?.assistants

    if (currentAssistantsState !== lastAssistantsState) {
      lastAssistantsState = currentAssistantsState

      // 对比前后快照，找出 updatedAt 变化的 topic → 批量标记 dirty
      const currentSnapshot = getTopicSnapshotFromStore()
      if (lastAssistantsSnapshot && cachedServer) {
        const newDirtyIds: string[] = []

        for (const [topicId, updatedAt] of currentSnapshot) {
          const prev = lastAssistantsSnapshot.get(topicId)
          if (prev !== updatedAt) {
            newDirtyIds.push(topicId)
          }
        }
        // 找出被删除的 topic
        for (const topicId of lastAssistantsSnapshot.keys()) {
          if (!currentSnapshot.has(topicId)) {
            newDirtyIds.push(topicId)
          }
        }

        // 一次性加载、修改、保存 dirty 集合（避免 N 次序列化）
        if (newDirtyIds.length > 0) {
          const dirtyIds = loadDirtyTopicIds(cachedServer)
          for (const id of newDirtyIds) {
            dirtyIds.add(id)
          }
          saveDirtyTopicIds(cachedServer, dirtyIds)
        }
      }
      lastAssistantsSnapshot = currentSnapshot

      // 防抖：重置倒计时
      if (syncTimeout) {
        clearTimeout(syncTimeout)
      }
      syncTimeout = setTimeout(() => {
        syncOnce()
      }, STORE_CHANGE_DEBOUNCE_MS)
    }
  })
}

// 等待 Redux 持久化恢复后再初始化
setTimeout(start, INIT_DELAY)
