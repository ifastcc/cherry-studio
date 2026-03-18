import type { Topic } from '@renderer/types'
import { MessageBlockType } from '@renderer/types/newMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDb, mockStore } = vi.hoisted(() => ({
  mockDb: {
    topics: {
      get: vi.fn(),
      bulkGet: vi.fn()
    },
    message_blocks: {
      bulkGet: vi.fn()
    }
  },
  mockStore: {
    getState: vi.fn()
  }
}))

vi.mock('@renderer/databases', () => ({
  __esModule: true,
  default: mockDb
}))

vi.mock('@renderer/store', () => ({
  __esModule: true,
  default: mockStore
}))

vi.mock('@renderer/services/db/types', () => ({
  isAgentSessionTopicId: vi.fn(() => false)
}))

import { topicDataService } from '../TopicDataService'

const topic: Topic = {
  id: 'topic-1',
  name: 'Architecture Review',
  assistantId: 'assistant-1',
  createdAt: '2026-03-10T08:00:00.000Z',
  updatedAt: '2026-03-12T11:30:00.000Z'
} as Topic

const topicTwo: Topic = {
  id: 'topic-2',
  name: 'Architecture Notes',
  assistantId: 'assistant-1',
  createdAt: '2026-03-12T12:00:00.000Z',
  updatedAt: '2026-03-12T12:30:00.000Z'
} as Topic

const messages = [
  {
    id: 'u1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: topic.id,
    createdAt: '2026-03-10T08:01:00.000Z',
    status: 'success',
    blocks: ['b-u1']
  },
  {
    id: 'a1',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: topic.id,
    askId: 'u1',
    createdAt: '2026-03-10T08:02:00.000Z',
    status: 'success',
    modelId: 'gpt-5',
    blocks: ['b-a1']
  },
  {
    id: 'a2',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: topic.id,
    askId: 'u1',
    createdAt: '2026-03-10T08:03:00.000Z',
    status: 'success',
    modelId: 'gpt-5',
    blocks: ['b-a2', 'b-a2-thinking']
  },
  {
    id: 'clear-1',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: topic.id,
    type: 'clear',
    createdAt: '2026-03-11T08:00:00.000Z',
    status: 'success',
    blocks: []
  },
  {
    id: 'a-orphan',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: topic.id,
    createdAt: '2026-03-11T08:01:00.000Z',
    status: 'success',
    modelId: 'gpt-5',
    blocks: ['b-a-orphan']
  },
  {
    id: 'u2',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: topic.id,
    createdAt: '2026-03-12T11:00:00.000Z',
    status: 'success',
    blocks: ['b-u2']
  },
  {
    id: 'a3',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: topic.id,
    askId: 'u2',
    useful: true,
    createdAt: '2026-03-12T11:05:00.000Z',
    status: 'success',
    modelId: 'gpt-5',
    blocks: ['b-a3']
  }
] as any[]

const messagesTwo = [
  {
    id: 'u3',
    role: 'user',
    assistantId: 'assistant-1',
    topicId: topicTwo.id,
    createdAt: '2026-03-12T12:01:00.000Z',
    status: 'success',
    blocks: ['b-u3']
  },
  {
    id: 'a4',
    role: 'assistant',
    assistantId: 'assistant-1',
    topicId: topicTwo.id,
    askId: 'u3',
    createdAt: '2026-03-12T12:02:00.000Z',
    status: 'success',
    modelId: 'gpt-5',
    blocks: ['b-a4']
  }
] as any[]

const blocks = new Map(
  [
    ['b-u1', 'Help me review the architecture'],
    ['b-a1', 'Initial reply'],
    ['b-a2', 'Preferred reply'],
    ['b-a-orphan', 'Detached follow-up note'],
    ['b-u2', 'Check the deployment risks'],
    ['b-a3', 'Final follow-up reply'],
    ['b-u3', 'Check the deployment risks again'],
    ['b-a4', 'Final follow-up reply']
  ].map(([id, content]) => [
    id,
    {
      id,
      messageId: id.replace('b-', ''),
      type: MessageBlockType.MAIN_TEXT,
      content,
      createdAt: '2026-03-10T08:00:00.000Z',
      status: 'success'
    }
  ])
)

blocks.set('b-a2-thinking', {
  id: 'b-a2-thinking',
  messageId: 'a2',
  type: MessageBlockType.THINKING,
  content: 'Reasoning',
  createdAt: '2026-03-10T08:00:00.000Z',
  status: 'success'
} as any)

describe('TopicDataService', () => {
  beforeEach(() => {
    mockStore.getState.mockReturnValue({
      assistants: {
        assistants: [
          {
            id: 'assistant-1',
            name: 'Architect',
            topics: [topic, topicTwo]
          }
        ]
      }
    })

    mockDb.topics.get.mockImplementation(async (topicId: string) => {
      if (topicId === topic.id) {
        return { id: topic.id, messages }
      }
      if (topicId === topicTwo.id) {
        return { id: topicTwo.id, messages: messagesTwo }
      }
      return undefined
    })

    mockDb.topics.bulkGet.mockImplementation(async (topicIds: string[]) =>
      topicIds.map((topicId) => {
        if (topicId === topic.id) {
          return { id: topic.id, messages }
        }
        if (topicId === topicTwo.id) {
          return { id: topicTwo.id, messages: messagesTwo }
        }
        return undefined
      })
    )

    mockDb.message_blocks.bulkGet.mockImplementation(async (blockIds: string[]) =>
      blockIds.map((blockId) => blocks.get(blockId))
    )

    vi.clearAllMocks()
  })

  it('excludes clear messages from topic counts and timestamps', async () => {
    const result = await topicDataService.listTopics()
    expect(result.total).toBe(2)
    const architectureReview = result.topics.find((entry) => entry.topicId === topic.id)
    expect(architectureReview).toMatchObject({
      topicId: topic.id,
      messageCount: 6,
      roundCount: 2,
      segmentCount: 2,
      firstMessageAt: '2026-03-10T08:01:00.000Z',
      lastMessageAt: '2026-03-12T11:05:00.000Z',
      preview: 'Help me review the architecture'
    })
  })

  it('keeps stable segment and round annotations on list responses', async () => {
    const result = await topicDataService.listMessages(topic.id, { segmentId: 'after:clear-1' })
    expect(result.total).toBe(3)
    expect(result.messages).toEqual([
      expect.objectContaining({
        messageId: 'a-orphan',
        annotations: {
          segmentId: 'after:clear-1',
          segmentIndex: 1,
          roundId: undefined,
          roundIndex: undefined,
          isPreferredResponse: false
        }
      }),
      expect.objectContaining({
        messageId: 'u2',
        annotations: {
          segmentId: 'after:clear-1',
          segmentIndex: 1,
          roundId: 'u2',
          roundIndex: 1
        }
      }),
      expect.objectContaining({
        messageId: 'a3',
        annotations: {
          segmentId: 'after:clear-1',
          segmentIndex: 1,
          roundId: 'u2',
          roundIndex: 1,
          isPreferredResponse: true
        }
      })
    ])
  })

  it('paginates transcript with cursor while preserving preferred selection rules', async () => {
    const firstPage = await topicDataService.getTranscript(topic.id, {
      segmentId: 'after:clear-1',
      responseSelection: 'preferred',
      limitMessages: 2
    })

    expect(firstPage.messages.map((message) => message.messageId)).toEqual(['a-orphan', 'u2'])
    expect(firstPage.pageInfo).toEqual({
      hasMore: true,
      nextCursor: 'u2',
      returnedMessages: 2,
      totalMessages: 3
    })

    const secondPage = await topicDataService.getTranscript(topic.id, {
      segmentId: 'after:clear-1',
      responseSelection: 'preferred',
      cursor: firstPage.pageInfo.nextCursor,
      limitMessages: 2
    })

    expect(secondPage.messages.map((message) => message.messageId)).toEqual(['a3'])
    expect(secondPage.pageInfo.hasMore).toBe(false)
  })

  it('marks fallback preferred responses in annotations when no useful reply exists', async () => {
    const transcript = await topicDataService.getTranscript(topic.id, {
      segmentId: '__initial__',
      responseSelection: 'preferred',
      limitMessages: 10
    })

    expect(transcript.messages.map((message) => message.messageId)).toEqual(['u1', 'a1'])
    expect(transcript.messages[1].annotations).toEqual({
      segmentId: '__initial__',
      segmentIndex: 0,
      roundId: 'u1',
      roundIndex: 0,
      isPreferredResponse: true
    })
  })

  it('rejects transcript cursors that do not belong to the current transcript view', async () => {
    await expect(
      topicDataService.getTranscript(topic.id, {
        segmentId: 'after:clear-1',
        cursor: 'missing-cursor'
      })
    ).rejects.toThrow('BAD_REQUEST: cursor not found in transcript view: missing-cursor')
  })

  it('filters search hits by message timestamp instead of topic timestamp', async () => {
    const result = await topicDataService.searchMessages('follow-up', {
      topicId: topic.id,
      messageRange: {
        from: '2026-03-12T00:00:00.000Z',
        to: '2026-03-12T23:59:59.000Z'
      }
    })

    expect(result.returnMode).toBe('query')
    if (result.returnMode !== 'query') {
      throw new Error('Expected query search result')
    }

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      messageId: 'a3',
      topicId: topic.id,
      mainText: 'Final follow-up reply',
      annotations: {
        segmentId: 'after:clear-1',
        segmentIndex: 1,
        roundId: 'u2',
        roundIndex: 1,
        isPreferredResponse: true
      }
    })
  })

  it('returns a context window around an anchor message', async () => {
    const result = await topicDataService.getMessageContext('u2', {
      before: 1,
      after: 1
    })

    expect(result).toMatchObject({
      anchorMessageId: 'u2',
      topicId: topic.id,
      topicName: topic.name
    })
    expect(result.messages.map((message) => message.messageId)).toEqual(['a-orphan', 'u2', 'a3'])
  })

  it('returns batch message details in input order and reports missing ids', async () => {
    const result = await topicDataService.batchGetMessages(['a3', 'missing-id', 'u1'])

    expect(result.messages.map((message) => message.messageId)).toEqual(['a3', 'u1'])
    expect(result.missingMessageIds).toEqual(['missing-id'])
  })

  it('lists cross-topic messages with main text and cursor pagination', async () => {
    const firstPage = await topicDataService.listAllMessages({
      order: 'desc',
      limit: 2
    })

    expect(firstPage.messages.map((message) => message.messageId)).toEqual(['a4', 'u3'])
    expect(firstPage.messages[0]).toMatchObject({
      topicId: topicTwo.id,
      topicName: topicTwo.name,
      assistantName: 'Architect',
      mainText: 'Final follow-up reply'
    })
    expect(firstPage.pageInfo).toEqual({
      hasMore: true,
      nextCursor: 'u3',
      returnedMessages: 2,
      totalMessages: 8
    })

    const secondPage = await topicDataService.listAllMessages({
      order: 'desc',
      cursor: firstPage.pageInfo.nextCursor,
      limit: 10
    })

    expect(secondPage.messages.map((message) => message.messageId)).toEqual(['a3', 'u2', 'a-orphan', 'a2', 'a1', 'u1'])
  })

  it('supports structured search criteria and deduplicates duplicate content across topics', async () => {
    const result = await topicDataService.searchMessages('', {
      anyOf: ['follow-up'],
      exclude: ['detached'],
      deduplicate: true,
      deduplicateBy: 'normalizedText',
      sort: 'createdAt',
      order: 'desc'
    })

    expect(result.returnMode).toBe('query')
    if (result.returnMode !== 'query') {
      throw new Error('Expected query search result')
    }

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      messageId: 'a4',
      topicId: topicTwo.id,
      mainText: 'Final follow-up reply',
      contentHash: expect.any(String),
      duplicateCount: 2,
      appearsInTopics: [
        {
          topicId: topicTwo.id,
          topicName: topicTwo.name,
          messageId: 'a4',
          createdAt: '2026-03-12T12:02:00.000Z'
        },
        {
          topicId: topic.id,
          topicName: topic.name,
          messageId: 'a3',
          createdAt: '2026-03-12T11:05:00.000Z'
        }
      ]
    })
  })

  it('supports AND-style search terms and relevance ordering', async () => {
    const result = await topicDataService.searchMessages('reply', {
      allOf: ['final', 'follow-up'],
      sort: 'relevance',
      order: 'desc'
    })

    expect(result.returnMode).toBe('query')
    if (result.returnMode !== 'query') {
      throw new Error('Expected query search result')
    }

    expect(result.hits.slice(0, 2).map((hit) => hit.messageId)).toEqual(['a4', 'a3'])
    expect(result.hits[0].mainText).toBe('Final follow-up reply')
  })

  it('can expand search hits into round groups', async () => {
    const result = await topicDataService.searchMessages('final follow-up', {
      returnMode: 'round',
      sort: 'createdAt',
      order: 'desc'
    })

    expect(result.returnMode).toBe('round')
    if (result.returnMode !== 'round') {
      throw new Error('Expected round-grouped search result')
    }

    expect(result.total).toBe(2)
    expect(result.matchedMessageCount).toBe(2)
    expect(result.groups.map((group) => group.groupId)).toEqual(['round:topic-2:u3', 'round:topic-1:u2'])
    expect(result.groups[0]).toMatchObject({
      topicId: topicTwo.id,
      topicName: topicTwo.name,
      roundId: 'u3',
      matchedMessages: [expect.objectContaining({ messageId: 'a4' })]
    })
    expect(result.groups[0].messages.map((message) => message.messageId)).toEqual(['u3', 'a4'])
    expect(result.groups[1].messages.map((message) => message.messageId)).toEqual(['u2', 'a3'])
  })

  it('can expand search hits into full topic groups', async () => {
    const result = await topicDataService.searchMessages('final follow-up', {
      returnMode: 'topic',
      sort: 'createdAt',
      order: 'desc'
    })

    expect(result.returnMode).toBe('topic')
    if (result.returnMode !== 'topic') {
      throw new Error('Expected topic-grouped search result')
    }

    expect(result.total).toBe(2)
    expect(result.matchedMessageCount).toBe(2)
    expect(result.groups[0]).toMatchObject({
      topicId: topicTwo.id,
      matchedMessages: [expect.objectContaining({ messageId: 'a4' })]
    })
    expect(result.groups[0].messages.map((message) => message.messageId)).toEqual(['u3', 'a4'])
    expect(result.groups[1].matchedMessages.map((message) => message.messageId)).toEqual(['a3'])
    expect(result.groups[1].messages.map((message) => message.messageId)).toEqual([
      'u1',
      'a1',
      'a2',
      'a-orphan',
      'u2',
      'a3'
    ])
  })

  it('rejects deduplication when search results are expanded into grouped context', async () => {
    await expect(
      topicDataService.searchMessages('follow-up', {
        returnMode: 'round',
        deduplicate: true
      })
    ).rejects.toThrow('BAD_REQUEST: deduplicate is only supported when returnMode=query')
  })
})
