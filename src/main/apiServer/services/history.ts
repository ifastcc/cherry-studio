import {
  TopicDataBadRequestError,
  topicDataBridgeService,
  TopicDataNotFoundError,
  TopicDataUnavailableError
} from '@main/services/TopicDataBridgeService'
import type {
  MessageListOptions,
  MessageListResult,
  MessageRecord,
  SearchMessagesOptions,
  SearchMessagesResult,
  TopicListFilter,
  TopicListResult,
  TopicMetaResult,
  TranscriptOptions,
  TranscriptResult
} from '@shared/history'

class HistoryService {
  async listTopics(filter?: TopicListFilter): Promise<TopicListResult> {
    return topicDataBridgeService.listTopics(filter)
  }

  async getTopicMeta(topicId: string): Promise<TopicMetaResult> {
    return topicDataBridgeService.getTopicMeta(topicId)
  }

  async listMessages(topicId: string, options?: MessageListOptions): Promise<MessageListResult> {
    return topicDataBridgeService.listMessages(topicId, options)
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    return topicDataBridgeService.getMessage(messageId)
  }

  async getTranscript(topicId: string, options?: TranscriptOptions): Promise<TranscriptResult> {
    return topicDataBridgeService.getTranscript(topicId, options)
  }

  async searchMessages(query: string, options?: SearchMessagesOptions): Promise<SearchMessagesResult> {
    return topicDataBridgeService.searchMessages(query, options)
  }
}

export const historyService = new HistoryService()
export { TopicDataBadRequestError, TopicDataNotFoundError, TopicDataUnavailableError }
