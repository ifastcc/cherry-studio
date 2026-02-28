import { ReloadOutlined, SyncOutlined } from '@ant-design/icons'
import { HStack } from '@renderer/components/Layout'
import { useTheme } from '@renderer/context/ThemeProvider'
import { Button, Input, Select, Tag } from 'antd'
import dayjs from 'dayjs'
import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { SettingDivider, SettingGroup, SettingHelpText, SettingRow, SettingRowTitle, SettingTitle } from '..'

const SYNC_SERVER_KEY = 'cherry-sync-server'
const SYNC_TOKEN_KEY = 'cherry-sync-token'
const SYNC_RUNTIME_KEY = 'cherry-sync-runtime'
const SYNC_MODE_KEY = 'cherry-sync-mode'
const SYNC_CONFLICT_POLICY_KEY = 'cherry-sync-conflict-policy'

type ConfigSource = 'localStorage' | 'file' | 'env' | 'none'
type ConnectionStatus = 'unknown' | 'online' | 'offline' | 'unauthorized'
type SyncMode = 'push_only' | 'manual_pull' | 'auto_safe' | 'auto_full'
type ConflictPolicy = 'local_wins' | 'server_wins'

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

interface SyncRuntimeState {
  configured: boolean
  server: string
  tokenConfigured: boolean
  configSource: ConfigSource
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
  lastError: string | null
}

const DEFAULT_RUNTIME_STATE: SyncRuntimeState = {
  configured: false,
  server: '',
  tokenConfigured: false,
  configSource: 'none',
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
  lastError: null
}

function parseRuntimeState(raw: string | null): SyncRuntimeState {
  if (!raw) return { ...DEFAULT_RUNTIME_STATE }

  try {
    const parsed = JSON.parse(raw) as Partial<SyncRuntimeState>
    const localMode = normalizeSyncMode(localStorage.getItem(SYNC_MODE_KEY))
    const parsedMode = normalizeSyncMode(typeof parsed.syncMode === 'string' ? parsed.syncMode : null)
    const syncMode = parsedMode === 'push_only' && localMode !== 'push_only' ? localMode : parsedMode
    const localPolicy = normalizeConflictPolicy(localStorage.getItem(SYNC_CONFLICT_POLICY_KEY))
    const parsedPolicy = normalizeConflictPolicy(typeof parsed.conflictPolicy === 'string' ? parsed.conflictPolicy : null)
    const conflictPolicy = parsedPolicy === 'local_wins' && localPolicy !== 'local_wins' ? localPolicy : parsedPolicy

    return {
      ...DEFAULT_RUNTIME_STATE,
      ...parsed,
      syncMode,
      conflictPolicy,
      lastPullSummary: parsed.lastPullSummary ? { ...parsed.lastPullSummary } : null,
      pendingConflicts: Array.isArray(parsed.pendingConflicts) ? [...parsed.pendingConflicts] : [],
      lastResult: parsed.lastResult ? { ...parsed.lastResult } : null
    }
  } catch {
    return { ...DEFAULT_RUNTIME_STATE }
  }
}

function normalizeSyncMode(raw: string | null): SyncMode {
  if (raw === 'manual_pull' || raw === 'auto_safe' || raw === 'auto_full' || raw === 'push_only') return raw
  return 'push_only'
}

function normalizeConflictPolicy(raw: string | null): ConflictPolicy {
  if (raw === 'local_wins' || raw === 'server_wins') return raw
  return 'local_wins'
}

function formatTimestamp(value: number | null): string {
  if (!value) return '-'
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

function sourceLabel(source: ConfigSource): string {
  if (source === 'localStorage') return 'localStorage'
  if (source === 'file') return 'cherry-sync.json'
  if (source === 'env') return '.env'
  return 'none'
}

function connectionTag(status: ConnectionStatus, t: any) {
  if (status === 'online') return <Tag color="success">{t('settings.data.topic_sync.connection.online', 'Online')}</Tag>
  if (status === 'unauthorized')
    return <Tag color="error">{t('settings.data.topic_sync.connection.unauthorized', 'Unauthorized')}</Tag>
  if (status === 'offline') return <Tag color="warning">{t('settings.data.topic_sync.connection.offline', 'Offline')}</Tag>
  return <Tag>{t('settings.data.topic_sync.connection.unknown', 'Unknown')}</Tag>
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

const TopicSyncSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [server, setServer] = useState('')
  const [token, setToken] = useState('')
  const [appDataPath, setAppDataPath] = useState('')
  const [runtime, setRuntime] = useState<SyncRuntimeState>(DEFAULT_RUNTIME_STATE)

  useEffect(() => {
    setServer(localStorage.getItem(SYNC_SERVER_KEY) || '')
    setToken(localStorage.getItem(SYNC_TOKEN_KEY) || '')
    setRuntime(parseRuntimeState(localStorage.getItem(SYNC_RUNTIME_KEY)))

    window.api
      .getAppInfo()
      .then((info) => {
        setAppDataPath(info?.appDataPath || '')
      })
      .catch(() => {
        setAppDataPath('')
      })

    const handleRuntimeUpdate = () => {
      setRuntime(parseRuntimeState(localStorage.getItem(SYNC_RUNTIME_KEY)))
    }
    const timer = setInterval(handleRuntimeUpdate, 2000)
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
    window.toast.success(t('settings.data.topic_sync.resolve_server_triggered', 'Resolving conflicts with server wins...'))
  }

  const openAppDataPath = () => {
    if (!appDataPath) return
    window.api.openPath(appDataPath)
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
    await navigator.clipboard.writeText(debugInfo)
    window.toast.success(t('settings.data.topic_sync.copied', 'Sync debug info copied.'))
  }

  const lastResult = runtime.lastResult
    ? `+${runtime.lastResult.added} ~${runtime.lastResult.updated} -${runtime.lastResult.deleted}; ` +
      `applied=${runtime.lastResult.applied}, noop=${runtime.lastResult.noop}, ` +
      `stale=${runtime.lastResult.stale}, failed=${runtime.lastResult.failed}`
    : '-'
  const lastPullResult = formatPullSummary(runtime.lastPullSummary)
  const pendingConflictCount = runtime.pendingConflicts.length
  const pendingConflictPreview = runtime.pendingConflicts
    .slice(0, 5)
    .map((item) => {
      const reason = item.reason === 'remote_timestamp_missing' ? 'remote_timestamp_missing' : 'local_newer'
      return `#${item.seq} ${item.topicId} (${item.op}, ${reason})`
    })
    .join('\n')

  const runtimeTag = runtime.running ? (
    <Tag color="processing">{t('settings.data.topic_sync.status.running', 'Running')}</Tag>
  ) : runtime.configured ? (
    <Tag color="success">{t('settings.data.topic_sync.status.ready', 'Ready')}</Tag>
  ) : (
    <Tag>{t('settings.data.topic_sync.status.not_configured', 'Not configured')}</Tag>
  )

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>
        <HStack gap="8px" alignItems="center">
          <SyncOutlined />
          {t('settings.data.topic_sync.title', 'Topic Sync')}
        </HStack>
      </SettingTitle>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.server', 'Sync Server')}</SettingRowTitle>
        <Input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="http://127.0.0.1:3456"
          style={{ width: 320 }}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.token', 'Sync Token')}</SettingRowTitle>
        <Input.Password
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('settings.data.topic_sync.token_placeholder', 'Optional')}
          style={{ width: 320 }}
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.precedence',
            'Priority: localStorage override > cherry-sync.json > .env. Clearing local overrides restores file/env behavior.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.mode_label', 'Sync Mode')}</SettingRowTitle>
        <Select
          value={runtime.syncMode}
          onChange={(value) => setSyncMode(value as SyncMode)}
          style={{ width: 220 }}
          options={[
            {
              value: 'push_only',
              label: t('settings.data.topic_sync.mode.push_only', 'Push Only')
            },
            {
              value: 'manual_pull',
              label: t('settings.data.topic_sync.mode.manual_pull', 'Manual Pull')
            },
            {
              value: 'auto_safe',
              label: t('settings.data.topic_sync.mode.auto_safe', 'Auto Safe Pull')
            },
            {
              value: 'auto_full',
              label: t('settings.data.topic_sync.mode.auto_full', 'Auto Full (Pull + Push)')
            }
          ]}
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.mode_help',
            'Push Only: only local -> server. Manual Pull: inspect/apply server updates manually. Auto Safe Pull: auto-apply server updates only when no local conflict. Auto Full: auto pull + auto push, and resolve conflicts by policy.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.conflict_policy_label', 'Conflict Policy')}</SettingRowTitle>
        <Select
          value={runtime.conflictPolicy}
          onChange={(value) => setConflictPolicy(value as ConflictPolicy)}
          style={{ width: 220 }}
          options={[
            {
              value: 'local_wins',
              label: t('settings.data.topic_sync.conflict_policy.local_wins', 'Local Wins (Write Back)')
            },
            {
              value: 'server_wins',
              label: t('settings.data.topic_sync.conflict_policy.server_wins', 'Server Wins')
            }
          ]}
        />
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.conflict_policy_help',
            'Local wins keeps local topic and writes it back to server. Server wins overwrites local topic with server version.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.actions', 'Actions')}</SettingRowTitle>
        <HStack gap="8px">
          <Button type="primary" onClick={saveConfig}>
            {t('common.save', 'Save')}
          </Button>
          <Button onClick={triggerSyncNow}>
            {t('settings.data.topic_sync.sync_now', 'Sync Now')}
          </Button>
          <Button onClick={checkConnection}>{t('settings.data.topic_sync.check_connection', 'Check Connection')}</Button>
          <Button onClick={clearOverrides}>{t('settings.data.topic_sync.clear', 'Clear')}</Button>
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.pull_actions', 'Pull Actions')}</SettingRowTitle>
        <HStack gap="8px">
          <Button onClick={triggerPullPreview} disabled={!runtime.configured || runtime.running}>
            {t('settings.data.topic_sync.pull_preview', 'Preview Pull')}
          </Button>
          <Button onClick={triggerPullApply} disabled={!runtime.configured || runtime.running}>
            {t('settings.data.topic_sync.pull_apply', 'Apply Safe Pull')}
          </Button>
        </HStack>
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.pull_help',
            'Preview only analyzes server changes. Apply Safe Pull writes only non-conflicting changes and stops at first conflict.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.conflict_actions', 'Conflict Actions')}</SettingRowTitle>
        <HStack gap="8px">
          <Button onClick={resolveConflictsAsLocal} disabled={pendingConflictCount === 0 || runtime.running}>
            {t('settings.data.topic_sync.resolve_local', 'Resolve Local Wins')}
          </Button>
          <Button onClick={resolveConflictsAsServer} disabled={pendingConflictCount === 0 || runtime.running}>
            {t('settings.data.topic_sync.resolve_server', 'Resolve Server Wins')}
          </Button>
        </HStack>
      </SettingRow>
      <SettingRow>
        <SettingHelpText>
          {t(
            'settings.data.topic_sync.conflict_actions_help',
            'After resolving, local-wins strategy will queue immediate write-back to server.'
          )}
        </SettingHelpText>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.current_source', 'Current Source')}</SettingRowTitle>
        <Tag>{sourceLabel(runtime.configSource)}</Tag>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.effective_server', 'Effective Server')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)', maxWidth: 360, textAlign: 'right' }}>{runtime.server || '-'}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.status_label', 'Status')}</SettingRowTitle>
        {runtimeTag}
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.connection_label', 'Connection')}</SettingRowTitle>
        <HStack gap="8px" alignItems="center">
          {connectionTag(runtime.connectionStatus, t)}
          {runtime.lastHttpStatus ? (
            <span style={{ color: 'var(--color-text-3)' }}>
              HTTP {runtime.lastHttpStatus}
            </span>
          ) : null}
        </HStack>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_checked', 'Last Checked')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)' }}>{formatTimestamp(runtime.lastCheckedAt)}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_sync', 'Last Sync')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)' }}>{formatTimestamp(runtime.lastSyncAt)}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_pull', 'Last Pull')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)' }}>{formatTimestamp(runtime.lastPullAt)}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.pull_cursor', 'Pull Cursor')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)' }}>{runtime.pullCursor}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.pending_conflicts', 'Pending Conflicts')}</SettingRowTitle>
        <Tag color={pendingConflictCount > 0 ? 'warning' : 'success'}>
          {pendingConflictCount > 0
            ? t('settings.data.topic_sync.pending_conflicts_count', '{{count}} pending', { count: pendingConflictCount })
            : t('settings.data.topic_sync.pending_conflicts_none', 'No pending conflicts')}
        </Tag>
      </SettingRow>
      {pendingConflictCount > 0 ? (
        <SettingRow>
          <SettingHelpText style={{ whiteSpace: 'pre-wrap' }}>{pendingConflictPreview}</SettingHelpText>
        </SettingRow>
      ) : null}
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_result', 'Last Result')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)', maxWidth: 420, textAlign: 'right' }}>{lastResult}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_pull_result', 'Last Pull Result')}</SettingRowTitle>
        <div style={{ color: 'var(--color-text-3)', maxWidth: 420, textAlign: 'right' }}>{lastPullResult}</div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.last_error', 'Last Error')}</SettingRowTitle>
        <div style={{ color: runtime.lastError ? 'var(--color-error)' : 'var(--color-text-3)', maxWidth: 420 }}>
          {runtime.lastError || '-'}
        </div>
      </SettingRow>
      <SettingDivider />
      <SettingRow>
        <SettingRowTitle>{t('settings.data.topic_sync.config_file', 'Config File Folder')}</SettingRowTitle>
        <HStack gap="8px">
          <Button onClick={openAppDataPath} disabled={!appDataPath}>
            {t('settings.data.app_data.open', 'Open')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={copyDebugInfo}>
            {t('settings.data.topic_sync.copy_debug', 'Copy Debug Info')}
          </Button>
        </HStack>
      </SettingRow>
      <SettingRow>
        <SettingHelpText>{appDataPath ? `${appDataPath}/cherry-sync.json` : '-'}</SettingHelpText>
      </SettingRow>
    </SettingGroup>
  )
}

export default TopicSyncSettings
