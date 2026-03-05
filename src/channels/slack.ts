/**
 * Slack Channel Adapter
 * Integrates Slack Bolt with nano-claw for Socket Mode support
 */

import { App } from '@slack/bolt';
import { BaseChannel } from './base';
import { ChannelMessage } from '../types';
import { logger } from '../utils/logger';
import { generateId } from '../utils/helpers';

export interface SlackChannelConfig {
  enabled: boolean;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  allowFrom?: string[];
}

export class SlackChannel extends BaseChannel {
  private config: SlackChannelConfig;
  private app: App | null;
  private connected: boolean;

  constructor(config: SlackChannelConfig) {
    super('slack');
    this.config = config;
    this.app = null;
    this.connected = false;
    this.enabled = config.enabled;
  }

  /**
   * Initialize the Slack bot
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return logger.info('Slack channel is disabled');
    }

    if (!this.config.botToken) {
      throw new Error('Slack bot token is required');
    }

    // Initialize Slack Bolt app
    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      signingSecret: this.config.signingSecret,
      socketMode: !!this.config.appToken, // Use Socket Mode if appToken is provided
    });

    // Set up message handler
    this.app.message(async ({ message }) => {
      try {
        const msg = message as any;
        if (msg.text && msg.user && msg.channel) {
          const channelMessage: ChannelMessage = {
            id: generateId(),
            sessionId: `slack-${msg.channel}`,
            userId: msg.user,
            content: msg.text,
            channelType: 'slack',
            timestamp: new Date(parseInt(msg.ts?.split('.')[0] || '0') * 1000),
            metadata: {
              channelId: msg.channel,
              threadTs: msg.thread_ts,
              messageTs: msg.ts,
            },
          };

          this.emitMessage(channelMessage);
        }
      } catch (error) {
        logger.error('Error handling Slack message', error);
      }
    });

    logger.info('Slack channel initialized');
  }

  /**
   * Start listening for messages
   */
  async start(): Promise<void> {
    if (!this.app) {
      throw new Error('Slack app not initialized');
    }

    try {
      await this.app.start();
      this.connected = true;
      logger.info('Slack channel connected successfully');
    } catch (error) {
      logger.error('Failed to start Slack channel', error);
      throw error;
    }
  }

  /**
   * Stop listening for messages
   */
  async stop(): Promise<void> {
    if (this.app) {
      try {
        await this.app.stop();
      } catch (error) {
        logger.error('Error stopping Slack app', error);
      }
    }
    this.connected = false;
    logger.info('Slack channel stopped');
  }

  /**
   * Send a message through Slack
   */
  async sendMessage(
    userId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (!this.app) {
      throw new Error('Slack client not initialized');
    }

    if (!this.connected) {
      throw new Error('Slack channel is not connected');
    }

    try {
      const channelId = (metadata?.channelId as string) || userId;
      const threadTs = metadata?.threadTs as string | undefined;

      const payload: any = {
        channel: channelId,
        text: content,
      };

      if (threadTs) {
        payload.thread_ts = threadTs;
      }

      const result = await this.app.client.chat.postMessage(payload);

      if (!result.ok) {
        throw new Error(`Slack API error: ${result.error}`);
      }

      logger.debug(`Sent message to Slack channel: ${channelId}`, {
        messageTs: result.ts,
      });
    } catch (error) {
      logger.error('Failed to send Slack message', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check if channel is connected
   */
  protected isConnected(): boolean {
    return this.connected;
  }
}
