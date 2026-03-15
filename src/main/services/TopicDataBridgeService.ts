import type {
  HistoryMessageListOptions,
  HistoryMessageListResult,
  MessageBatchResult,
  MessageContextOptions,
  MessageContextResult,
  MessageListOptions,
  MessageListResult,
  MessageRecord,
  SearchMessagesOptions,
  SearchMessagesResult,
  TopicListFilter,
  TopicListResult,
  TopicMetaResult,
  TranscriptOptions,
  TranscriptResult,
  WindowTopicDataService
} from '@shared/history'

import { loggerService } from './LoggerService'
import { reduxService } from './ReduxService'
import { windowService } from './WindowService'

const logger = loggerService.withContext('TopicDataBridgeService')

type TopicDataMethod = keyof WindowTopicDataService

export class TopicDataUnavailableError extends Error {}
export class TopicDataNotFoundError extends Error {}
export class TopicDataBadRequestError extends Error {}

class TopicDataBridgeService {
  async listTopics(filter?: TopicListFilter): Promise<TopicListResult> {
    return this.invoke('listTopics', filter)
  }

  async getTopicMeta(topicId: string): Promise<TopicMetaResult> {
    return this.invoke('getTopicMeta', topicId)
  }

  async listMessages(topicId: string, options?: MessageListOptions): Promise<MessageListResult> {
    return this.invoke('listMessages', topicId, options)
  }

  async listAllMessages(options?: HistoryMessageListOptions): Promise<HistoryMessageListResult> {
    return this.invoke('listAllMessages', options)
  }

  async getMessage(messageId: string): Promise<MessageRecord> {
    return this.invoke('getMessage', messageId)
  }

  async getMessageContext(messageId: string, options?: MessageContextOptions): Promise<MessageContextResult> {
    return this.invoke('getMessageContext', messageId, options)
  }

  async batchGetMessages(messageIds: string[]): Promise<MessageBatchResult> {
    return this.invoke('batchGetMessages', messageIds)
  }

  async getTranscript(topicId: string, options?: TranscriptOptions): Promise<TranscriptResult> {
    return this.invoke('getTranscript', topicId, options)
  }

  async searchMessages(query: string, options?: SearchMessagesOptions): Promise<SearchMessagesResult> {
    return this.invoke('searchMessages', query, options)
  }

  private async invoke<TResult>(method: TopicDataMethod, ...args: unknown[]): Promise<TResult> {
    try {
      await reduxService.select('true')
      const mainWindow = windowService.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new TopicDataUnavailableError('Renderer window is not ready')
      }

      const serializedArgs = args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(', ')
      const script = `
        (async () => {
          try {
            const service = window.topicDataService;
            if (!service || typeof service[${JSON.stringify(method)}] !== 'function') {
              return { ok: false, error: 'SERVICE_UNAVAILABLE: Topic data service is not ready in renderer' };
            }

            const data = await service[${JSON.stringify(method)}](${serializedArgs});
            return { ok: true, data };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            };
          }
        })()
      `

      const result = await mainWindow.webContents.executeJavaScript(script)
      if (!result?.ok) {
        throw this.normalizeRendererError(String(result?.error || 'Unknown renderer error'))
      }

      return result.data as TResult
    } catch (error) {
      if (
        error instanceof TopicDataUnavailableError ||
        error instanceof TopicDataNotFoundError ||
        error instanceof TopicDataBadRequestError
      ) {
        throw error
      }

      logger.error('Failed to invoke topic data service', {
        method,
        error
      })
      throw new TopicDataUnavailableError('Failed to access topic data service')
    }
  }

  private normalizeRendererError(message: string): Error {
    if (message.startsWith('NOT_FOUND:')) {
      return new TopicDataNotFoundError(message.replace(/^NOT_FOUND:\s*/, ''))
    }

    if (message.startsWith('BAD_REQUEST:')) {
      return new TopicDataBadRequestError(message.replace(/^BAD_REQUEST:\s*/, ''))
    }

    if (message.startsWith('SERVICE_UNAVAILABLE:')) {
      return new TopicDataUnavailableError(message.replace(/^SERVICE_UNAVAILABLE:\s*/, ''))
    }

    return new Error(message)
  }
}

export const topicDataBridgeService = new TopicDataBridgeService()
