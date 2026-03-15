export interface TimeRange {
  from?: string
  to?: string
}

export interface TopicListFilter {
  topicCreatedRange?: TimeRange
  topicActivityRange?: TimeRange
  assistantId?: string
  keyword?: string
  minMessageCount?: number
  sortBy?: 'createdAt' | 'updatedAt' | 'lastMessageAt' | 'messageCount'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface TopicListEntry {
  topicId: string
  topicName: string
  assistantId: string
  assistantName: string
  createdAt: string
  updatedAt: string
  firstMessageAt?: string
  lastMessageAt?: string
  messageCount: number
  roundCount: number
  segmentCount: number
  preview: string
}

export interface TopicListResult {
  topics: TopicListEntry[]
  total: number
}

export type TopicMetaResult = TopicListEntry

export interface MessageToolCall {
  toolName: string
  arguments: string
  result: string
}

export interface MessageAnnotations {
  segmentId: string
  segmentIndex: number
  roundId?: string
  roundIndex?: number
  isPreferredResponse?: boolean
}

export interface MessageRecord {
  messageId: string
  topicId: string
  role: 'user' | 'assistant'
  type?: 'clear'
  askId?: string
  useful?: boolean
  modelId?: string
  createdAt: string
  mainText?: string
  thinkingText?: string
  toolCalls?: MessageToolCall[]
  annotations: MessageAnnotations
}

export interface MessagePreviewRecord {
  messageId: string
  topicId: string
  role: 'user' | 'assistant'
  modelId?: string
  createdAt: string
  preview: string
  annotations: MessageAnnotations
}

export interface MessageListOptions {
  role?: 'user' | 'assistant'
  segmentId?: string
  limit?: number
  offset?: number
}

export interface MessageListResult {
  topicId: string
  messages: MessagePreviewRecord[]
  total: number
}

export interface TranscriptOptions {
  segmentId?: string
  role?: 'user' | 'assistant' | 'both'
  responseSelection?: 'all' | 'preferred'
  order?: 'asc' | 'desc'
  cursor?: string
  limitMessages?: number
}

export interface PageInfo {
  hasMore: boolean
  nextCursor?: string
  returnedMessages: number
  totalMessages: number
}

export interface TranscriptResult {
  topicId: string
  topicName: string
  messages: MessageRecord[]
  pageInfo: PageInfo
}

export interface SearchMessagesOptions {
  messageRange?: TimeRange
  assistantId?: string
  topicId?: string
  role?: 'user' | 'assistant'
  limit?: number
  offset?: number
}

export interface MessageHit {
  topicId: string
  topicName: string
  assistantName: string
  messageId: string
  role: 'user' | 'assistant'
  snippet: string
  createdAt: string
  annotations: MessageAnnotations
}

export interface SearchMessagesResult {
  hits: MessageHit[]
  total: number
  query: string
}

export interface WindowTopicDataService {
  listTopics: (filter?: TopicListFilter) => Promise<TopicListResult>
  getTopicMeta: (topicId: string) => Promise<TopicMetaResult>
  listMessages: (topicId: string, options?: MessageListOptions) => Promise<MessageListResult>
  getMessage: (messageId: string) => Promise<MessageRecord>
  getTranscript: (topicId: string, options?: TranscriptOptions) => Promise<TranscriptResult>
  searchMessages: (query: string, options?: SearchMessagesOptions) => Promise<SearchMessagesResult>
}
