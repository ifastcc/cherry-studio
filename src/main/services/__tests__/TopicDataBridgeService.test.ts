import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeJavaScript, getMainWindow, select } = vi.hoisted(() => ({
  executeJavaScript: vi.fn(),
  getMainWindow: vi.fn(),
  select: vi.fn()
}))

vi.mock('../ReduxService', () => ({
  reduxService: {
    select
  }
}))

vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow
  }
}))

import { topicDataBridgeService, TopicDataNotFoundError, TopicDataUnavailableError } from '../TopicDataBridgeService'

describe('TopicDataBridgeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    select.mockResolvedValue(true)
    executeJavaScript.mockResolvedValue({ ok: true, data: { topics: [], total: 0 } })
    getMainWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript
      }
    })
  })

  it('invokes renderer topic data service methods through executeJavaScript', async () => {
    const result = await topicDataBridgeService.listTopics({ limit: 5 })

    expect(result).toEqual({ topics: [], total: 0 })
    expect(select).toHaveBeenCalledWith('true')
    expect(executeJavaScript).toHaveBeenCalledTimes(1)
    expect(executeJavaScript.mock.calls[0][0]).toContain('"listTopics"')
    expect(executeJavaScript.mock.calls[0][0]).toContain('"limit":5')
  })

  it('maps renderer not found errors to TopicDataNotFoundError', async () => {
    executeJavaScript.mockResolvedValue({
      ok: false,
      error: 'NOT_FOUND: Topic not found: topic-404'
    })

    await expect(topicDataBridgeService.getTopicMeta('topic-404')).rejects.toBeInstanceOf(TopicDataNotFoundError)
  })

  it('passes batch message lookups through executeJavaScript', async () => {
    executeJavaScript.mockResolvedValue({
      ok: true,
      data: {
        messages: [],
        missingMessageIds: ['missing-1']
      }
    })

    const result = await topicDataBridgeService.batchGetMessages(['m1', 'missing-1'])

    expect(result).toEqual({
      messages: [],
      missingMessageIds: ['missing-1']
    })
    expect(executeJavaScript.mock.calls[0][0]).toContain('"batchGetMessages"')
    expect(executeJavaScript.mock.calls[0][0]).toContain('["m1","missing-1"]')
  })

  it('returns TopicDataUnavailableError when renderer window is missing', async () => {
    getMainWindow.mockReturnValue(null)

    await expect(topicDataBridgeService.listTopics()).rejects.toBeInstanceOf(TopicDataUnavailableError)
  })
})
