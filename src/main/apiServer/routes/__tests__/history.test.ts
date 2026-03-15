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
        getTranscript: vi.fn(),
        getMessage: vi.fn(),
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
})
