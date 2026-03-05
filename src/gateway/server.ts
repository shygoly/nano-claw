/**
 * Gateway Server
 * Central server for managing channels and message routing
 */

import { getChannelManager } from '../channels';
import { TelegramChannel } from '../channels/telegram';
import { DiscordChannel } from '../channels/discord';
import { DingTalkChannel } from '../channels/dingtalk';
import { SlackChannel } from '../channels/slack';
import { getMessageBus } from '../bus';
import { getSessionManager } from '../session';
import { initializeHeartbeat } from '../heartbeat';
import { AgentLoop } from '../agent/loop';
import { logger } from '../utils/logger';
import { getConfig } from '../config';
import { ChannelMessage } from '../types';
import * as http from 'http';

export class GatewayServer {
  private channelManager: ReturnType<typeof getChannelManager>;
  private messageBus: ReturnType<typeof getMessageBus>;
  private heartbeat: ReturnType<typeof initializeHeartbeat> | null;
  private isRunning: boolean;
  private httpServer: http.Server | null;
  private webhookPort: number;

  constructor(webhookPort: number = 3000) {
    this.channelManager = getChannelManager();
    this.messageBus = getMessageBus();
    this.heartbeat = null;
    this.isRunning = false;
    this.httpServer = null;
    this.webhookPort = webhookPort;
  }

  /**
   * Initialize the gateway
   */
  async initialize(): Promise<void> {
    logger.info('Initializing gateway server...');

    // Initialize session manager
    void getSessionManager();
    logger.info('Session manager initialized');

    // Load configuration
    const config = getConfig();

    // Register available channels
    await this.registerChannels(config);

    // Subscribe to all messages from the bus
    this.messageBus.subscribeAll(async (message: ChannelMessage) => {
      await this.handleMessage(message);
    });

    // Initialize heartbeat if configured
    if (config.agents?.defaults?.systemPrompt) {
      this.heartbeat = initializeHeartbeat({
        enabled: false,
        interval: 60000,
        onBeat: async () => logger.debug('Heartbeat tick'),
      });
    }

    logger.info('Gateway initialized');
  }

  /**
   * Register available channels
   */
  private async registerChannels(config: ReturnType<typeof getConfig>): Promise<void> {
    // Register Telegram channel if configured
    if (config.channels?.telegram) {
      const telegramChannel = new TelegramChannel(config.channels.telegram);
      await telegramChannel.initialize();
      this.channelManager.registerChannel(telegramChannel);
      logger.info('Telegram channel registered');
    }

    // Register Discord channel if configured
    if (config.channels?.discord) {
      const discordChannel = new DiscordChannel(config.channels.discord);
      await discordChannel.initialize();
      this.channelManager.registerChannel(discordChannel);
      logger.info('Discord channel registered');
    }

    // Register DingTalk channel if configured
    if (config.channels?.dingtalk) {
      const dingtalkChannel = new DingTalkChannel(config.channels.dingtalk);
      await dingtalkChannel.initialize();
      this.channelManager.registerChannel(dingtalkChannel);
      logger.info('DingTalk channel registered');
    }

    // Register Slack channel if configured
    if (config.channels?.slack) {
      const slackChannel = new SlackChannel(config.channels.slack);
      await slackChannel.initialize();
      this.channelManager.registerChannel(slackChannel);
      logger.info('Slack channel registered');
    }

    // Add more channels here as they are implemented
  }

  /**
   * Start the gateway
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Gateway is already running');
      return;
    }

    await this.initialize();

    // Start HTTP server for webhooks
    this.startWebhookServer();

    // Start all enabled channels
    await this.channelManager.startAll();

    // Start heartbeat if configured
    if (this.heartbeat) {
      this.heartbeat.start();
    }

    this.isRunning = true;
    logger.info('Gateway server started successfully');
  }

  /**
   * Stop the gateway
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Gateway is not running');
      return;
    }

    logger.info('Stopping gateway server...');

    // Stop HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => {
          logger.info('Webhook server stopped');
          resolve();
        });
      });
    }

    // Stop heartbeat
    if (this.heartbeat) {
      this.heartbeat.stop();
    }

    // Stop all channels
    await this.channelManager.stopAll();

    // Clear message bus handlers
    this.messageBus.clear();

    this.isRunning = false;
    logger.info('Gateway server stopped');
  }

  /**
   * Start webhook HTTP server for receiving events
   */
  private startWebhookServer(): void {
    this.httpServer = http.createServer(async (req, res) => {
      // Handle Slack events
      if (req.url === '/slack/events' && req.method === 'POST') {
        let body = '';

        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', async () => {
          try {
            const event = JSON.parse(body);

            // Handle URL verification challenge
            if (event.challenge) {
              res.writeHead(200, { 'Content-Type': 'text/plain' });
              res.end(event.challenge);
              return;
            }

            // Forward to Slack channel
            const slackChannel = this.channelManager.getChannel('slack') as SlackChannel;
            if (slackChannel) {
              slackChannel.handleSlackEvent(event);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            logger.error('Error processing webhook', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
          }
        });

        return;
      }

      // Health check endpoint
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', running: this.isRunning }));
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.httpServer.listen(this.webhookPort, () => {
      logger.info(`Webhook server listening on port ${this.webhookPort}`);
    });

    this.httpServer.on('error', (error) => {
      logger.error('Webhook server error', error);
    });
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(message: ChannelMessage): Promise<void> {
    logger.info(`Handling message from ${message.channelType} (user: ${message.userId})`);

    try {
      // Get or create session
      const sessionManager = await getSessionManager();
      await sessionManager.getOrCreateSession(
        message.sessionId,
        message.userId,
        message.channelType
      );

      // Get config
      const config = getConfig();

      // Create agent loop for this session and message
      const agentLoop = new AgentLoop(message.sessionId, config);

      // Process the message
      const result = await agentLoop.processMessage(message.content);

      // Send response back through the channel
      await this.channelManager.sendMessage(
        message.channelType,
        message.userId,
        result.content,
        message.metadata
      );

      logger.info(`Response sent to ${message.userId} via ${message.channelType}`);
    } catch (error) {
      logger.error('Error handling message', error);

      // Try to send error message back to user
      try {
        await this.channelManager.sendMessage(
          message.channelType,
          message.userId,
          'Sorry, I encountered an error processing your message. Please try again.',
          message.metadata
        );
      } catch (sendError) {
        logger.error('Failed to send error message', sendError);
      }
    }
  }

  /**
   * Get gateway status
   */
  getStatus(): {
    running: boolean;
    channels: Record<string, unknown>;
    heartbeat: unknown;
  } {
    return {
      running: this.isRunning,
      channels: this.channelManager.getAllChannelStatuses(),
      heartbeat: this.heartbeat ? this.heartbeat.getStatus() : null,
    };
  }
}

// Singleton instance
let gateway: GatewayServer | null = null;

export function getGateway(): GatewayServer {
  if (!gateway) {
    gateway = new GatewayServer();
  }
  return gateway;
}
