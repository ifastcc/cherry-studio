import { ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import { Alert, Button, Collapse, Input, Select, Tag } from 'antd'
import dayjs from 'dayjs'
import type { TFunction } from 'i18next'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

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
type SyncActionStatus = 'applied' | 'noop' | 'stale' | 'conflict' | 'not_found' | 'error'

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
  const statuses: SyncActionStatus[] = ['applied', 'noop', 'stale', 'conflict', 'not_found', 'error']

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

function formatIntervalLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

function formatPullSummary(summary: PullSummary | null): string {
  if (!summary) return '-'
  const blocked = summary.blockedSeq ? `, blockedSeq=${summary.blockedSeq}` : ''
  const resolved =
    summary.conflictResolvedLocal > 0 || summary.conflictResolvedServer > 0 || summary.writeBackQueued > 0
      ? `, resolve(local=${summary.conflictResolvedLocal}, server=${summary.conflictResolvedServer}, writeBack=${summary.writeBackQueued})`
      : ''
  return (
    `total=${summary.total}, safe=${summary.safe}, conflicts=${summary.conflicts}, ` +
    `applied=${summary.applied}, cursor=${summary.nextCursor}${blocked}${resolved}`
  )
}

function formatLastResult(result: SyncRuntimeResult | null): string {
  if (!result) return '-'
  return (
    `+${result.added} ~${result.updated} -${result.deleted}; ` +
    `applied=${result.applied}, noop=${result.noop}, stale=${result.stale}, failed=${result.failed}`
  )
}

function sourceLabel(source: ConfigSource): string {
  return source === 'localStorage' ? 'settings' : 'none'
}

function connectionTag(status: ConnectionStatus, t: TFunction) {
  if (status === 'online') return <Tag color="success">{t('settings.data.topic_sync.connection.online', 'Online')}</Tag>
  if (status === 'unauthorized')
    return <Tag color="error">{t('settings.data.topic_sync.connection.unauthorized', 'Unauthorized')}</Tag>
  if (status === 'offline')
    return <Tag color="warning">{t('settings.data.topic_sync.connection.offline', 'Offline')}</Tag>
  return <Tag>{t('settings.data.topic_sync.connection.unknown', 'Unknown')}</Tag>
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

function syncModeHelp(syncMode: SyncMode, t: TFunction): string {
  if (syncMode === 'push_only') {
    return t(
      'settings.data.topic_sync.mode_help_push_only',
      'Only push local updates to server. Use this when one device is source of truth.'
    )
  }
  if (syncMode === 'manual_pull') {
    return t(
      'settings.data.topic_sync.mode_help_manual_pull',
      'Push remains automatic, server pull is manual (preview/apply/resolve by buttons).'
    )
  }
  if (syncMode === 'auto_safe') {
    return t(
      'settings.data.topic_sync.mode_help_auto_safe',
      'Auto-pull only conflict-free server changes, pause at first conflict for manual handling.'
    )
  }
  return t(
    'settings.data.topic_sync.mode_help_auto_full',
    'Auto pull and push. Conflicts are resolved by policy, then local changes can be written back.'
  )
}

function progressPhaseLabel(phase: SyncProgressState['phase']): string {
  if (phase === 'pull') return 'Pull'
  if (phase === 'push_upsert') return 'Push'
  if (phase === 'push_delete') return 'Delete'
  return 'Idle'
}

const TopicSyncSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [server, setServer] = useState('')
  const [token, setToken] = useState('')
  const [runtime, setRuntime] = useState<SyncRuntimeState>(DEFAULT_RUNTIME_STATE)

  useEffect(() => {
    setServer(localStorage.getItem(SYNC_SERVER_KEY) || '')
    setToken(localStorage.getItem(SYNC_TOKEN_KEY) || '')
    setRuntime(parseRuntimeState(localStorage.getItem(SYNC_RUNTIME_KEY)))

    const handleRuntimeUpdate = () => {
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
    window.toast.success(
      t('settings.data.topic_sync.saved', 'Sync settings saved. Changes take effect on next sync cycle.')
    )
  }

  const clearOverrides = () => {
    localStorage.removeItem(SYNC_SERVER_KEY)
    localStorage.removeItem(SYNC_TOKEN_KEY)
    setServer('')
    setToken('')
    window.dispatchEvent(new Event('cherry-sync-runtime'))
    window.dispatchEvent(new Event('cherry-sync-check'))
    window.toast.success(t('settings.data.topic_sync.cleared', 'Local overrides cleared.'))
  }

  const triggerSyncNow = () => {
    window.dispatchEvent(new Event('cherry-sync-force'))
    window.toast.success(t('settings.data.topic_sync.triggered', 'Manual sync triggered.'))
  }

  const triggerFullPush = () => {
    window.modal.confirm({
      centered: true,
      title: t('settings.data.topic_sync.full_push_title', 'Force Full Push to Server?'),
      content: t(
        'settings.data.topic_sync.full_push_content',
        'This will clear local sync baseline and force-upload all local topics to the server.'
      ),
      okText: t('settings.data.topic_sync.full_push_confirm', 'Full Push'),
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-push-full'))
        window.toast.success(
          t('settings.data.topic_sync.full_push_triggered', 'Full push triggered. Uploading all local topics...')
        )
      }
    })
  }

  const triggerFullPushPrune = () => {
    window.modal.confirm({
      centered: true,
      title: t('settings.data.topic_sync.full_push_prune_title', 'Force Full Push and Prune Remote Data?'),
      content: t(
        'settings.data.topic_sync.full_push_prune_content',
        'This will force-upload all local topics and delete topics that exist on server but not in local data. This action is destructive for remote data.'
      ),
      okText: t('settings.data.topic_sync.full_push_prune_confirm', 'Full Push + Prune'),
      okButtonProps: { danger: true },
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-push-full-prune'))
        window.toast.success(
          t(
            'settings.data.topic_sync.full_push_prune_triggered',
            'Full push + prune triggered. Uploading local topics and pruning remote extras...'
          )
        )
      }
    })
  }

  const checkConnection = () => {
    window.dispatchEvent(new Event('cherry-sync-check'))
    window.toast.success(t('settings.data.topic_sync.checking', 'Checking connection...'))
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
    window.toast.success(t('settings.data.topic_sync.mode_updated', 'Sync mode updated.'))
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
    window.toast.success(t('settings.data.topic_sync.interval_updated', 'Sync interval updated.'))
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
    window.toast.success(t('settings.data.topic_sync.conflict_policy_updated', 'Conflict policy updated.'))
  }

  const triggerPullPreview = () => {
    window.dispatchEvent(new Event('cherry-sync-pull-preview'))
    window.toast.success(t('settings.data.topic_sync.pull_preview_triggered', 'Pull preview started.'))
  }

  const triggerPullApply = () => {
    window.dispatchEvent(new Event('cherry-sync-pull-apply'))
    window.toast.success(t('settings.data.topic_sync.pull_apply_triggered', 'Safe pull apply started.'))
  }

  const resolveConflictsAsLocal = () => {
    window.dispatchEvent(new CustomEvent('cherry-sync-resolve-conflicts', { detail: { policy: 'local_wins' } }))
    window.toast.success(
      t('settings.data.topic_sync.resolve_local_triggered', 'Resolving conflicts with local wins and writing back...')
    )
  }

  const resolveConflictsAsServer = () => {
    window.dispatchEvent(new CustomEvent('cherry-sync-resolve-conflicts', { detail: { policy: 'server_wins' } }))
    window.toast.success(
      t('settings.data.topic_sync.resolve_server_triggered', 'Resolving conflicts with server wins...')
    )
  }

  const retryFailedActions = () => {
    window.dispatchEvent(new Event('cherry-sync-retry-failed-actions'))
    window.toast.success(t('settings.data.topic_sync.retry_failed_triggered', 'Retrying failed sync actions...'))
  }

  const dismissErrors = () => {
    window.dispatchEvent(new Event('cherry-sync-dismiss-errors'))
    window.toast.success(t('settings.data.topic_sync.dismiss_errors', 'Sync errors cleared.'))
  }

  const rebuildBaseline = () => {
    window.modal.confirm({
      centered: true,
      title: t('settings.data.topic_sync.rebuild_baseline_title', 'Rebuild Local Sync Baseline?'),
      content: t(
        'settings.data.topic_sync.rebuild_baseline_content',
        'This marks current local topics as already synced and clears the current failed queue.'
      ),
      okText: t('settings.data.topic_sync.rebuild_baseline_confirm', 'Rebuild'),
      onOk: () => {
        window.dispatchEvent(new Event('cherry-sync-rebuild-baseline'))
        window.toast.success(t('settings.data.topic_sync.rebuild_baseline_done', 'Sync baseline rebuilt.'))
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
      window.toast.success(t('settings.data.topic_sync.copied', 'Sync debug info copied.'))
    } catch {
      window.toast.error(t('settings.data.topic_sync.copy_failed', 'Failed to copy debug info.'))
    }
  }

  const runtimeTag = runtime.running ? (
    <Tag color="processing">{t('settings.data.topic_sync.status.running', 'Running')}</Tag>
  ) : runtime.configured ? (
    <Tag color="success">{t('settings.data.topic_sync.status.ready', 'Ready')}</Tag>
  ) : (
    <Tag>{t('settings.data.topic_sync.status.not_configured', 'Not configured')}</Tag>
  )

  const hasFailures = runtime.lastFailures.length > 0
  const pendingConflictCount = runtime.pendingConflicts.length
  const canOperate = runtime.configured && !runtime.running
  const progress = runtime.syncProgress
  const progressPercent =
    progress.total > 0 ? Math.min(100, Math.round((Math.max(0, progress.processed) / progress.total) * 100)) : 0
  const progressText = runtime.running
    ? `${progressPhaseLabel(progress.phase)} ${progress.processed}/${progress.total}${
        progress.failed > 0 ? ` (failed=${progress.failed})` : ''
      }`
    : 'Idle'
  const savedServer = localStorage.getItem(SYNC_SERVER_KEY) || ''
  const savedToken = localStorage.getItem(SYNC_TOKEN_KEY) || ''
  const hasUnsavedConfig = useMemo(() => {
    return server.trim().replace(/\/+$/, '') !== savedServer || token.trim() !== savedToken
  }, [savedServer, savedToken, server, token])

  const summaryCards = [
    {
      key: 'status',
      label: t('settings.data.topic_sync.status_label', 'Status'),
      value: runtimeTag
    },
    {
      key: 'connection',
      label: t('settings.data.topic_sync.connection_label', 'Connection'),
      value: (
        <HStack gap="8px" alignItems="center">
          {connectionTag(runtime.connectionStatus, t)}
          {runtime.lastHttpStatus ? <span>HTTP {runtime.lastHttpStatus}</span> : null}
        </HStack>
      )
    },
    {
      key: 'lastSync',
      label: t('settings.data.topic_sync.last_sync', 'Last Sync'),
      value: formatTimestamp(runtime.lastSyncAt)
    },
    {
      key: 'lastPull',
      label: t('settings.data.topic_sync.last_pull', 'Last Pull'),
      value: formatTimestamp(runtime.lastPullAt)
    },
    {
      key: 'cursor',
      label: t('settings.data.topic_sync.pull_cursor', 'Pull Cursor'),
      value: String(runtime.pullCursor)
    },
    {
      key: 'source',
      label: t('settings.data.topic_sync.current_source', 'Current Source'),
      value: sourceLabel(runtime.configSource)
    },
    {
      key: 'interval',
      label: t('settings.data.topic_sync.interval_label', 'Sync Interval'),
      value: formatIntervalLabel(runtime.syncIntervalMs)
    },
    {
      key: 'progress',
      label: 'Progress',
      value: runtime.running ? `${progressPercent}% · ${progressText}` : progressText
    },
    {
      key: 'server',
      label: t('settings.data.topic_sync.effective_server', 'Effective Server'),
      value: runtime.server || '-'
    }
  ]

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>
        <HStack gap="8px" alignItems="center">
          <SyncOutlined />
          {t('settings.data.topic_sync.title', 'Topic Sync')}
        </HStack>
      </SettingTitle>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.precedence',
            'Sync settings are saved in this page and take effect immediately after saving.'
          )}
        </SettingHelpText>
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
                    {t('settings.data.topic_sync.failed_reasons', 'Top failure reasons')}:{' '}
                    {summarizeFailureReasons(runtime.lastFailures)}
                  </div>
                  <PreviewText>{buildFailurePreview(runtime.lastFailures)}</PreviewText>
                </div>
              ) : undefined
            }
            action={
              hasFailures ? (
                <ButtonRow>
                  <Button size="small" type="primary" disabled={!canOperate} onClick={retryFailedActions}>
                    {t('settings.data.topic_sync.retry_failed', 'Retry Failed')}
                  </Button>
                  <Button size="small" onClick={dismissErrors}>
                    {t('settings.data.topic_sync.dismiss_error', 'Dismiss')}
                  </Button>
                  <Button size="small" onClick={rebuildBaseline}>
                    {t('settings.data.topic_sync.rebuild_baseline', 'Rebuild Baseline')}
                  </Button>
                </ButtonRow>
              ) : (
                <Button size="small" onClick={dismissErrors}>
                  {t('settings.data.topic_sync.dismiss_error', 'Dismiss')}
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
            message={t('settings.data.topic_sync.pending_conflicts_count', '{{count}} pending conflicts', {
              count: pendingConflictCount
            })}
            description={<PreviewText>{buildConflictPreview(runtime.pendingConflicts)}</PreviewText>}
            action={
              <ButtonRow>
                <Button size="small" disabled={!canOperate} onClick={resolveConflictsAsLocal}>
                  {t('settings.data.topic_sync.resolve_local', 'Resolve Local Wins')}
                </Button>
                <Button size="small" disabled={!canOperate} onClick={resolveConflictsAsServer}>
                  {t('settings.data.topic_sync.resolve_server', 'Resolve Server Wins')}
                </Button>
              </ButtonRow>
            }
          />
          <SettingDivider />
        </>
      ) : null}

      <Section>
        <SectionTitle>{t('settings.data.topic_sync.connection_section', 'Connection')}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.server', 'Sync Server')}</SettingRowTitle>
          <Input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="http://127.0.0.1:3456"
            style={{ width: 340 }}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.token', 'Sync Token')}</SettingRowTitle>
          <Input.Password
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('settings.data.topic_sync.token_placeholder', 'Optional')}
            style={{ width: 340 }}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.actions', 'Actions')}</SettingRowTitle>
          <ButtonRow>
            <Button type={hasUnsavedConfig ? 'primary' : 'default'} onClick={saveConfig}>
              {t('common.save', 'Save')}
            </Button>
            <Button onClick={checkConnection}>
              {t('settings.data.topic_sync.check_connection', 'Check Connection')}
            </Button>
            <Button onClick={clearOverrides}>{t('settings.data.topic_sync.clear', 'Clear Local Override')}</Button>
          </ButtonRow>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{t('settings.data.topic_sync.strategy_section', 'Sync Strategy')}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.mode_label', 'Sync Mode')}</SettingRowTitle>
          <Select
            value={runtime.syncMode}
            onChange={(value) => setSyncMode(value as SyncMode)}
            style={{ width: 240 }}
            options={[
              { value: 'push_only', label: t('settings.data.topic_sync.mode.push_only', 'Push Only') },
              { value: 'manual_pull', label: t('settings.data.topic_sync.mode.manual_pull', 'Manual Pull') },
              { value: 'auto_safe', label: t('settings.data.topic_sync.mode.auto_safe', 'Auto Safe Pull') },
              { value: 'auto_full', label: t('settings.data.topic_sync.mode.auto_full', 'Auto Full (Pull + Push)') }
            ]}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.interval_label', 'Sync Interval')}</SettingRowTitle>
          <Select
            value={runtime.syncIntervalMs}
            onChange={(value) => setSyncInterval(value as number)}
            style={{ width: 240 }}
            options={[10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000].map((intervalMs) => ({
              value: intervalMs,
              label: formatIntervalLabel(intervalMs)
            }))}
          />
        </SettingRow>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.conflict_policy_label', 'Conflict Policy')}</SettingRowTitle>
          <Select
            value={runtime.conflictPolicy}
            onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
            style={{ width: 240 }}
            options={[
              { value: 'local_wins', label: t('settings.data.topic_sync.conflict_policy.local_wins', 'Local Wins') },
              { value: 'server_wins', label: t('settings.data.topic_sync.conflict_policy.server_wins', 'Server Wins') }
            ]}
          />
        </SettingRow>
        <SettingRow>
          <SettingHelpText>{syncModeHelp(runtime.syncMode, t)}</SettingHelpText>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{t('settings.data.topic_sync.operation_section', 'Sync Operations')}</SectionTitle>
        <SettingRow>
          <SettingRowTitle>{t('settings.data.topic_sync.sync_now', 'Sync Now')}</SettingRowTitle>
          <ButtonRow>
            <Button type="primary" disabled={!canOperate} onClick={triggerSyncNow}>
              {t('settings.data.topic_sync.sync_now', 'Sync Now')}
            </Button>
            <Button danger disabled={!canOperate} onClick={triggerFullPush}>
              {t('settings.data.topic_sync.full_push', 'Full Push')}
            </Button>
            <Button danger disabled={!canOperate} onClick={triggerFullPushPrune}>
              {t('settings.data.topic_sync.full_push_prune', 'Full Push + Prune')}
            </Button>
            <Button disabled={!canOperate} onClick={triggerPullPreview}>
              {t('settings.data.topic_sync.pull_preview', 'Preview Pull')}
            </Button>
            <Button disabled={!canOperate} onClick={triggerPullApply}>
              {t('settings.data.topic_sync.pull_apply', 'Apply Safe Pull')}
            </Button>
          </ButtonRow>
        </SettingRow>
        <SettingRow>
          <SettingHelpText>
            {t(
              'settings.data.topic_sync.pull_help',
              'Preview analyzes server changes only. Apply Safe Pull writes non-conflicting changes and pauses at first conflict.'
            )}
          </SettingHelpText>
        </SettingRow>
      </Section>

      <SettingDivider />

      <Section>
        <SectionTitle>{t('settings.data.topic_sync.status_section', 'Status Overview')}</SectionTitle>
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
            label: t('settings.data.topic_sync.advanced', 'Advanced Diagnostics'),
            children: (
              <Section>
                <SettingRow>
                  <SettingRowTitle>{t('settings.data.topic_sync.last_checked', 'Last Checked')}</SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)' }}>{formatTimestamp(runtime.lastCheckedAt)}</div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{t('settings.data.topic_sync.last_result', 'Last Result')}</SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)', maxWidth: 520, textAlign: 'right' }}>
                    {formatLastResult(runtime.lastResult)}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>
                    {t('settings.data.topic_sync.last_pull_result', 'Last Pull Result')}
                  </SettingRowTitle>
                  <div style={{ color: 'var(--color-text-3)', maxWidth: 520, textAlign: 'right' }}>
                    {formatPullSummary(runtime.lastPullSummary)}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{t('settings.data.topic_sync.failed_items', 'Failed Items')}</SettingRowTitle>
                  <Tag color={hasFailures ? 'error' : 'success'}>
                    {hasFailures
                      ? t('settings.data.topic_sync.failed_items_count', '{{count}} failed', {
                          count: runtime.lastFailures.length
                        })
                      : t('settings.data.topic_sync.failed_items_none', 'No failed items')}
                  </Tag>
                </SettingRow>
                {hasFailures ? (
                  <SettingRow>
                    <PreviewText>{buildFailurePreview(runtime.lastFailures)}</PreviewText>
                  </SettingRow>
                ) : null}
                <SettingRow>
                  <SettingRowTitle>
                    {t('settings.data.topic_sync.pending_conflicts', 'Pending Conflicts')}
                  </SettingRowTitle>
                  <Tag color={pendingConflictCount > 0 ? 'warning' : 'success'}>
                    {pendingConflictCount > 0
                      ? t('settings.data.topic_sync.pending_conflicts_count', '{{count}} pending', {
                          count: pendingConflictCount
                        })
                      : t('settings.data.topic_sync.pending_conflicts_none', 'No pending conflicts')}
                  </Tag>
                </SettingRow>
                {pendingConflictCount > 0 ? (
                  <SettingRow>
                    <PreviewText>{buildConflictPreview(runtime.pendingConflicts)}</PreviewText>
                  </SettingRow>
                ) : null}
                <SettingRow>
                  <SettingRowTitle>{t('settings.data.topic_sync.last_error', 'Last Error')}</SettingRowTitle>
                  <div
                    style={{ color: runtime.lastError ? 'var(--color-error)' : 'var(--color-text-3)', maxWidth: 520 }}>
                    {runtime.lastError || '-'}
                  </div>
                </SettingRow>
                <SettingRow>
                  <SettingRowTitle>{t('settings.data.topic_sync.copy_debug', 'Copy Debug Info')}</SettingRowTitle>
                  <ButtonRow>
                    <Button icon={<ReloadOutlined />} onClick={copyDebugInfo}>
                      {t('settings.data.topic_sync.copy_debug', 'Copy Debug Info')}
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
