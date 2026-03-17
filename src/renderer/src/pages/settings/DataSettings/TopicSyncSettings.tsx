import { ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import { Alert, Button, Collapse, Input, Select, Tag } from 'antd'
import dayjs from 'dayjs'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'
import { getTopicSyncText, type TopicSyncText } from './TopicSyncText'

const SYNC_SERVER_KEY = 'cherry-sync-server'
const SYNC_TOKEN_KEY = 'cherry-sync-token'
const SYNC_RUNTIME_KEY = 'cherry-sync-runtime'
const SYNC_MODE_KEY = 'cherry-sync-mode'
const SYNC_CONFLICT_POLICY_KEY = 'cherry-sync-conflict-policy'
const SYNC_INTERVAL_KEY = 'cherry-sync-interval-ms'

type ConfigSource = 'localStorage' | 'none'
type ConnectionStatus = 'unknown' | 'online' | 'offline' | 'unauthorized'
type SyncMode = 'push_only' | 'manual_pull' | 'auto_safe' | 'auto_full'
type ConflictPolicy = 'local_wins' | 'server_wins'
type SyncActionStatus = 'applied' | 'noop' | 'stale' | 'conflict' | 'not_found' | 'tombstoned' | 'error'

interface SyncFailureItem {
  topicId: string
  op: 'upsert' | 'delete'
  status: SyncActionStatus
  error: string | null
}

interface PullConflictItem {
  seq: number
  topicId: string
  op: 'upsert' | 'delete'
  localUpdatedAt: number
  remoteUpdatedAt: number
  remoteClientUpdatedAt: number
  reason: 'local_newer' | 'remote_timestamp_missing' | 'local_deleted_pending'
}

interface PullSummary {
  total: number
  safe: number
  skipped: number
  conflicts: number
  applied: number
  conflictResolvedLocal: number
  conflictResolvedServer: number
  writeBackQueued: number
  nextCursor: number
  blockedSeq: number | null
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

const DEFAULT_RUNTIME_STATE: SyncRuntimeState = {
  configured: false,
  server: '',
  tokenConfigured: false,
  configSource: 'none',
  syncIntervalMs: 30_000,
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

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const SectionTitle = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
`

const ButtonRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
`

const SummaryGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
`

const SummaryCard = styled.div`
  border: 1px solid var(--color-border);
  border-radius: var(--list-item-border-radius);
  padding: 10px;
  background: var(--color-background-soft);
`

const SummaryLabel = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 6px;
`

const SummaryValue = styled.div`
  font-size: 13px;
  color: var(--color-text-1);
  line-height: 18px;
  word-break: break-word;
`

const PreviewText = styled.pre`
  margin: 0;
  font-family: var(--code-font-family, monospace);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-2);
  white-space: pre-wrap;
  word-break: break-word;
`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFailureItems(raw: unknown): SyncFailureItem[] {
  if (!Array.isArray(raw)) return []
  const statuses: SyncActionStatus[] = ['applied', 'noop', 'stale', 'conflict', 'not_found', 'tombstoned', 'error']

  return raw
    .map((entry): SyncFailureItem | null => {
      if (!isRecord(entry)) return null
      const topicId = typeof entry.topicId === 'string' ? entry.topicId : ''
      const op = entry.op === 'delete' ? 'delete' : entry.op === 'upsert' ? 'upsert' : null
      const status = statuses.includes(entry.status as SyncActionStatus) ? (entry.status as SyncActionStatus) : null
      const error = typeof entry.error === 'string' ? entry.error : null
      if (!topicId || !op || !status) return null
      return {
        topicId,
        op,
        status,
        error
      }
    })
    .filter((item): item is SyncFailureItem => Boolean(item))
    .slice(0, 100)
}

function normalizeSyncMode(raw: string | null): SyncMode {
  if (raw === 'manual_pull' || raw === 'auto_safe' || raw === 'auto_full' || raw === 'push_only') return raw
  return 'push_only'
}

function normalizeConflictPolicy(raw: string | null): ConflictPolicy {
  if (raw === 'local_wins' || raw === 'server_wins') return raw
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

  if (value === null) return DEFAULT_RUNTIME_STATE.syncIntervalMs
  return Math.min(3_600_000, Math.max(10_000, value))
}

function parseRuntimeState(raw: string | null): SyncRuntimeState {
  if (!raw) return { ...DEFAULT_RUNTIME_STATE }

  try {
    const parsed = JSON.parse(raw) as Partial<SyncRuntimeState>
    const localMode = normalizeSyncMode(localStorage.getItem(SYNC_MODE_KEY))
    const parsedMode = normalizeSyncMode(typeof parsed.syncMode === 'string' ? parsed.syncMode : null)
    const syncMode = parsedMode === 'push_only' && localMode !== 'push_only' ? localMode : parsedMode
    const localPolicy = normalizeConflictPolicy(localStorage.getItem(SYNC_CONFLICT_POLICY_KEY))
    const parsedPolicy = normalizeConflictPolicy(
      typeof parsed.conflictPolicy === 'string' ? parsed.conflictPolicy : null
    )
    const conflictPolicy = parsedPolicy === 'local_wins' && localPolicy !== 'local_wins' ? localPolicy : parsedPolicy
    const localIntervalMs = normalizeSyncIntervalMs(localStorage.getItem(SYNC_INTERVAL_KEY))
    const parsedIntervalMs = normalizeSyncIntervalMs(parsed.syncIntervalMs)
    const syncIntervalMs =
      parsedIntervalMs === DEFAULT_RUNTIME_STATE.syncIntervalMs &&
      localIntervalMs !== DEFAULT_RUNTIME_STATE.syncIntervalMs
        ? localIntervalMs
        : parsedIntervalMs

    return {
      ...DEFAULT_RUNTIME_STATE,
      ...parsed,
      syncIntervalMs,
      syncMode,
      conflictPolicy,
      lastPullSummary: parsed.lastPullSummary ? { ...parsed.lastPullSummary } : null,
      pendingConflicts: Array.isArray(parsed.pendingConflicts) ? [...parsed.pendingConflicts] : [],
      lastResult: parsed.lastResult ? { ...parsed.lastResult } : null,
      lastFailures: parseFailureItems(parsed.lastFailures),
      syncProgress: parsed.syncProgress
        ? {
            ...DEFAULT_RUNTIME_STATE.syncProgress,
            ...parsed.syncProgress
          }
        : { ...DEFAULT_RUNTIME_STATE.syncProgress }
    }
  } catch {
    return { ...DEFAULT_RUNTIME_STATE }
  }
}

function formatTimestamp(value: number | null): string {
  if (!value) return '-'
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

function formatIntervalLabel(ms: number, text: TopicSyncText): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}${text.units.secondsShort}`
  return `${Math.round(ms / 60_000)}${text.units.minutesShort}`
}

function formatPullSummary(summary: PullSummary | null, text: TopicSyncText): string {
  if (!summary) return '-'
  const blocked = summary.blockedSeq ? `, ${text.diagnostics.blockedSeq}=${summary.blockedSeq}` : ''
  const resolved =
    summary.conflictResolvedLocal > 0 || summary.conflictResolvedServer > 0 || summary.writeBackQueued > 0
      ? `, ${text.diagnostics.resolve}(${text.diagnostics.local}=${summary.conflictResolvedLocal}, ${text.diagnostics.server}=${summary.conflictResolvedServer}, ${text.diagnostics.writeBack}=${summary.writeBackQueued})`
      : ''
  const skipped = summary.skipped > 0 ? `, ${text.diagnostics.skipped}=${summary.skipped}` : ''
  return (
    `${text.diagnostics.total}=${summary.total}, ${text.diagnostics.safe}=${summary.safe}, ${text.diagnostics.conflicts}=${summary.conflicts}, ` +
    `${text.diagnostics.applied}=${summary.applied}, ${text.diagnostics.cursor}=${summary.nextCursor}${blocked}${resolved}${skipped}`
  )
}

function formatLastResult(result: SyncRuntimeResult | null, text: TopicSyncText): string {
  if (!result) return '-'
  return (
    `+${result.added} ~${result.updated} -${result.deleted}; ` +
    `${text.diagnostics.applied}=${result.applied}, ${text.diagnostics.noop}=${result.noop}, ${text.diagnostics.stale}=${result.stale}, ${text.diagnostics.failed}=${result.failed}`
  )
}

function sourceLabel(source: ConfigSource, text: TopicSyncText): string {
  return source === 'localStorage' ? text.source.settings : text.source.none
}

function connectionTag(status: ConnectionStatus, text: TopicSyncText) {
  if (status === 'online') return <Tag color="success">{text.connection.online}</Tag>
  if (status === 'unauthorized') return <Tag color="error">{text.connection.unauthorized}</Tag>
  if (status === 'offline') return <Tag color="warning">{text.connection.offline}</Tag>
  return <Tag>{text.connection.unknown}</Tag>
}

function summarizeFailureReasons(failures: SyncFailureItem[]): string {
  if (!failures.length) return '-'
  const grouped = new Map<string, number>()
  for (const item of failures) {
    const key = item.error || item.status
    grouped.set(key, (grouped.get(key) || 0) + 1)
  }

  return [...grouped.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} x${count}`)
    .join(', ')
}

function buildFailurePreview(failures: SyncFailureItem[]): string {
  if (!failures.length) return '-'
  return failures
    .slice(0, 8)
    .map((item) => `${item.op.toUpperCase()} ${item.topicId} -> ${item.status}${item.error ? ` (${item.error})` : ''}`)
    .join('\n')
}

function buildConflictPreview(conflicts: PullConflictItem[]): string {
  if (!conflicts.length) return '-'
  return conflicts
    .slice(0, 8)
    .map((item) => `#${item.seq} ${item.topicId} (${item.op}, ${item.reason})`)
    .join('\n')
}

function syncModeHelp(syncMode: SyncMode, text: TopicSyncText): string {
  if (syncMode === 'push_only') return text.modeHelp.pushOnly
  if (syncMode === 'manual_pull') return text.modeHelp.manualPull
  if (syncMode === 'auto_safe') return text.modeHelp.autoSafe
  return text.modeHelp.autoFull
}

function progressPhaseLabel(phase: SyncProgressState['phase'], text: TopicSyncText): string {
  if (phase === 'pull') return text.progressPhase.pull
  if (phase === 'push_upsert') return text.progressPhase.push
  if (phase === 'push_delete') return text.progressPhase.delete
  return text.progressPhase.idle
}

const TopicSyncSettings: FC = () => {
  const { theme } = useTheme()
  const [server, setServer] = useState('')
  const [token, setToken] = useState('')
  const [language, setLanguage] = useState(() => localStorage.getItem('language') || navigator.language)
  const [runtime, setRuntime] = useState<SyncRuntimeState>(DEFAULT_RUNTIME_STATE)
  const text = useMemo(() => getTopicSyncText(language), [language])

  useEffect(() => {
    setServer(localStorage.getItem(SYNC_SERVER_KEY) || '')
    setToken(localStorage.getItem(SYNC_TOKEN_KEY) || '')
    setLanguage(localStorage.getItem('language') || navigator.language)
    setRuntime(parseRuntimeState(localStorage.getItem(SYNC_RUNTIME_KEY)))

    const handleRuntimeUpdate = () => {
      setLanguage(localStorage.getItem('language') || navigator.language)
      setRuntime(parseRuntimeState(localStorage.getItem(SYNC_RUNTIME_KEY)))
    }
    const timer = setInterval(handleRuntimeUpdate, 1500)
    window.addEventListener('cherry-sync-runtime', handleRuntimeUpdate as EventListener)

    return () => {
      clearInterval(timer)
      window.removeEventListener('cherry-sync-runtime', handleRuntimeUpdate as EventListener)
    }
  }, [])

  const saveConfig = () => {
    const normalizedServer = server.trim().replace(/\/+$/, '')
    const normalizedToken = token.trim()

    if (normalizedServer) localStorage.setItem(SYNC_SERVER_KEY, normalizedServer)
    else localStorage.removeItem(SYNC_SERVER_KEY)

    if (normalizedToken) localStorage.setItem(SYNC_TOKEN_KEY, normalizedToken)
    else localStorage.removeItem(SYNC_TOKEN_KEY)

    setServer(normalizedServer)
    setToken(normalizedToken)
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.dispatchEvent(new Event('cherry-sync-check'))
    window.dispatchEvent(new Event('cherry-sync-force'))
    window.toast.success(text.toasts.saved)
  }

  const clearOverrides = () => {
    localStorage.removeItem(SYNC_SERVER_KEY)
    localStorage.removeItem(SYNC_TOKEN_KEY)
    setServer('')
    setToken('')
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.dispatchEvent(new Event('cherry-sync-check'))
    window.toast.success(text.toasts.cleared)
  }

  const triggerSyncNow = () => {
    window.dispatchEvent(new Event('cherry-sync-force'))
    window.toast.success(text.toasts.triggered)
  }

  const triggerFullPush = () => {
    window.modal.confirm({
      centered: true,
      title: text.modals.fullPush.title,
      content: text.modals.fullPush.content,
      okText: text.modals.fullPush.confirm,
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-push-full'))
        window.toast.success(text.modals.fullPush.triggered)
      }
    })
  }

  const triggerFullPushPrune = () => {
    window.modal.confirm({
      centered: true,
      title: text.modals.fullPushPrune.title,
      content: text.modals.fullPushPrune.content,
      okText: text.modals.fullPushPrune.confirm,
      okButtonProps: { danger: true },
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-push-full-prune'))
        window.toast.success(text.modals.fullPushPrune.triggered)
      }
    })
  }

  const checkConnection = () => {
    window.dispatchEvent(new Event('cherry-sync-check'))
    window.toast.success(text.toasts.checking)
  }

  const setSyncMode = (mode: SyncMode) => {
    const normalized = normalizeSyncMode(mode)
    localStorage.setItem(SYNC_MODE_KEY, normalized)
    setRuntime((prev) => ({
      ...prev,
      syncMode: normalized
    }))
    window.dispatchEvent(new CustomEvent('cherry-sync-set-mode', { detail: { mode: normalized } }))
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.toast.success(text.toasts.modeUpdated)
  }

  const setSyncInterval = (intervalMs: number) => {
    const normalized = normalizeSyncIntervalMs(intervalMs)
    localStorage.setItem(SYNC_INTERVAL_KEY, String(normalized))
    setRuntime((prev) => ({
      ...prev,
      syncIntervalMs: normalized
    }))
    window.dispatchEvent(new CustomEvent('cherry-sync-set-interval', { detail: { intervalMs: normalized } }))
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.toast.success(text.toasts.intervalUpdated)
  }

  const setConflictPolicy = (policy: ConflictPolicy) => {
    const normalized = normalizeConflictPolicy(policy)
    localStorage.setItem(SYNC_CONFLICT_POLICY_KEY, normalized)
    setRuntime((prev) => ({
      ...prev,
      conflictPolicy: normalized
    }))
    window.dispatchEvent(new CustomEvent('cherry-sync-set-conflict-policy', { detail: { policy: normalized } }))
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.toast.success(text.toasts.conflictPolicyUpdated)
  }

  const triggerPullPreview = () => {
    window.dispatchEvent(new Event('cherry-sync-pull-preview'))
    window.toast.success(text.toasts.pullPreviewTriggered)
  }

  const triggerPullApply = () => {
    window.dispatchEvent(new Event('cherry-sync-pull-apply'))
    window.toast.success(text.toasts.pullApplyTriggered)
  }

  const resolveConflictsAsLocal = () => {
    window.dispatchEvent(new CustomEvent('cherry-sync-resolve-conflicts', { detail: { policy: 'local_wins' } }))
    window.toast.success(text.toasts.resolveLocalTriggered)
  }

  const resolveConflictsAsServer = () => {
    window.dispatchEvent(new CustomEvent('cherry-sync-resolve-conflicts', { detail: { policy: 'server_wins' } }))
    window.toast.success(text.toasts.resolveServerTriggered)
  }

  const retryFailedActions = () => {
    window.dispatchEvent(new Event('cherry-sync-retry-failed-actions'))
    window.toast.success(text.toasts.retryFailedTriggered)
  }

  const dismissErrors = () => {
    window.dispatchEvent(new Event('cherry-sync-dismiss-errors'))
    window.toast.success(text.toasts.dismissErrors)
  }

  const rebuildBaseline = () => {
    window.modal.confirm({
      centered: true,
      title: text.modals.rebuildBaseline.title,
      content: text.modals.rebuildBaseline.content,
      okText: text.modals.rebuildBaseline.confirm,
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-rebuild-baseline'))
        window.toast.success(text.toasts.rebuildBaselineDone)
      }
    })
  }

  const copyDebugInfo = async () => {
    const debugInfo = JSON.stringify(
      {
        localServer: localStorage.getItem(SYNC_SERVER_KEY) || '',
        localTokenConfigured: Boolean(localStorage.getItem(SYNC_TOKEN_KEY)),
        runtime
      },
      null,
      2
    )
    try {
      await navigator.clipboard.writeText(debugInfo)
      window.toast.success(text.toasts.copied)
    } catch {
      window.toast.error(text.toasts.copyFailed)
    }
  }

  const runtimeTag = runtime.running ? (
    <Tag color="processing">{text.status.running}</Tag>
  ) : runtime.configured ? (
    <Tag color="success">{text.status.ready}</Tag>
  ) : (
    <Tag>{text.status.notConfigured}</Tag>
  )

  const hasFailures = runtime.lastFailures.length > 0
  const pendingConflictCount = runtime.pendingConflicts.length
  const canOperate = runtime.configured && !runtime.running
  const progress = runtime.syncProgress
  const progressPercent =
    progress.total > 0 ? Math.min(100, Math.round((Math.max(0, progress.processed) / progress.total) * 100)) : 0
  const progressText = runtime.running
    ? `${progressPhaseLabel(progress.phase, text)} ${progress.processed}/${progress.total}${
        progress.failed > 0 ? ` (${text.failedInline(progress.failed)})` : ''
      }`
    : text.progressPhase.idle
  const savedServer = localStorage.getItem(SYNC_SERVER_KEY) || ''
  const savedToken = localStorage.getItem(SYNC_TOKEN_KEY) || ''
  const hasUnsavedConfig = useMemo(() => {
    return server.trim().replace(/\/+$/, '') !== savedServer || token.trim() !== savedToken
  }, [savedServer, savedToken, server, token])

  const summaryCards = [
    {
      key: 'status',
      label: text.fields.status,
      value: runtimeTag
    },
    {
      key: 'connection',
      label: text.fields.connection,
      value: (
        <HStack gap="8px" alignItems="center">
          {connectionTag(runtime.connectionStatus, text)}
          {runtime.lastHttpStatus ? <span>HTTP {runtime.lastHttpStatus}</span> : null}
        </HStack>
      )
    },
    {
      key: 'lastSync',
      label: text.fields.lastSync,
      value: formatTimestamp(runtime.lastSyncAt)
    },
    {
      key: 'lastPull',
      label: text.fields.lastPull,
      value: formatTimestamp(runtime.lastPullAt)
    },
    {
      key: 'cursor',
      label: text.fields.pullCursor,
      value: String(runtime.pullCursor)
    },
    {
      key: 'source',
      label: text.fields.currentSource,
      value: sourceLabel(runtime.configSource, text)
    },
    {
      key: 'interval',
      label: text.fields.interval,
      value: formatIntervalLabel(runtime.syncIntervalMs, text)
    },
    {
      key: 'progress',
      label: text.progress,
      value: runtime.running ? `${progressPercent}% · ${progressText}` : progressText
    },
    {
      key: 'server',
      label: text.fields.effectiveServer,
      value: runtime.server || '-'
    }
  ]

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>
        <HStack gap="8px" alignItems="center">
          <SyncOutlined />
          {text.title}
        </HStack>
      </SettingTitle>
      <SettingRow>
        <SettingHelpText>{text.precedence}</SettingHelpText>
      </SettingRow>
      <SettingDivider />

      {runtime.lastError ? (
        <>
          <Alert
            type={hasFailures ? 'error' : 'warning'}
            showIcon
            message={runtime.lastError}
            description={
              hasFailures ? (
                <div>
                  <div>
                    {text.failedReasons}: {summarizeFailureReasons(runtime.lastFailures)}
                  </div>
                  <PreviewText>{buildFailurePreview(runtime.lastFailures)}</PreviewText>
                </div>
              ) : undefined
            }
            action={
              hasFailures ? (
                <ButtonRow>
                  <Button size="small" type="primary" disabled={!canOperate} onClick={retryFailedActions}>
                    {text.actions.retryFailed}
                  </Button>
                  <Button size="small" onClick={dismissErrors}>
                    {text.actions.dismiss}
                  </Button>
                  <Button size="small" onClick={rebuildBaseline}>
                    {text.actions.rebuildBaseline}
                  </Button>
                </ButtonRow>
              ) : (
                <Button size="small" onClick={dismissErrors}>
                  {text.actions.dismiss}
                </Button>
              )
            }
          />
          <SettingDivider />
        </>
      ) : null}

      {pendingConflictCount > 0 ? (
        <>
          <Alert
            type="warning"
            showIcon
            message={text.pendingConflictsMessage(pendingConflictCount)}
            description={<PreviewText>{buildConflictPreview(runtime.pendingConflicts)}</PreviewText>}
            action={
              <ButtonRow>
                <Button size="small" disabled={!canOperate} onClick={resolveConflictsAsLocal}>
                  {text.actions.resolveLocal}
                </Button>
                <Button size="small" disabled={!canOperate} onClick={resolveConflictsAsServer}>
                  {text.actions.resolveServer}
                </Button>
              </ButtonRow>
            }
          />
          <SettingDivider />
        </>
      ) : null}

      <Section>
        <SectionTitle>{text.sections.connection}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{text.fields.server}</SettingRowTitle>
          <Input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="http://127.0.0.1:3456"
            style={{ width: 340 }}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{text.fields.token}</SettingRowTitle>
          <Input.Password
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={text.tokenPlaceholder}
            style={{ width: 340 }}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{text.fields.actions}</SettingRowTitle>
          <ButtonRow>
            <Button type={hasUnsavedConfig ? 'primary' : 'default'} onClick={saveConfig}>
              {text.save}
            </Button>
            <Button onClick={checkConnection}>{text.actions.checkConnection}</Button>
            <Button onClick={clearOverrides}>{text.actions.clear}</Button>
          </ButtonRow>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{text.sections.strategy}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{text.fields.mode}</SettingRowTitle>
          <Select
            value={runtime.syncMode}
            onChange={(value) => setSyncMode(value as SyncMode)}
            style={{ width: 240 }}
            options={[
              { value: 'push_only', label: text.mode.pushOnly },
              { value: 'manual_pull', label: text.mode.manualPull },
              { value: 'auto_safe', label: text.mode.autoSafe },
              { value: 'auto_full', label: text.mode.autoFull }
            ]}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{text.fields.interval}</SettingRowTitle>
          <Select
            value={runtime.syncIntervalMs}
            onChange={(value) => setSyncInterval(value as number)}
            style={{ width: 240 }}
            options={[10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000].map((intervalMs) => ({
              value: intervalMs,
              label: formatIntervalLabel(intervalMs, text)
            }))}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{text.fields.conflictPolicy}</SettingRowTitle>
          <Select
            value={runtime.conflictPolicy}
            onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
            style={{ width: 240 }}
            options={[
              { value: 'local_wins', label: text.conflictPolicy.localWins },
              { value: 'server_wins', label: text.conflictPolicy.serverWins }
            ]}
          />
        </SettingRow>
        <SettingRow>
          <SettingHelpText>{syncModeHelp(runtime.syncMode, text)}</SettingHelpText>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{text.sections.operations}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{text.fields.syncNow}</SettingRowTitle>
          <ButtonRow>
            <Button type="primary" disabled={!canOperate} onClick={triggerSyncNow}>
              {text.actions.syncNow}
            </Button>
            <Button danger disabled={!canOperate} onClick={triggerFullPush}>
              {text.actions.fullPush}
            </Button>
            <Button danger disabled={!canOperate} onClick={triggerFullPushPrune}>
              {text.actions.fullPushPrune}
            </Button>
            <Button disabled={!canOperate} onClick={triggerPullPreview}>
              {text.actions.pullPreview}
            </Button>
            <Button disabled={!canOperate} onClick={triggerPullApply}>
              {text.actions.pullApply}
            </Button>
          </ButtonRow>
        </SettingRow>
        <SettingRow>
          <SettingHelpText>{text.help.pull}</SettingHelpText>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{text.sections.status}</SectionTitle>
        <SummaryGrid>
          {summaryCards.map((item) => (
            <SummaryCard key={item.key}>
              <SummaryLabel>{item.label}</SummaryLabel>
              <SummaryValue>{item.value}</SummaryValue>
            </SummaryCard>
          ))}
        </SummaryGrid>
      </Section>

      <SettingDivider />

      <Collapse
        size="small"
        items={[
          {
            key: 'advanced',
            label: text.advanced,
            children: (
              <Section>
                <SettingRow>
                  <SettingRowTitle>{text.fields.lastChecked}</SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)' }}>{formatTimestamp(runtime.lastCheckedAt)}</div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{text.fields.lastResult}</SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)', maxWidth: 520, textAlign: 'right' }}>
                    {formatLastResult(runtime.lastResult, text)}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{text.fields.lastPullResult}</SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)', maxWidth: 520, textAlign: 'right' }}>
                    {formatPullSummary(runtime.lastPullSummary, text)}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{text.fields.failedItems}</SettingRowTitle>
                  <Tag color={hasFailures ? 'error' : 'success'}>
                    {hasFailures ? text.failedItemsCount(runtime.lastFailures.length) : text.failedItemsNone}
                  </Tag>
                </SettingRow>
                {hasFailures ? (
                  <SettingRow>
                    <PreviewText>{buildFailurePreview(runtime.lastFailures)}</PreviewText>
                  </SettingRow>
                ) : null}
                <SettingRow>
                  <SettingRowTitle>{text.fields.pendingConflicts}</SettingRowTitle>
                  <Tag color={pendingConflictCount > 0 ? 'warning' : 'success'}>
                    {pendingConflictCount > 0
                      ? text.pendingConflictsCount(pendingConflictCount)
                      : text.pendingConflictsNone}
                  </Tag>
                </SettingRow>
                {pendingConflictCount > 0 ? (
                  <SettingRow>
                    <PreviewText>{buildConflictPreview(runtime.pendingConflicts)}</PreviewText>
                  </SettingRow>
                ) : null}
                <SettingRow>
                  <SettingRowTitle>{text.fields.lastError}</SettingRowTitle>
                  <div
                    style={{ color: runtime.lastError ? 'var(--color-error)' : 'var(--color-text-3)', maxWidth: 520 }}>
                    {runtime.lastError || '-'}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{text.fields.copyDebug}</SettingRowTitle>
                  <ButtonRow>
                    <Button icon={<ReloadOutlined />} onClick={copyDebugInfo}>
                      {text.fields.copyDebug}
                    </Button>
                  </ButtonRow>
                </SettingRow>
              </Section>
            )
          }
        ]}
      />
    </SettingGroup>
  )
}

export default TopicSyncSettings
