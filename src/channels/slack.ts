/**
 * Slack Channel Adapter
 * Integrates Slack Bot API with nano-claw
 */

import { BaseChannel } from './base';
import { ChannelMessage } from '../types';
import { logger } from '../utils/logger';
import { generateId } from '../utils/helpers';
import axios, { AxiosInstance } from 'axios';

export interface SlackChannelConfig {
  enabled: boolean;
  botToken?: string;
  appToken?: string;
}

interface SlackEvent {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEnvelope {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: string;
  event_id: string;
  event_time: number;
  challenge?: string;
}

export class SlackChannel extends BaseChannel {
  private config: SlackChannelConfig;
  private connected: boolean;
  private client: AxiosInstance;

  constructor(config: SlackChannelConfig) {
    super('slack');
    this.config = config;
    this.connected = false;
    this.enabled = config.enabled;
    this.client = axios.create({
      baseURL: 'https://slack.com/api',
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initialize the Slack bot
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) return logger.info('Slack channel is disabled');
    if (!this.config.botToken) throw new Error('Slack bot token is required');
    if (!this.config.appToken) throw new Error('Slack app token is required');

    try {
      // Test the connection
      const response = await this.client.post('/auth.test');
      if (response.data.ok) {
        logger.info('Slack channel initialized', { user_id: response.data.user_id });
      } else {
        throw new Error(`Slack auth failed: ${response.data.error}`);
      }
    } catch (error) {
      logger.error('Failed to initialize Slack channel', error);
      throw error;
    }
  }

  /**
   * Start listening for messages (via webhook)
   */
  async start(): Promise<void> {
    try {
      this.connected = true;
      logger.info('Slack channel started (webhook mode)');
    } catch (error) {
      logger.error('Failed to start Slack channel', error);
      throw error;
    }
  }

  /**
   * Stop listening for messages
   */
  async stop(): Promise<void> {
    try {
      this.connected = false;
      logger.info('Slack channel stopped');
    } catch (error) {
      logger.error('Failed to stop Slack channel', error);
      throw error;
    }
  }

  /**
   * Send a message through Slack
   */
  async sendMessage(
    userId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      const channelId = metadata?.channelId as string || userId;
      const threadTs = metadata?.threadTs as string;

      const payload: Record<string, unknown> = {
        channel: channelId,
        text: content,
      };

      if (threadTs) {
        payload.thread_ts = threadTs;
      }

      const response = await this.client.post('/chat.postMessage', payload);

      if (!response.data.ok) {
        throw new Error(`Slack API error: ${response.data.error}`);
      }

      logger.debug(`Sent message to Slack channel: ${channelId}`);
    } catch (error) {
      logger.error('Failed to send Slack message', error);
      throw error;
    }
  }

  /**
   * Check if channel is connected
   */
  protected isConnected(): boolean {
    return this.connected;
  }

  /**
   * Handle incoming Slack event (called from gateway)
   */
  handleSlackEvent(envelope: SlackEnvelope): void {
    // Handle URL verification challenge
    if (envelope.challenge) {
      logger.debug('Slack challenge received');
      return;
    }

    const event = envelope.event;

    // Only handle message events
    if (event.type !== 'message' || !event.text || !event.user || !event.channel) {
      return;
    }

    // Ignore bot messages
    if (event.user === 'USLACKBOT' || event.user?.startsWith('B')) {
      return;
    }

    // Create channel message
    const channelMessage: ChannelMessage = {
      id: generateId(),
      sessionId: `slack-${event.channel}-${event.user}`,
      userId: event.user,
      content: event.text,
      channelType: 'slack',
      timestamp: new Date(parseInt(event.ts || '0') * 1000),
      metadata: {
        channelId: event.channel,
        threadTs: event.thread_ts,
        eventId: envelope.event_id,
      },
    };

    // Emit the message
    this.emitMessage(channelMessage);
  }
}
