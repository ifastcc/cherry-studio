import type { AddressInfo } from 'node:net'

import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { historyService, TopicDataBadRequestError, TopicDataNotFoundError, TopicDataUnavailableError } = vi.hoisted(
  () => {
    class HoistedTopicDataBadRequestError extends Error {}
    class HoistedTopicDataNotFoundError extends Error {}
    class HoistedTopicDataUnavailableError extends Error {}

    return {
      historyService: {
        listTopics: vi.fn(),
        getTopicMeta: vi.fn(),
        listMessages: vi.fn(),
        listAllMessages: vi.fn(),
        getTranscript: vi.fn(),
        getMessage: vi.fn(),
        getMessageContext: vi.fn(),
        batchGetMessages: vi.fn(),
        searchMessages: vi.fn()
      },
      TopicDataBadRequestError: HoistedTopicDataBadRequestError,
      TopicDataNotFoundError: HoistedTopicDataNotFoundError,
      TopicDataUnavailableError: HoistedTopicDataUnavailableError
    }
  }
)

vi.mock('../../services/history', () => ({
  historyService,
  TopicDataBadRequestError,
  TopicDataNotFoundError,
  TopicDataUnavailableError
}))

import { historyRoutes } from '../history'

describe('historyRoutes', () => {
  let app: express.Express
  let server: ReturnType<express.Express['listen']>
  let baseUrl: string

  beforeEach(async () => {
    vi.clearAllMocks()
    app = express()
    app.use('/v1/history', historyRoutes)
    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  })

  it('returns 400 for invalid numeric query params', async () => {
    const response = await fetch(`${baseUrl}/v1/history/topics?limit=oops`)
    expect(response.status).toBe(400)

    const payload = await response.json()
    expect(payload.error.code).toBe('invalid_parameters')
  })

  it('returns 404 for missing topics', async () => {
    historyService.getTopicMeta.mockRejectedValue(new TopicDataNotFoundError('Topic not found: topic-404'))

    const response = await fetch(`${baseUrl}/v1/history/topics/topic-404`)
    expect(response.status).toBe(404)

    const payload = await response.json()
    expect(payload.error.code).toBe('not_found')
  })

  it('returns 503 when renderer bridge is unavailable', async () => {
    historyService.searchMessages.mockRejectedValue(new TopicDataUnavailableError('Renderer window is not ready'))

    const response = await fetch(`${baseUrl}/v1/history/search/messages?q=architecture`)
    expect(response.status).toBe(503)

    const payload = await response.json()
    expect(payload.error.code).toBe('renderer_unavailable')
  })

  it('parses structured search queries with deduplication and sort controls', async () => {
    historyService.searchMessages.mockResolvedValue({
      returnMode: 'query',
      hits: [],
      total: 0,
      matchedMessageCount: 0,
      query: ''
    })

    const response = await fetch(
      `${baseUrl}/v1/history/search/messages?anyOf=气感,养气&exclude=天气&sort=relevance&order=desc&deduplicate=true&deduplicateBy=normalizedText`
    )

    expect(response.status).toBe(200)
    expect(historyService.searchMessages).toHaveBeenCalledWith('', {
      messageRange: undefined,
      assistantId: undefined,
      topicId: undefined,
      role: undefined,
      phrase: undefined,
      allOf: undefined,
      anyOf: ['气感', '养气'],
      exclude: ['天气'],
      sort: 'relevance',
      order: 'desc',
      deduplicate: true,
      deduplicateBy: 'normalizedText',
      returnMode: undefined,
      offset: undefined,
      limit: undefined
    })
  })

  it('parses grouped search return modes', async () => {
    historyService.searchMessages.mockResolvedValue({
      returnMode: 'round',
      groups: [],
      total: 0,
      matchedMessageCount: 0,
      query: 'architecture'
    })

    const response = await fetch(`${baseUrl}/v1/history/search/messages?q=architecture&returnMode=round&limit=5`)

    expect(response.status).toBe(200)
    expect(historyService.searchMessages).toHaveBeenCalledWith('architecture', {
      messageRange: undefined,
      assistantId: undefined,
      topicId: undefined,
      role: undefined,
      phrase: undefined,
      allOf: undefined,
      anyOf: undefined,
      exclude: undefined,
      sort: undefined,
      order: undefined,
      deduplicate: undefined,
      deduplicateBy: undefined,
      returnMode: 'round',
      offset: undefined,
      limit: 5
    })
  })

  it('parses cross-topic message timeline queries', async () => {
    historyService.listAllMessages.mockResolvedValue({
      messages: [],
      pageInfo: {
        hasMore: false,
        returnedMessages: 0,
        totalMessages: 0
      }
    })

    const response = await fetch(
      `${baseUrl}/v1/history/messages?messageFrom=2026-03-10T00:00:00.000Z&order=asc&limit=10`
    )

    expect(response.status).toBe(200)
    expect(historyService.listAllMessages).toHaveBeenCalledWith({
      messageRange: {
        from: '2026-03-10T00:00:00.000Z',
        to: undefined
      },
      assistantId: undefined,
      topicId: undefined,
      role: undefined,
      order: 'asc',
      cursor: undefined,
      limit: 10
    })
  })

  it('returns 400 for invalid batch message requests', async () => {
    const response = await fetch(`${baseUrl}/v1/history/messages/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messageIds: ['ok', ''] })
    })

    expect(response.status).toBe(400)

    const payload = await response.json()
    expect(payload.error.code).toBe('invalid_parameters')
  })

  it('returns 400 when search omits every positive query clause', async () => {
    const response = await fetch(`${baseUrl}/v1/history/search/messages?exclude=天气`)

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error.code).toBe('invalid_parameters')
  })

  it('returns 400 for invalid grouped search modes', async () => {
    const response = await fetch(`${baseUrl}/v1/history/search/messages?q=architecture&returnMode=all`)

    expect(response.status).toBe(400)
    const payload = await response.json()
    expect(payload.error.code).toBe('invalid_parameters')
  })
})
