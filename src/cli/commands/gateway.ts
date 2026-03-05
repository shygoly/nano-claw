/**
 * Gateway command - Start gateway server
 */

import chalk from 'chalk';
import { getGateway } from '../../gateway';
import { logger } from '../../utils/logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface ChannelStatus {
  enabled: boolean;
  connected: boolean;
}

interface HeartbeatStatus {
  enabled: boolean;
  interval: number;
  running: boolean;
}

interface GatewayStatus {
  channels: Record<string, ChannelStatus>;
  heartbeat?: HeartbeatStatus;
}

interface GatewayOptions {
  foreground?: boolean;
  pidFile?: string;
}

/**
 * Write PID file for process management
 */
function writePidFile(pidFile: string): void {
  try {
    const dir = path.dirname(pidFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch (error) {
    logger.warn({ err: error }, 'Failed to write PID file');
  }
}

/**
 * Remove PID file on shutdown
 */
function removePidFile(pidFile: string): void {
  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch (error) {
    logger.warn({ err: error }, 'Failed to remove PID file');
  }
}

export async function gatewayCommand(options?: GatewayOptions): Promise<void> {
  const foreground = options?.foreground ?? true;
  const pidFile = options?.pidFile ?? path.join(os.homedir(), '.nano-claw', 'gateway.pid');

  console.log(chalk.blue('Starting gateway server...'));

  const gateway = getGateway();
  let isShuttingDown = false;

  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(chalk.yellow('\nShutting down gateway...'));
    await gateway.stop();
    removePidFile(pidFile);
    process.exit(0);
  };

  // Handle signals
  ['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) =>
    process.on(signal, () =>
      shutdown().catch((e) => {
        logger.error({ err: e }, 'Shutdown failed');
        process.exit(1);
      })
    )
  );

  // Handle uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'Uncaught exception');
    shutdown().catch(() => process.exit(1));
  });

  try {
    await gateway.start();

    // Write PID file
    writePidFile(pidFile);

    console.log(chalk.green('✓ Gateway server started successfully'));
    if (foreground) {
      console.log(chalk.gray('Press Ctrl+C to stop\n'));
    }

    // Get initial status
    const status = gateway.getStatus() as GatewayStatus;
    logger.debug({ status }, 'Gateway status after start');

    // Display channel statuses
    const enabledChannels = Object.entries(status.channels).filter(
      ([, channelStatus]) => channelStatus.enabled
    );

    if (enabledChannels.length === 0) {
      console.log(chalk.yellow('⚠ No channels are enabled'));
      console.log(chalk.gray('Configure channels in ~/.nano-claw/config.json to enable them\n'));
    } else {
      console.log(chalk.bold('Active Channels:'));
      for (const [channelType, channelStatus] of enabledChannels) {
        const statusIcon = channelStatus.connected ? '✓' : '✗';
        const statusColor = channelStatus.connected ? chalk.green : chalk.red;
        console.log(
          `  ${statusColor(statusIcon)} ${channelType}: ${channelStatus.connected ? 'connected' : 'disconnected'}`
        );
      }
      console.log();
    }

    // Display heartbeat status if enabled
    if (status.heartbeat && status.heartbeat.enabled) {
      console.log(chalk.bold('Heartbeat:'));
      console.log(`  Interval: ${status.heartbeat.interval}ms`);
      console.log(`  Status: ${status.heartbeat.running ? 'running' : 'stopped'}\n`);
    }

    // Keep the process running indefinitely
    await new Promise<never>(() => {
      // This will keep running until SIGINT/SIGTERM
    });
  } catch (error) {
    logger.error({ err: error }, 'Gateway failed to start');
    console.error(chalk.red(`Error: ${(error as Error).message}`));
    removePidFile(pidFile);
    process.exit(1);
  }
}
