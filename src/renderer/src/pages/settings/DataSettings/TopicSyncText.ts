export type TopicSyncLocale = 'en-US' | 'zh-CN' | 'zh-TW'

export interface TopicSyncText {
  title: string
  save: string
  precedence: string
  progress: string
  advanced: string
  failedReasons: string
  tokenPlaceholder: string
  sections: {
    connection: string
    strategy: string
    operations: string
    status: string
  }
  fields: {
    status: string
    connection: string
    lastSync: string
    lastPull: string
    pullCursor: string
    currentSource: string
    interval: string
    effectiveServer: string
    server: string
    token: string
    actions: string
    mode: string
    conflictPolicy: string
    syncNow: string
    lastChecked: string
    lastResult: string
    lastPullResult: string
    failedItems: string
    pendingConflicts: string
    lastError: string
    copyDebug: string
  }
  actions: {
    checkConnection: string
    clear: string
    retryFailed: string
    dismiss: string
    rebuildBaseline: string
    resolveLocal: string
    resolveServer: string
    syncNow: string
    fullPush: string
    fullPushPrune: string
    pullPreview: string
    pullApply: string
  }
  connection: {
    online: string
    unauthorized: string
    offline: string
    unknown: string
  }
  status: {
    running: string
    ready: string
    notConfigured: string
  }
  mode: {
    pushOnly: string
    manualPull: string
    autoSafe: string
    autoFull: string
  }
  modeHelp: {
    pushOnly: string
    manualPull: string
    autoSafe: string
    autoFull: string
  }
  conflictPolicy: {
    localWins: string
    serverWins: string
  }
  help: {
    pull: string
  }
  toasts: {
    saved: string
    cleared: string
    triggered: string
    checking: string
    modeUpdated: string
    intervalUpdated: string
    conflictPolicyUpdated: string
    pullPreviewTriggered: string
    pullApplyTriggered: string
    resolveLocalTriggered: string
    resolveServerTriggered: string
    retryFailedTriggered: string
    dismissErrors: string
    rebuildBaselineDone: string
    copied: string
    copyFailed: string
  }
  modals: {
    fullPush: {
      title: string
      content: string
      confirm: string
      triggered: string
    }
    fullPushPrune: {
      title: string
      content: string
      confirm: string
      triggered: string
    }
    rebuildBaseline: {
      title: string
      content: string
      confirm: string
    }
  }
  source: {
    settings: string
    none: string
  }
  progressPhase: {
    idle: string
    pull: string
    push: string
    delete: string
  }
  units: {
    secondsShort: string
    minutesShort: string
  }
  diagnostics: {
    total: string
    safe: string
    conflicts: string
    applied: string
    cursor: string
    blockedSeq: string
    skipped: string
    resolve: string
    local: string
    server: string
    writeBack: string
    noop: string
    stale: string
    failed: string
  }
  failedItemsCount: (count: number) => string
  pendingConflictsMessage: (count: number) => string
  pendingConflictsCount: (count: number) => string
  failedInline: (count: number) => string
  failedItemsNone: string
  pendingConflictsNone: string
}

const EN_US: TopicSyncText = {
  title: 'Topic Sync',
  save: 'Save',
  precedence: 'Topic Sync settings are managed here and take effect immediately after saving.',
  progress: 'Progress',
  advanced: 'Advanced Diagnostics',
  failedReasons: 'Top failure reasons',
  tokenPlaceholder: 'Optional',
  sections: {
    connection: 'Connection',
    strategy: 'Sync Strategy',
    operations: 'Sync Operations',
    status: 'Status Overview'
  },
  fields: {
    status: 'Status',
    connection: 'Connection',
    lastSync: 'Last Sync',
    lastPull: 'Last Pull',
    pullCursor: 'Pull Cursor',
    currentSource: 'Current Source',
    interval: 'Sync Interval',
    effectiveServer: 'Effective Server',
    server: 'Sync Server',
    token: 'Sync Token',
    actions: 'Actions',
    mode: 'Sync Mode',
    conflictPolicy: 'Conflict Policy',
    syncNow: 'Sync Now',
    lastChecked: 'Last Checked',
    lastResult: 'Last Result',
    lastPullResult: 'Last Pull Result',
    failedItems: 'Failed Items',
    pendingConflicts: 'Pending Conflicts',
    lastError: 'Last Error',
    copyDebug: 'Copy Debug Info'
  },
  actions: {
    checkConnection: 'Check Connection',
    clear: 'Clear Local Override',
    retryFailed: 'Retry Failed',
    dismiss: 'Dismiss',
    rebuildBaseline: 'Rebuild Baseline',
    resolveLocal: 'Resolve Local Wins',
    resolveServer: 'Resolve Server Wins',
    syncNow: 'Sync Now',
    fullPush: 'Full Push',
    fullPushPrune: 'Full Push + Prune',
    pullPreview: 'Preview Pull',
    pullApply: 'Apply Safe Pull'
  },
  connection: {
    online: 'Online',
    unauthorized: 'Unauthorized',
    offline: 'Offline',
    unknown: 'Unknown'
  },
  status: {
    running: 'Running',
    ready: 'Ready',
    notConfigured: 'Not Configured'
  },
  mode: {
    pushOnly: 'Push Only',
    manualPull: 'Manual Pull',
    autoSafe: 'Auto Safe Pull',
    autoFull: 'Auto Full (Pull + Push)'
  },
  modeHelp: {
    pushOnly: 'Only push local updates to server. Use this when one device is source of truth.',
    manualPull: 'Push remains automatic, server pull is manual (preview/apply/resolve by buttons).',
    autoSafe: 'Auto-pull only conflict-free server changes, pause at first conflict for manual handling.',
    autoFull: 'Auto pull and push. Conflicts are resolved by policy, then local changes can be written back.'
  },
  conflictPolicy: {
    localWins: 'Local Wins',
    serverWins: 'Server Wins'
  },
  help: {
    pull: 'Preview analyzes server changes only. Apply Safe Pull writes non-conflicting changes and pauses at first conflict.'
  },
  toasts: {
    saved: 'Sync settings saved. Changes take effect on the next sync cycle.',
    cleared: 'Local overrides cleared.',
    triggered: 'Manual sync triggered.',
    checking: 'Checking connection...',
    modeUpdated: 'Sync mode updated.',
    intervalUpdated: 'Sync interval updated.',
    conflictPolicyUpdated: 'Conflict policy updated.',
    pullPreviewTriggered: 'Pull preview started.',
    pullApplyTriggered: 'Safe pull apply started.',
    resolveLocalTriggered: 'Resolving conflicts with local wins and writing back...',
    resolveServerTriggered: 'Resolving conflicts with server wins...',
    retryFailedTriggered: 'Retrying failed sync actions...',
    dismissErrors: 'Sync errors cleared.',
    rebuildBaselineDone: 'Sync baseline rebuilt.',
    copied: 'Sync debug info copied.',
    copyFailed: 'Failed to copy debug info.'
  },
  modals: {
    fullPush: {
      title: 'Force Full Push to Server?',
      content: 'This will clear the local sync baseline and force-upload all current local topics to the server.',
      confirm: 'Full Push',
      triggered: 'Full push triggered. Uploading all local topics...'
    },
    fullPushPrune: {
      title: 'Force Full Push and Prune Remote Data?',
      content:
        'This will force-upload all current local topics and delete topics that exist on the server but not in local data. This action is destructive for remote data.',
      confirm: 'Full Push + Prune',
      triggered: 'Full push + prune triggered. Uploading local topics and pruning remote extras...'
    },
    rebuildBaseline: {
      title: 'Rebuild Local Sync Baseline?',
      content: 'This marks current local topics as already synced and clears the current failed queue.',
      confirm: 'Rebuild'
    }
  },
  source: {
    settings: 'Settings',
    none: 'None'
  },
  progressPhase: {
    idle: 'Idle',
    pull: 'Pull',
    push: 'Push',
    delete: 'Delete'
  },
  units: {
    secondsShort: 's',
    minutesShort: 'm'
  },
  diagnostics: {
    total: 'total',
    safe: 'safe',
    conflicts: 'conflicts',
    applied: 'applied',
    cursor: 'cursor',
    blockedSeq: 'blockedSeq',
    skipped: 'skipped',
    resolve: 'resolve',
    local: 'local',
    server: 'server',
    writeBack: 'writeBack',
    noop: 'noop',
    stale: 'stale',
    failed: 'failed'
  },
  failedItemsCount: (count) => `${count} failed`,
  pendingConflictsMessage: (count) => `${count} pending conflicts`,
  pendingConflictsCount: (count) => `${count} pending`,
  failedInline: (count) => `failed=${count}`,
  failedItemsNone: 'No failed items',
  pendingConflictsNone: 'No pending conflicts'
}

const ZH_CN: TopicSyncText = {
  title: 'Topic 同步',
  save: '保存',
  precedence: 'Topic Sync 设置仅在此页面维护，保存后立即生效。',
  progress: '进度',
  advanced: '高级诊断',
  failedReasons: '主要失败原因',
  tokenPlaceholder: '可选',
  sections: {
    connection: '连接配置',
    strategy: '同步策略',
    operations: '同步操作',
    status: '状态总览'
  },
  fields: {
    status: '运行状态',
    connection: '连接状态',
    lastSync: '上次同步',
    lastPull: '上次拉取',
    pullCursor: '拉取游标',
    currentSource: '当前配置来源',
    interval: '同步间隔',
    effectiveServer: '生效服务器',
    server: '同步服务器',
    token: '同步令牌',
    actions: '操作',
    mode: '同步模式',
    conflictPolicy: '冲突策略',
    syncNow: '立即同步',
    lastChecked: '上次检查',
    lastResult: '最近同步结果',
    lastPullResult: '最近拉取结果',
    failedItems: '失败条目',
    pendingConflicts: '待处理冲突',
    lastError: '最近错误',
    copyDebug: '复制调试信息'
  },
  actions: {
    checkConnection: '检测连接',
    clear: '清空本地覆盖',
    retryFailed: '重试失败项',
    dismiss: '忽略',
    rebuildBaseline: '重建基线',
    resolveLocal: '本地优先解决',
    resolveServer: '服务器优先解决',
    syncNow: '立即同步',
    fullPush: '全量推送',
    fullPushPrune: '全量推送并清理远端',
    pullPreview: '预览拉取',
    pullApply: '应用安全拉取'
  },
  connection: {
    online: '在线',
    unauthorized: '鉴权失败',
    offline: '离线',
    unknown: '未知'
  },
  status: {
    running: '运行中',
    ready: '就绪',
    notConfigured: '未配置'
  },
  mode: {
    pushOnly: '仅推送',
    manualPull: '手动拉取',
    autoSafe: '自动安全拉取',
    autoFull: '全自动（拉取 + 推送）'
  },
  modeHelp: {
    pushOnly: '仅将本地更新推送到服务器，适合单设备主写场景。',
    manualPull: '推送仍自动执行，服务器拉取改为手动预览、应用和解决冲突。',
    autoSafe: '自动拉取仅应用无冲突变更，遇到首个冲突会暂停等待处理。',
    autoFull: '自动拉取并推送，冲突按策略处理，必要时会把本地结果回写到服务器。'
  },
  conflictPolicy: {
    localWins: '本地优先',
    serverWins: '服务器优先'
  },
  help: {
    pull: '预览仅分析服务器增量。应用安全拉取只会写入无冲突变更，遇到第一处冲突即暂停。'
  },
  toasts: {
    saved: '同步配置已保存，将在下一次同步周期生效。',
    cleared: '本地覆盖配置已清空。',
    triggered: '已触发手动同步。',
    checking: '正在检测连接...',
    modeUpdated: '同步模式已更新。',
    intervalUpdated: '同步间隔已更新。',
    conflictPolicyUpdated: '冲突策略已更新。',
    pullPreviewTriggered: '已开始拉取预览。',
    pullApplyTriggered: '已开始应用安全拉取。',
    resolveLocalTriggered: '正在按本地优先解决冲突并回写服务器...',
    resolveServerTriggered: '正在按服务器优先解决冲突...',
    retryFailedTriggered: '正在重试失败的同步操作...',
    dismissErrors: '同步错误已清空。',
    rebuildBaselineDone: '同步基线已重建。',
    copied: '同步调试信息已复制。',
    copyFailed: '复制同步调试信息失败。'
  },
  modals: {
    fullPush: {
      title: '是否强制全量推送到服务器？',
      content: '会清空本地同步基线，并将当前所有本地 Topic 强制全量上传到服务器。',
      confirm: '全量推送',
      triggered: '已触发全量推送。正在上传所有本地 Topic...'
    },
    fullPushPrune: {
      title: '是否强制全量推送并清理远端数据？',
      content:
        '会将当前所有本地 Topic 强制全量上传到服务器，并删除服务器上存在但本地不存在的 Topic。此操作会破坏远端数据。',
      confirm: '全量推送并清理',
      triggered: '已触发全量推送并清理。正在上传本地 Topic 并清理远端多余数据...'
    },
    rebuildBaseline: {
      title: '是否重建本地同步基线？',
      content: '会将当前本地 Topic 视为已同步，同时清空当前失败队列。',
      confirm: '重建'
    }
  },
  source: {
    settings: '设置',
    none: '无'
  },
  progressPhase: {
    idle: '空闲',
    pull: '拉取',
    push: '推送',
    delete: '删除'
  },
  units: {
    secondsShort: '秒',
    minutesShort: '分'
  },
  diagnostics: {
    total: '总数',
    safe: '安全',
    conflicts: '冲突',
    applied: '已应用',
    cursor: '游标',
    blockedSeq: '阻塞序号',
    skipped: '跳过',
    resolve: '解决',
    local: '本地',
    server: '服务器',
    writeBack: '回写',
    noop: '无操作',
    stale: '过期',
    failed: '失败'
  },
  failedItemsCount: (count) => `${count} 条失败`,
  pendingConflictsMessage: (count) => `${count} 条待处理冲突`,
  pendingConflictsCount: (count) => `共 ${count} 条`,
  failedInline: (count) => `失败=${count}`,
  failedItemsNone: '无失败条目',
  pendingConflictsNone: '无待处理冲突'
}

const ZH_TW: TopicSyncText = {
  title: 'Topic 同步',
  save: '儲存',
  precedence: 'Topic Sync 設定僅在此頁面維護，儲存後立即生效。',
  progress: '進度',
  advanced: '進階診斷',
  failedReasons: '主要失敗原因',
  tokenPlaceholder: '可選',
  sections: {
    connection: '連線設定',
    strategy: '同步策略',
    operations: '同步操作',
    status: '狀態總覽'
  },
  fields: {
    status: '執行狀態',
    connection: '連線狀態',
    lastSync: '上次同步',
    lastPull: '上次拉取',
    pullCursor: '拉取游標',
    currentSource: '目前設定來源',
    interval: '同步間隔',
    effectiveServer: '生效伺服器',
    server: '同步伺服器',
    token: '同步權杖',
    actions: '操作',
    mode: '同步模式',
    conflictPolicy: '衝突策略',
    syncNow: '立即同步',
    lastChecked: '上次檢查',
    lastResult: '最近同步結果',
    lastPullResult: '最近拉取結果',
    failedItems: '失敗項目',
    pendingConflicts: '待處理衝突',
    lastError: '最近錯誤',
    copyDebug: '複製除錯資訊'
  },
  actions: {
    checkConnection: '檢查連線',
    clear: '清除本機覆蓋',
    retryFailed: '重試失敗項目',
    dismiss: '忽略',
    rebuildBaseline: '重建基線',
    resolveLocal: '本機優先解決',
    resolveServer: '伺服器優先解決',
    syncNow: '立即同步',
    fullPush: '全量推送',
    fullPushPrune: '全量推送並清理遠端',
    pullPreview: '預覽拉取',
    pullApply: '套用安全拉取'
  },
  connection: {
    online: '在線',
    unauthorized: '授權失敗',
    offline: '離線',
    unknown: '未知'
  },
  status: {
    running: '執行中',
    ready: '就緒',
    notConfigured: '未設定'
  },
  mode: {
    pushOnly: '僅推送',
    manualPull: '手動拉取',
    autoSafe: '自動安全拉取',
    autoFull: '全自動（拉取 + 推送）'
  },
  modeHelp: {
    pushOnly: '僅將本機更新推送到伺服器，適合單裝置主寫情境。',
    manualPull: '推送仍自動執行，伺服器拉取改為手動預覽、套用與解決衝突。',
    autoSafe: '自動拉取僅套用無衝突變更，遇到第一個衝突會暫停等待處理。',
    autoFull: '自動拉取並推送，衝突依策略處理，必要時會把本機結果回寫到伺服器。'
  },
  conflictPolicy: {
    localWins: '本機優先',
    serverWins: '伺服器優先'
  },
  help: {
    pull: '預覽僅分析伺服器增量。套用安全拉取只會寫入無衝突變更，遇到第一個衝突即暫停。'
  },
  toasts: {
    saved: '同步設定已儲存，將於下一次同步週期生效。',
    cleared: '本機覆蓋設定已清空。',
    triggered: '已觸發手動同步。',
    checking: '正在檢查連線...',
    modeUpdated: '同步模式已更新。',
    intervalUpdated: '同步間隔已更新。',
    conflictPolicyUpdated: '衝突策略已更新。',
    pullPreviewTriggered: '已開始拉取預覽。',
    pullApplyTriggered: '已開始套用安全拉取。',
    resolveLocalTriggered: '正在按本機優先解決衝突並回寫伺服器...',
    resolveServerTriggered: '正在按伺服器優先解決衝突...',
    retryFailedTriggered: '正在重試失敗的同步操作...',
    dismissErrors: '同步錯誤已清空。',
    rebuildBaselineDone: '同步基線已重建。',
    copied: '同步除錯資訊已複製。',
    copyFailed: '複製同步除錯資訊失敗。'
  },
  modals: {
    fullPush: {
      title: '是否強制全量推送到伺服器？',
      content: '會清空本機同步基線，並將目前所有本機 Topic 強制全量上傳到伺服器。',
      confirm: '全量推送',
      triggered: '已觸發全量推送。正在上傳所有本機 Topic...'
    },
    fullPushPrune: {
      title: '是否強制全量推送並清理遠端資料？',
      content:
        '會將目前所有本機 Topic 強制全量上傳到伺服器，並刪除伺服器上存在但本機不存在的 Topic。此操作會破壞遠端資料。',
      confirm: '全量推送並清理',
      triggered: '已觸發全量推送並清理。正在上傳本機 Topic 並清理遠端多餘資料...'
    },
    rebuildBaseline: {
      title: '是否重建本機同步基線？',
      content: '會將目前本機 Topic 視為已同步，同時清空目前失敗佇列。',
      confirm: '重建'
    }
  },
  source: {
    settings: '設定',
    none: '無'
  },
  progressPhase: {
    idle: '閒置',
    pull: '拉取',
    push: '推送',
    delete: '刪除'
  },
  units: {
    secondsShort: '秒',
    minutesShort: '分'
  },
  diagnostics: {
    total: '總數',
    safe: '安全',
    conflicts: '衝突',
    applied: '已套用',
    cursor: '游標',
    blockedSeq: '阻塞序號',
    skipped: '跳過',
    resolve: '解決',
    local: '本機',
    server: '伺服器',
    writeBack: '回寫',
    noop: '無操作',
    stale: '過期',
    failed: '失敗'
  },
  failedItemsCount: (count) => `${count} 筆失敗`,
  pendingConflictsMessage: (count) => `${count} 筆待處理衝突`,
  pendingConflictsCount: (count) => `共 ${count} 筆`,
  failedInline: (count) => `失敗=${count}`,
  failedItemsNone: '無失敗項目',
  pendingConflictsNone: '無待處理衝突'
}

const TOPIC_SYNC_TEXT: Record<TopicSyncLocale, TopicSyncText> = {
  'en-US': EN_US,
  'zh-CN': ZH_CN,
  'zh-TW': ZH_TW
}

export function resolveTopicSyncLocale(language?: string | null): TopicSyncLocale {
  const normalized = (language || '').toLowerCase()
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-mo')) {
    return 'zh-TW'
  }
  if (normalized.startsWith('zh')) return 'zh-CN'
  return 'en-US'
}

export function getTopicSyncText(language?: string | null): TopicSyncText {
  return TOPIC_SYNC_TEXT[resolveTopicSyncLocale(language)]
}
