import fs from 'node:fs/promises'
import path from 'node:path'

import { API_SERVER_DEFAULTS } from '@shared/config/constant'
import type { ApiServerConfig } from '@types'
import { v4 as uuidv4 } from 'uuid'

import { DATA_PATH } from '../config'
import { loggerService } from '../services/LoggerService'
import { reduxService } from '../services/ReduxService'

const logger = loggerService.withContext('ApiServerConfig')
const CONNECTION_FILE_NAME = 'api-server.json'

function buildBaseURL(host: string, port: number): string {
  const normalizedHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`
  return `${normalizedHost}:${port}/v1`
}

class ConfigManager {
  private _config: ApiServerConfig | null = null

  private generateApiKey(): string {
    return `cs-sk-${uuidv4()}`
  }

  private async persistConnectionFile(config: ApiServerConfig): Promise<void> {
    const filePath = path.join(DATA_PATH, CONNECTION_FILE_NAME)
    const payload = {
      baseURL: buildBaseURL(config.host, config.port),
      host: config.host,
      port: config.port,
      apiKey: config.apiKey,
      enabled: config.enabled,
      updatedAt: new Date().toISOString()
    }

    try {
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (error: any) {
      logger.warn('Failed to persist API server connection profile', { error, filePath })
    }
  }

  async load(): Promise<ApiServerConfig> {
    try {
      const settings = await reduxService.select('state.settings')
      const serverSettings = settings?.apiServer
      let apiKey = serverSettings?.apiKey
      if (!apiKey || apiKey.trim() === '') {
        apiKey = this.generateApiKey()
        await reduxService.dispatch({
          type: 'settings/setApiServerApiKey',
          payload: apiKey
        })
      }
      this._config = {
        enabled: serverSettings?.enabled ?? false,
        port: serverSettings?.port ?? API_SERVER_DEFAULTS.PORT,
        host: serverSettings?.host ?? API_SERVER_DEFAULTS.HOST,
        apiKey: apiKey
      }
      await this.persistConnectionFile(this._config)
      return this._config
    } catch (error: any) {
      logger.warn('Failed to load config from Redux, using defaults', { error })
      this._config = {
        enabled: false,
        port: API_SERVER_DEFAULTS.PORT,
        host: API_SERVER_DEFAULTS.HOST,
        apiKey: this.generateApiKey()
      }
      await this.persistConnectionFile(this._config)
      return this._config
    }
  }

  async get(): Promise<ApiServerConfig> {
    if (!this._config) {
      await this.load()
    }
    if (!this._config) {
      throw new Error('Failed to load API server configuration')
    }
    return this._config
  }

  async reload(): Promise<ApiServerConfig> {
    return await this.load()
  }
}

export const config = new ConfigManager()
