/**
 * TopicDataService
 *
 * A read-only chat history data surface for local tools and skills.
 * It exposes stable topic/message/transcript/search primitives and
 * encodes round/segment as lightweight annotations on messages.
 */
import { loggerService } from '@logger'
import db from '@renderer/databases'
import { isAgentSessionTopicId } from '@renderer/services/db/types'
import store from '@renderer/store'
import type { Assistant, Topic } from '@renderer/types'
import {
  type MainTextMessageBlock,
  type Message,
  type MessageBlock,
  MessageBlockType,
  type ThinkingMessageBlock,
  type ToolMessageBlock
} from '@renderer/types/newMessage'
import type {
  MessageAnnotations,
  MessageListOptions,
  MessageListResult,
  MessagePreviewRecord,
  MessageRecord,
  MessageToolCall,
  PageInfo,
  SearchMessagesOptions,
  SearchMessagesResult,
  TimeRange,
  TopicListEntry,
  TopicListFilter,
  TopicListResult,
  TopicMetaResult,
  TranscriptOptions,
  TranscriptResult,
  WindowTopicDataService
} from '@shared/history'

const logger = loggerService.withContext('TopicDataService')

interface Round {
  userMessage: Message
  assistantMessages: Message[]
}

interface Segment {
  segmentId: string
  rounds: Round[]
}

interface TopicMeta {
  topic: Topic
  assistantId: string
  assistantName: string
}

interface FlatRoundRef {
  segmentId: string
  segmentIndex: number
  roundId: string
  roundIndex: number
  round: Round
}

interface TopicSummaryContext {
  meta: TopicMeta
  messages: Message[]
  annotations: Map<string, MessageAnnotations>
  conversationMessages: Message[]
  roundCount: number
  segmentCount: number
  firstMessageAt?: string
  lastMessageAt?: string
  preview: string
}

class TopicDataService {
  private static instance: TopicDataService

  static getInstance(): TopicDataService {
    if (!TopicDataService.instance) {
      TopicDataService.instance = new TopicDataService()
    }
    return TopicDataService.instance
  }

  async listTopics(filter?: TopicListFilter): Promise<TopicListResult> {
    const metas = this.getAllTopicMeta()
    let candidates = metas

    if (filter?.assistantId) {
      candidates = candidates.filter((meta) => meta.assistantId === filter.assistantId)
    }

    const topicIds = candidates.map((meta) => meta.topic.id)
    const topicDataList = await db.topics.bulkGet(topicIds)
    const contexts = await Promise.all(
      candidates.map(async (meta, index) => this.buildTopicSummaryContext(meta, topicDataList[index]?.messages || []))
    )

    let filtered = contexts.filter((context) => {
      if (filter?.topicCreatedRange && !this.inTimeRange(context.meta.topic.createdAt, filter.topicCreatedRange)) {
        return false
      }

      if (filter?.topicActivityRange) {
        if (!context.lastMessageAt || !this.inTimeRange(context.lastMessageAt, filter.topicActivityRange)) {
          return false
        }
      }

      if (filter?.minMessageCount && context.conversationMessages.length < filter.minMessageCount) {
        return false
      }

      if (filter?.keyword) {
        const keyword = filter.keyword.toLowerCase()
        const haystack = [context.meta.topic.name, context.meta.assistantName, context.preview].join(' ').toLowerCase()
        if (!haystack.includes(keyword)) {
          return false
        }
      }

      return true
    })

    const total = filtered.length
    const sortBy: NonNullable<TopicListFilter['sortBy']> = filter?.sortBy || 'updatedAt'
    const sortOrder: NonNullable<TopicListFilter['sortOrder']> = filter?.sortOrder || 'desc'

    filtered = filtered.sort((left, right) => {
      const leftValue = this.getTopicSortValue(left, sortBy)
      const rightValue = this.getTopicSortValue(right, sortBy)
      return sortOrder === 'desc' ? rightValue - leftValue : leftValue - rightValue
    })

    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? 50
    const page = filtered.slice(offset, offset + limit)

    return {
      topics: page.map((context) => this.toTopicListEntry(context)),
      total
    }
  }

  async getTopicMeta(topicId: string): Promise<TopicMetaResult> {
    const meta = this.findTopicMeta(topicId)
    if (!meta) {
      throw new Error(`NOT_FOUND: Topic not found: ${topicId}`)
    }

    const topicData = await db.topics.get(topicId)
    if (!topicData) {
      throw new Error(`NOT_FOUND: Topic not found: ${topicId}`)
    }

    const context = await this.buildTopicSummaryContext(meta, topicData.messages || [])
    return this.toTopicListEntry(context)
  }

  async listMessages(topicId: string, options?: MessageListOptions): Promise<MessageListResult> {
    const { messages, annotations } = await this.getTopicConversationContext(topicId)
    const filtered = this.filterConversationMessages(messages, annotations, options)

    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 100
    const page = filtered.slice(offset, offset + limit)
    const blocksMap = await this.loadBlocksMap(page.flatMap((message) => message.blocks || []))

    const result: MessagePreviewRecord[] = page.map((message) => ({
      messageId: message.id,
      topicId,
      role: message.role as 'user' | 'assistant',
      modelId: message.modelId,
      createdAt: message.createdAt,
      preview: this.extractMainText(message, blocksMap).slice(0, 200),
      annotations: this.mustGetAnnotations(annotations, message.id)
    }))

    return {
      topicId,
      messages: result,
      total: filtered.length
    }
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    const metas = this.getAllTopicMeta()

    for (const meta of metas) {
      const topicData = await db.topics.get(meta.topic.id)
      if (!topicData?.messages?.length) {
        continue
      }

      const message = topicData.messages.find(
        (candidate) =>
          candidate.id === messageId &&
          candidate.type !== 'clear' &&
          (candidate.role === 'user' || candidate.role === 'assistant')
      )

      if (!message) {
        continue
      }

      const annotations = this.buildMessageAnnotations(topicData.messages)
      const blocksMap = await this.loadBlocksMap(message.blocks || [])
      return this.toMessageRecord(meta.topic.id, message, blocksMap, annotations)
    }

    throw new Error(`NOT_FOUND: Message not found: ${messageId}`)
  }

  async getTranscript(topicId: string, options?: TranscriptOptions): Promise<TranscriptResult> {
    const topicMeta = this.findTopicMeta(topicId)
    if (!topicMeta) {
      throw new Error(`NOT_FOUND: Topic not found: ${topicId}`)
    }

    const { messages, annotations, rounds } = await this.getTopicConversationContext(topicId)
    const role = options?.role ?? 'both'
    const order = options?.order ?? 'asc'
    const responseSelection = options?.responseSelection ?? 'all'
    const limitMessages = options?.limitMessages ?? 200

    const preferredAssistantIds =
      responseSelection === 'preferred' ? this.getPreferredAssistantIds(rounds) : new Set<string>()

    let filtered = messages.filter((message) => {
      const annotation = this.mustGetAnnotations(annotations, message.id)

      if (options?.segmentId && annotation.segmentId !== options.segmentId) {
        return false
      }

      if (role !== 'both' && message.role !== role) {
        return false
      }

      if (
        responseSelection === 'preferred' &&
        message.role === 'assistant' &&
        annotation.roundId &&
        !preferredAssistantIds.has(message.id)
      ) {
        return false
      }

      return true
    })

    if (order === 'desc') {
      filtered = [...filtered].reverse()
    }

    const totalMessages = filtered.length
    let startIndex = 0
    if (options?.cursor) {
      const cursorIndex = filtered.findIndex((message) => message.id === options.cursor)
      if (cursorIndex === -1) {
        throw new Error(`BAD_REQUEST: cursor not found in transcript view: ${options.cursor}`)
      }
      startIndex = cursorIndex + 1
    }

    const sliced = startIndex > 0 ? filtered.slice(startIndex) : filtered
    const hasMore = sliced.length > limitMessages
    const page = sliced.slice(0, limitMessages)
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined

    const blocksMap = await this.loadBlocksMap(page.flatMap((message) => message.blocks || []))
    const records = page.map((message) => this.toMessageRecord(topicId, message, blocksMap, annotations))

    return {
      topicId,
      topicName: topicMeta.topic.name,
      messages: records,
      pageInfo: {
        hasMore,
        nextCursor,
        returnedMessages: records.length,
        totalMessages
      }
    }
  }

  async searchMessages(query: string, options?: SearchMessagesOptions): Promise<SearchMessagesResult> {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      return {
        hits: [],
        total: 0,
        query
      }
    }

    const limit = options?.limit ?? 20
    const offset = options?.offset ?? 0
    const lowerQuery = trimmedQuery.toLowerCase()
    const metas = this.getAllTopicMeta().filter((meta) => {
      if (options?.assistantId && meta.assistantId !== options.assistantId) {
        return false
      }

      if (options?.topicId && meta.topic.id !== options.topicId) {
        return false
      }

      return true
    })

    const hits: SearchMessagesResult['hits'] = []

    for (const meta of metas) {
      const topicData = await db.topics.get(meta.topic.id)
      if (!topicData?.messages?.length) {
        continue
      }

      const annotations = this.buildMessageAnnotations(topicData.messages)
      const conversationMessages = this.getConversationMessages(topicData.messages)
      const blocksMap = await this.loadBlocksMap(conversationMessages.flatMap((message) => message.blocks || []))

      for (const message of conversationMessages) {
        if (options?.role && message.role !== options.role) {
          continue
        }

        if (options?.messageRange && !this.inTimeRange(message.createdAt, options.messageRange)) {
          continue
        }

        const mainText = this.extractMainText(message, blocksMap)
        const index = mainText.toLowerCase().indexOf(lowerQuery)
        if (index === -1) {
          continue
        }

        const start = Math.max(0, index - 80)
        const end = Math.min(mainText.length, index + trimmedQuery.length + 80)
        const snippet = `${start > 0 ? '…' : ''}${mainText.slice(start, end)}${end < mainText.length ? '…' : ''}`

        hits.push({
          topicId: meta.topic.id,
          topicName: meta.topic.name,
          assistantName: meta.assistantName,
          messageId: message.id,
          role: message.role as 'user' | 'assistant',
          snippet,
          createdAt: message.createdAt,
          annotations: this.mustGetAnnotations(annotations, message.id)
        })
      }
    }

    hits.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

    return {
      hits: hits.slice(offset, offset + limit),
      total: hits.length,
      query
    }
  }

  private async getTopicConversationContext(topicId: string): Promise<{
    messages: Message[]
    annotations: Map<string, MessageAnnotations>
    rounds: FlatRoundRef[]
  }> {
    const topicData = await db.topics.get(topicId)
    if (!topicData) {
      throw new Error(`NOT_FOUND: Topic not found: ${topicId}`)
    }

    const annotations = this.buildMessageAnnotations(topicData.messages || [])
    return {
      messages: this.getConversationMessages(topicData.messages || []),
      annotations,
      rounds: this.flattenRounds(topicData.messages || [])
    }
  }

  private async buildTopicSummaryContext(meta: TopicMeta, messages: Message[]): Promise<TopicSummaryContext> {
    const conversationMessages = this.getConversationMessages(messages)
    const annotations = this.buildMessageAnnotations(messages)
    const flatRounds = this.flattenRounds(messages)
    const nonEmptySegments = new Set(
      conversationMessages
        .map((message) => annotations.get(message.id)?.segmentId)
        .filter((segmentId): segmentId is string => Boolean(segmentId))
    )
    const firstMessage = conversationMessages[0]
    const lastMessage = conversationMessages[conversationMessages.length - 1]
    const firstUserMessage = conversationMessages.find((message) => message.role === 'user')

    let preview = ''
    if (firstUserMessage?.blocks?.length) {
      const blocksMap = await this.loadBlocksMap([firstUserMessage.blocks[0]])
      preview = this.extractMainText(firstUserMessage, blocksMap).slice(0, 100)
    }

    return {
      meta,
      messages,
      annotations,
      conversationMessages,
      roundCount: flatRounds.length,
      segmentCount: nonEmptySegments.size,
      firstMessageAt: firstMessage?.createdAt,
      lastMessageAt: lastMessage?.createdAt,
      preview
    }
  }

  private toTopicListEntry(context: TopicSummaryContext): TopicListEntry {
    return {
      topicId: context.meta.topic.id,
      topicName: context.meta.topic.name,
      assistantId: context.meta.assistantId,
      assistantName: context.meta.assistantName,
      createdAt: context.meta.topic.createdAt,
      updatedAt: context.meta.topic.updatedAt,
      firstMessageAt: context.firstMessageAt,
      lastMessageAt: context.lastMessageAt,
      messageCount: context.conversationMessages.length,
      roundCount: context.roundCount,
      segmentCount: context.segmentCount,
      preview: context.preview
    }
  }

  private filterConversationMessages(
    messages: Message[],
    annotations: Map<string, MessageAnnotations>,
    options?: MessageListOptions
  ): Message[] {
    return messages.filter((message) => {
      if (options?.role && message.role !== options.role) {
        return false
      }

      if (options?.segmentId) {
        const annotation = this.mustGetAnnotations(annotations, message.id)
        if (annotation.segmentId !== options.segmentId) {
          return false
        }
      }

      return true
    })
  }

  private getPreferredAssistantIds(rounds: FlatRoundRef[]): Set<string> {
    const result = new Set<string>()
    for (const round of rounds) {
      const preferred =
        round.round.assistantMessages.find((message) => message.useful) || round.round.assistantMessages[0]
      if (preferred) {
        result.add(preferred.id)
      }
    }
    return result
  }

  private toMessageRecord(
    topicId: string,
    message: Message,
    blocksMap: Map<string, MessageBlock>,
    annotations: Map<string, MessageAnnotations>
  ): MessageRecord {
    const thinkingBlocks = this.extractBlocksByType<ThinkingMessageBlock>(message, blocksMap, MessageBlockType.THINKING)
    const toolBlocks = this.extractBlocksByType<ToolMessageBlock>(message, blocksMap, MessageBlockType.TOOL)

    return {
      messageId: message.id,
      topicId,
      role: message.role as 'user' | 'assistant',
      type: message.type,
      askId: message.askId,
      useful: message.useful,
      modelId: message.modelId,
      createdAt: message.createdAt,
      mainText: this.extractMainText(message, blocksMap),
      thinkingText: thinkingBlocks.length ? thinkingBlocks.map((block) => block.content).join('\n') : undefined,
      toolCalls: this.toToolCalls(toolBlocks),
      annotations: this.mustGetAnnotations(annotations, message.id)
    }
  }

  private toToolCalls(toolBlocks: ToolMessageBlock[]): MessageToolCall[] | undefined {
    if (!toolBlocks.length) {
      return undefined
    }

    return toolBlocks.map((block) => ({
      toolName: block.toolName || block.toolId,
      arguments: typeof block.arguments === 'object' ? JSON.stringify(block.arguments) : String(block.arguments || ''),
      result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
    }))
  }

  private buildMessageAnnotations(messages: Message[]): Map<string, MessageAnnotations> {
    const annotations = new Map<string, MessageAnnotations>()
    const segments = this.groupMessagesIntoSegments(messages)
    const segmentIndexById = new Map(segments.map((segment, index) => [segment.segmentId, index]))
    const roundRefs = this.flattenRounds(messages)
    const preferredAssistantIds = this.getPreferredAssistantIds(roundRefs)

    for (const roundRef of roundRefs) {
      annotations.set(roundRef.round.userMessage.id, {
        segmentId: roundRef.segmentId,
        segmentIndex: roundRef.segmentIndex,
        roundId: roundRef.roundId,
        roundIndex: roundRef.roundIndex
      })

      for (const response of roundRef.round.assistantMessages) {
        annotations.set(response.id, {
          segmentId: roundRef.segmentId,
          segmentIndex: roundRef.segmentIndex,
          roundId: roundRef.roundId,
          roundIndex: roundRef.roundIndex,
          isPreferredResponse: preferredAssistantIds.has(response.id)
        })
      }
    }

    let currentSegmentId = '__initial__'
    for (const message of messages) {
      if (message.type === 'clear') {
        currentSegmentId = `after:${message.id}`
        continue
      }

      if (message.role !== 'user' && message.role !== 'assistant') {
        continue
      }

      const existing = annotations.get(message.id)
      annotations.set(message.id, {
        segmentId: existing?.segmentId || currentSegmentId,
        segmentIndex: existing?.segmentIndex ?? segmentIndexById.get(currentSegmentId) ?? 0,
        roundId: existing?.roundId,
        roundIndex: existing?.roundIndex,
        isPreferredResponse:
          existing?.isPreferredResponse ?? (message.role === 'assistant' ? message.useful === true : undefined)
      })
    }

    return annotations
  }

  private getConversationMessages(messages: Message[]): Message[] {
    return messages.filter(
      (message) => message.type !== 'clear' && (message.role === 'user' || message.role === 'assistant')
    )
  }

  private groupMessagesIntoSegments(messages: Message[]): Segment[] {
    const segments: Segment[] = []
    let currentMessages: Message[] = []
    let currentSegmentId = '__initial__'

    for (const message of messages) {
      if (message.type === 'clear') {
        if (currentMessages.length > 0) {
          segments.push({
            segmentId: currentSegmentId,
            rounds: this.groupMessagesIntoRounds(currentMessages)
          })
        }
        currentMessages = []
        currentSegmentId = `after:${message.id}`
        continue
      }

      currentMessages.push(message)
    }

    if (currentMessages.length > 0) {
      segments.push({
        segmentId: currentSegmentId,
        rounds: this.groupMessagesIntoRounds(currentMessages)
      })
    }

    return segments
  }

  private groupMessagesIntoRounds(messages: Message[]): Round[] {
    const assistantsByAskId = new Map<string, Message[]>()
    for (const message of messages) {
      if (message.role === 'assistant' && message.askId) {
        const group = assistantsByAskId.get(message.askId) || []
        group.push(message)
        assistantsByAskId.set(message.askId, group)
      }
    }

    const rounds: Round[] = []
    for (const message of messages) {
      if (message.role !== 'user') {
        continue
      }

      rounds.push({
        userMessage: message,
        assistantMessages: assistantsByAskId.get(message.id) || []
      })
    }

    return rounds
  }

  private flattenRounds(messages: Message[]): FlatRoundRef[] {
    const segments = this.groupMessagesIntoSegments(messages)
    const result: FlatRoundRef[] = []
    let roundIndex = 0

    segments.forEach((segment, segmentIndex) => {
      segment.rounds.forEach((round) => {
        result.push({
          segmentId: segment.segmentId,
          segmentIndex,
          roundId: round.userMessage.id,
          roundIndex: roundIndex++,
          round
        })
      })
    })

    return result
  }

  private async loadBlocksMap(blockIds: string[]): Promise<Map<string, MessageBlock>> {
    if (!blockIds.length) {
      return new Map()
    }

    const uniqueIds = [...new Set(blockIds)]
    const blocks = await db.message_blocks.bulkGet(uniqueIds)
    const result = new Map<string, MessageBlock>()
    uniqueIds.forEach((blockId, index) => {
      const block = blocks[index]
      if (block) {
        result.set(blockId, block)
      }
    })
    return result
  }

  private extractMainText(message: Message, blocksMap: Map<string, MessageBlock>): string {
    return (message.blocks || [])
      .map((blockId) => blocksMap.get(blockId))
      .filter((block): block is MainTextMessageBlock => block?.type === MessageBlockType.MAIN_TEXT)
      .map((block) => block.content)
      .join('\n')
  }

  private extractBlocksByType<T extends MessageBlock>(
    message: Message,
    blocksMap: Map<string, MessageBlock>,
    blockType: MessageBlockType
  ): T[] {
    return (message.blocks || [])
      .map((blockId) => blocksMap.get(blockId))
      .filter((block): block is T => block?.type === blockType)
  }

  private mustGetAnnotations(annotations: Map<string, MessageAnnotations>, messageId: string): MessageAnnotations {
    const annotation = annotations.get(messageId)
    if (!annotation) {
      logger.warn('Missing message annotations, falling back to initial segment', { messageId })
      return {
        segmentId: '__initial__',
        segmentIndex: 0
      }
    }
    return annotation
  }

  private getTopicSortValue(context: TopicSummaryContext, sortBy: NonNullable<TopicListFilter['sortBy']>): number {
    switch (sortBy) {
      case 'createdAt':
        return new Date(context.meta.topic.createdAt).getTime()
      case 'lastMessageAt':
        return context.lastMessageAt ? new Date(context.lastMessageAt).getTime() : 0
      case 'messageCount':
        return context.conversationMessages.length
      case 'updatedAt':
      default:
        return new Date(context.meta.topic.updatedAt).getTime()
    }
  }

  private getAllTopicMeta(): TopicMeta[] {
    const state = store.getState()
    const assistants: Assistant[] = state.assistants?.assistants || []
    const result: TopicMeta[] = []

    for (const assistant of assistants) {
      const topics: Topic[] = Array.isArray(assistant.topics) ? assistant.topics : []
      for (const topic of topics) {
        if (isAgentSessionTopicId(topic.id)) {
          continue
        }

        result.push({
          topic,
          assistantId: assistant.id,
          assistantName: assistant.name || ''
        })
      }
    }

    return result
  }

  private findTopicMeta(topicId: string): TopicMeta | undefined {
    return this.getAllTopicMeta().find((meta) => meta.topic.id === topicId)
  }

  private inTimeRange(isoString: string, range: TimeRange): boolean {
    const time = new Date(isoString).getTime()
    if (Number.isNaN(time)) {
      return false
    }

    if (range.from) {
      const from = new Date(range.from).getTime()
      if (!Number.isNaN(from) && time < from) {
        return false
      }
    }

    if (range.to) {
      const to = new Date(range.to).getTime()
      if (!Number.isNaN(to) && time > to) {
        return false
      }
    }

    return true
  }
}

export const topicDataService = TopicDataService.getInstance()

export const windowTopicDataService: WindowTopicDataService = {
  listTopics: (filter) => topicDataService.listTopics(filter),
  getTopicMeta: (topicId) => topicDataService.getTopicMeta(topicId),
  listMessages: (topicId, options) => topicDataService.listMessages(topicId, options),
  getMessage: (messageId) => topicDataService.getMessage(messageId),
  getTranscript: (topicId, options) => topicDataService.getTranscript(topicId, options),
  searchMessages: (query, options) => topicDataService.searchMessages(query, options)
}

if (typeof window !== 'undefined') {
  window.topicDataService = windowTopicDataService
}

export { TopicDataService }
export type {
  MessageAnnotations,
  MessageListOptions,
  MessageListResult,
  MessagePreviewRecord,
  MessageRecord,
  MessageToolCall,
  PageInfo,
  SearchMessagesOptions,
  SearchMessagesResult,
  TimeRange,
  TopicListEntry,
  TopicListFilter,
  TopicListResult,
  TopicMetaResult,
  TranscriptOptions,
  TranscriptResult,
  WindowTopicDataService
}
