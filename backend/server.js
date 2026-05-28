/**
 * server.js - Application Entry Point
 * =====================================
 * Bootstraps the Express server, connects to databases,
 * initializes WebSocket, starts cron jobs.
 */

'use strict';

// ─── Load Environment Variables First ─────────────────────────────────────────
require('dotenv').config();

// ─── Core Imports ─────────────────────────────────────────────────────────────
const http = require('http');
const app = require('./src/app');
const logger = require('./src/utils/logger');
const { connectDatabase } = require('./src/config/database');
const { connectRedis } = require('./src/config/redis');
const { initializeWebSocket } = require('./src/websocket/socket');
const { startCronJobs } = require('./src/jobs/cronJobs');
const { initWhatsAppJobs } = require('./src/jobs/whatsapp.jobs');

// ─── Unhandled Rejection Safety Net ───────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('💥 UNCAUGHT EXCEPTION - Shutting down...', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

// ─── Server Bootstrap ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const server = http.createServer(app);

/**
 * Graceful shutdown handler
 * Closes all connections cleanly before exiting
 */
const gracefulShutdown = (signal) => {
  logger.info(`📴 ${signal} received. Starting graceful shutdown...`);

  server.close(async () => {
    logger.info('✅ HTTP server closed');

    try {
      // Disconnect Prisma
      const { prisma } = require('./src/config/database');
      await prisma.$disconnect();
      logger.info('✅ Database disconnected');

      // Disconnect Redis
      const { redis } = require('./src/config/redis');
      await redis.quit();
      logger.info('✅ Redis disconnected');

      logger.info('✅ Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('❌ Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force shutdown after 30s
  setTimeout(() => {
    logger.error('⏰ Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start Server ─────────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    // 1. Connect to PostgreSQL via Prisma (required)
    await connectDatabase();
    logger.info('✅ PostgreSQL connected via Prisma');

    // 2. Connect to Redis (optional — app works without it)
    try {
      await connectRedis();
      logger.info('✅ Redis connected');
    } catch (err) {
      logger.warn('⚠️ Redis unavailable — running without cache:', { error: err.message });
    }

    // 3. Initialize WebSocket (optional)
    try {
      initializeWebSocket(server);
      logger.info('✅ WebSocket server initialized');
    } catch (err) {
      logger.warn('⚠️ WebSocket init failed:', { error: err.message });
    }

    // 4. Start background cron jobs
    try {
      startCronJobs();
      logger.info('✅ Cron jobs started');
    } catch (err) {
      logger.warn('⚠️ Cron jobs failed to start:', { error: err.message });
    }

    // 5. Start WhatsApp notification jobs (optional)
    try {
      initWhatsAppJobs();
      logger.info('✅ WhatsApp notification jobs started');
    } catch (err) {
      logger.warn('⚠️ WhatsApp jobs failed to start:', { error: err.message });
    }

    // 6. Start HTTP server
    server.listen(PORT, () => {
      logger.info('');
      logger.info('╔══════════════════════════════════════════════╗');
      logger.info('║         🛍️  AN SHOP API SERVER               ║');
      logger.info('╠══════════════════════════════════════════════╣');
      logger.info(`║  Environment : ${NODE_ENV.padEnd(28)}║`);
      logger.info(`║  Port        : ${String(PORT).padEnd(28)}║`);
      logger.info(`║  API         : /api/v1${' '.repeat(23)}║`);
      logger.info(`║  Health      : /api/v1/health${' '.repeat(16)}║`);
      logger.info(`║  Docs        : /api/v1/docs${' '.repeat(18)}║`);
      logger.info('╚══════════════════════════════════════════════╝');
      logger.info('');
    });

  } catch (err) {
    logger.error('❌ Failed to start server:', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
};

// ─── Handle Unhandled Promise Rejections ──────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 UNHANDLED REJECTION - Shutting down...', {
    reason: reason?.message || reason,
    promise,
  });
  server.close(() => process.exit(1));
});

startServer();
