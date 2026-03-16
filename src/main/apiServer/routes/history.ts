import { loggerService } from '@logger'
import type { Request, Response } from 'express'
import express from 'express'

import {
  historyService,
  TopicDataBadRequestError,
  TopicDataNotFoundError,
  TopicDataUnavailableError
} from '../services/history'

const logger = loggerService.withContext('ApiServerHistoryRoutes')
const router = express.Router()

function parseIntegerQuery(value: unknown, field: string, options: { min?: number } = {}): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new TopicDataBadRequestError(`${field} must be an integer`)
  }

  if (options.min !== undefined && parsed < options.min) {
    throw new TopicDataBadRequestError(`${field} must be >= ${options.min}`)
  }

  return parsed
}

function parseEnumQuery<T extends string>(value: unknown, field: string, values: readonly T[]): T | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TopicDataBadRequestError(`${field} must be one of: ${values.join(', ')}`)
  }

  return value as T
}

function parseBooleanQuery(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'string') {
    throw new TopicDataBadRequestError(`${field} must be a boolean`)
  }

  if (value === 'true') {
    return true
  }

  if (value === 'false') {
    return false
  }

  throw new TopicDataBadRequestError(`${field} must be true or false`)
}

function parseStringListQuery(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  const values = Array.isArray(value) ? value : [value]
  const items = values.flatMap((entry) => {
    if (typeof entry !== 'string') {
      throw new TopicDataBadRequestError(`${field} must contain strings`)
    }

    return entry
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  })

  return items.length ? items : undefined
}

function parseTimeRangeQuery(req: Request, options: { rangeKey: string; fromKey: string; toKey: string }) {
  const rangeValue = req.query[options.rangeKey]
  if (typeof rangeValue === 'string' && rangeValue.trim()) {
    try {
      const parsed = JSON.parse(rangeValue)
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('range must be an object')
      }

      return {
        from: typeof parsed.from === 'string' ? parsed.from : undefined,
        to: typeof parsed.to === 'string' ? parsed.to : undefined
      }
    } catch {
      throw new TopicDataBadRequestError(`${options.rangeKey} must be valid JSON`)
    }
  }

  const from = typeof req.query[options.fromKey] === 'string' ? req.query[options.fromKey] : undefined
  const to = typeof req.query[options.toKey] === 'string' ? req.query[options.toKey] : undefined
  if (!from && !to) {
    return undefined
  }

  return { from, to }
}

function handleHistoryError(error: unknown, res: Response) {
  if (error instanceof TopicDataBadRequestError) {
    return res.status(400).json({
      error: {
        message: error.message,
        type: 'invalid_request_error',
        code: 'invalid_parameters'
      }
    })
  }

  if (error instanceof TopicDataNotFoundError) {
    return res.status(404).json({
      error: {
        message: error.message,
        type: 'not_found_error',
        code: 'not_found'
      }
    })
  }

  if (error instanceof TopicDataUnavailableError) {
    return res.status(503).json({
      error: {
        message: error.message,
        type: 'service_unavailable',
        code: 'renderer_unavailable'
      }
    })
  }

  logger.error('Unhandled history route error', { error })
  return res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error',
      code: 'internal_error'
    }
  })
}

/**
 * @swagger
 * /v1/history/topics:
 *   get:
 *     summary: List chat history topics
 *     description: Returns a lightweight topic catalog for local history browsing. Time range filters may be provided either as JSON range query params or as from/to pairs.
 *     tags: [History]
 *     parameters:
 *       - in: query
 *         name: topicCreatedFrom
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: topicCreatedTo
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: topicActivityFrom
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: topicActivityTo
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: assistantId
 *         schema:
 *           type: string
 *       - in: query
 *         name: keyword
 *         schema:
 *           type: string
 *       - in: query
 *         name: minMessageCount
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [createdAt, updatedAt, lastMessageAt, messageCount]
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Topic catalog
 *       400:
 *         description: Invalid query parameters
 *       503:
 *         description: Renderer is not ready
 */
router.get('/topics', async (req: Request, res: Response) => {
  try {
    const result = await historyService.listTopics({
      topicCreatedRange: parseTimeRangeQuery(req, {
        rangeKey: 'topicCreatedRange',
        fromKey: 'topicCreatedFrom',
        toKey: 'topicCreatedTo'
      }),
      topicActivityRange: parseTimeRangeQuery(req, {
        rangeKey: 'topicActivityRange',
        fromKey: 'topicActivityFrom',
        toKey: 'topicActivityTo'
      }),
      assistantId: typeof req.query.assistantId === 'string' ? req.query.assistantId : undefined,
      keyword: typeof req.query.keyword === 'string' ? req.query.keyword : undefined,
      minMessageCount: parseIntegerQuery(req.query.minMessageCount, 'minMessageCount', { min: 0 }),
      sortBy: parseEnumQuery(req.query.sortBy, 'sortBy', ['createdAt', 'updatedAt', 'lastMessageAt', 'messageCount']),
      sortOrder: parseEnumQuery(req.query.sortOrder, 'sortOrder', ['asc', 'desc']),
      offset: parseIntegerQuery(req.query.offset, 'offset', { min: 0 }),
      limit: parseIntegerQuery(req.query.limit, 'limit', { min: 1 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/topics/{topicId}:
 *   get:
 *     summary: Get topic metadata
 *     description: Returns a single topic metadata record with stable counts and timestamps.
 *     tags: [History]
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Topic metadata
 *       404:
 *         description: Topic not found
 *       503:
 *         description: Renderer is not ready
 */
router.get('/topics/:topicId', async (req: Request, res: Response) => {
  try {
    const result = await historyService.getTopicMeta(req.params.topicId)
    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/topics/{topicId}/messages:
 *   get:
 *     summary: List topic messages
 *     description: Returns lightweight message records with previews and message annotations.
 *     tags: [History]
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, assistant]
 *       - in: query
 *         name: segmentId
 *         schema:
 *           type: string
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Message list
 *       404:
 *         description: Topic not found
 */
router.get('/topics/:topicId/messages', async (req: Request, res: Response) => {
  try {
    const result = await historyService.listMessages(req.params.topicId, {
      role: parseEnumQuery(req.query.role, 'role', ['user', 'assistant']),
      segmentId: typeof req.query.segmentId === 'string' ? req.query.segmentId : undefined,
      offset: parseIntegerQuery(req.query.offset, 'offset', { min: 0 }),
      limit: parseIntegerQuery(req.query.limit, 'limit', { min: 1 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/messages:
 *   get:
 *     summary: List messages across topics
 *     description: Returns a paginated cross-topic message stream for a time window or filtered history scan.
 *     tags: [History]
 *     parameters:
 *       - in: query
 *         name: messageFrom
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: messageTo
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: assistantId
 *         schema:
 *           type: string
 *       - in: query
 *         name: topicId
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, assistant]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Cross-topic message stream
 *       400:
 *         description: Invalid query parameters
 *       503:
 *         description: Renderer is not ready
 */
router.get('/messages', async (req: Request, res: Response) => {
  try {
    const result = await historyService.listAllMessages({
      messageRange: parseTimeRangeQuery(req, {
        rangeKey: 'messageRange',
        fromKey: 'messageFrom',
        toKey: 'messageTo'
      }),
      assistantId: typeof req.query.assistantId === 'string' ? req.query.assistantId : undefined,
      topicId: typeof req.query.topicId === 'string' ? req.query.topicId : undefined,
      role: parseEnumQuery(req.query.role, 'role', ['user', 'assistant']),
      order: parseEnumQuery(req.query.order, 'order', ['asc', 'desc']),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: parseIntegerQuery(req.query.limit, 'limit', { min: 1 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/topics/{topicId}/transcript:
 *   get:
 *     summary: Get topic transcript
 *     description: Returns a paginated transcript view for a topic or a single segment.
 *     tags: [History]
 *     parameters:
 *       - in: path
 *         name: topicId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: segmentId
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, assistant, both]
 *       - in: query
 *         name: responseSelection
 *         schema:
 *           type: string
 *           enum: [all, preferred]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *       - in: query
 *         name: limitMessages
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Transcript page
 *       404:
 *         description: Topic not found
 *       503:
 *         description: Renderer is not ready
 */
router.get('/topics/:topicId/transcript', async (req: Request, res: Response) => {
  try {
    const result = await historyService.getTranscript(req.params.topicId, {
      segmentId: typeof req.query.segmentId === 'string' ? req.query.segmentId : undefined,
      role: parseEnumQuery(req.query.role, 'role', ['user', 'assistant', 'both']),
      responseSelection: parseEnumQuery(req.query.responseSelection, 'responseSelection', ['all', 'preferred']),
      order: parseEnumQuery(req.query.order, 'order', ['asc', 'desc']),
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limitMessages: parseIntegerQuery(req.query.limitMessages, 'limitMessages', { min: 1 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/messages/batch:
 *   post:
 *     summary: Batch get messages
 *     description: Returns full message records for a list of message ids while preserving input order.
 *     tags: [History]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageIds]
 *             properties:
 *               messageIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Batch message records
 *       400:
 *         description: Invalid request body
 */
router.post('/messages/batch', async (req: Request, res: Response) => {
  try {
    const messageIds = req.body?.messageIds
    if (
      !Array.isArray(messageIds) ||
      messageIds.length === 0 ||
      messageIds.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new TopicDataBadRequestError('messageIds must be a non-empty string array')
    }

    const result = await historyService.batchGetMessages(messageIds)
    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/messages/{messageId}/context:
 *   get:
 *     summary: Get message context window
 *     description: Returns the anchor message plus surrounding conversation messages from the same topic.
 *     tags: [History]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: before
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: query
 *         name: after
 *         schema:
 *           type: integer
 *           minimum: 0
 *     responses:
 *       200:
 *         description: Message context window
 *       404:
 *         description: Message not found
 */
router.get('/messages/:messageId/context', async (req: Request, res: Response) => {
  try {
    const result = await historyService.getMessageContext(req.params.messageId, {
      before: parseIntegerQuery(req.query.before, 'before', { min: 0 }),
      after: parseIntegerQuery(req.query.after, 'after', { min: 0 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/messages/{messageId}:
 *   get:
 *     summary: Get a single message
 *     description: Returns a full message record including annotations and assistant-side thinking/tool blocks when available.
 *     tags: [History]
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Message detail
 *       404:
 *         description: Message not found
 */
router.get('/messages/:messageId', async (req: Request, res: Response) => {
  try {
    const result = await historyService.getMessage(req.params.messageId)
    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

/**
 * @swagger
 * /v1/history/search/messages:
 *   get:
 *     summary: Search chat history messages
 *     description: Performs message-level search across chat history and returns hits with snippets, full mainText, createdAt, and message annotations. At least one positive search clause is required: q, phrase, allOf, or anyOf.
 *     tags: [History]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *       - in: query
 *         name: messageFrom
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: messageTo
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: assistantId
 *         schema:
 *           type: string
 *       - in: query
 *         name: topicId
 *         schema:
 *           type: string
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, assistant]
 *       - in: query
 *         name: phrase
 *         schema:
 *           type: string
 *       - in: query
 *         name: allOf
 *         description: Repeat the parameter or provide a comma-separated list to require all terms.
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *       - in: query
 *         name: anyOf
 *         description: Repeat the parameter or provide a comma-separated list to match any term.
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *       - in: query
 *         name: exclude
 *         description: Repeat the parameter or provide a comma-separated list to exclude terms.
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [createdAt, relevance]
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: deduplicate
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: deduplicateBy
 *         schema:
 *           type: string
 *           enum: [normalizedText, normalizedTextAndTimestamp]
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *     responses:
 *       200:
 *         description: Search hits
 *       400:
 *         description: Invalid query parameters
 *       503:
 *         description: Renderer is not ready
 */
router.get('/search/messages', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : ''
    const phrase = typeof req.query.phrase === 'string' ? req.query.phrase : undefined
    const allOf = parseStringListQuery(req.query.allOf, 'allOf')
    const anyOf = parseStringListQuery(req.query.anyOf, 'anyOf')
    const exclude = parseStringListQuery(req.query.exclude, 'exclude')
    if (!query.trim() && !phrase?.trim() && !allOf?.length && !anyOf?.length) {
      throw new TopicDataBadRequestError('At least one of q, phrase, allOf, or anyOf is required')
    }

    const result = await historyService.searchMessages(query, {
      messageRange: parseTimeRangeQuery(req, {
        rangeKey: 'messageRange',
        fromKey: 'messageFrom',
        toKey: 'messageTo'
      }),
      assistantId: typeof req.query.assistantId === 'string' ? req.query.assistantId : undefined,
      topicId: typeof req.query.topicId === 'string' ? req.query.topicId : undefined,
      role: parseEnumQuery(req.query.role, 'role', ['user', 'assistant']),
      phrase,
      allOf,
      anyOf,
      exclude,
      sort: parseEnumQuery(req.query.sort, 'sort', ['createdAt', 'relevance']),
      order: parseEnumQuery(req.query.order, 'order', ['asc', 'desc']),
      deduplicate: parseBooleanQuery(req.query.deduplicate, 'deduplicate'),
      deduplicateBy: parseEnumQuery(req.query.deduplicateBy, 'deduplicateBy', [
        'normalizedText',
        'normalizedTextAndTimestamp'
      ]),
      offset: parseIntegerQuery(req.query.offset, 'offset', { min: 0 }),
      limit: parseIntegerQuery(req.query.limit, 'limit', { min: 1 })
    })

    return res.json(result)
  } catch (error) {
    return handleHistoryError(error, res)
  }
})

export { router as historyRoutes }
