/**
 * config/database.js
 * ==================
 * Prisma client singleton with connection pooling and logging.
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

// ─── Prisma Singleton ─────────────────────────────────────────────────────────
const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'info', emit: 'event' },
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
  errorFormat: process.env.NODE_ENV === 'production' ? 'minimal' : 'pretty',
});

// ─── Query Logging (Development only) ────────────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    logger.debug('📦 Prisma Query', {
      query: e.query,
      params: e.params,
      duration: `${e.duration}ms`,
    });
  });
}

prisma.$on('warn', (e) => logger.warn('⚠️ Prisma Warning:', e));
prisma.$on('error', (e) => logger.error('❌ Prisma Error:', e));

// ─── Connection Function ───────────────────────────────────────────────────────
const connectDatabase = async () => {
  try {
    await prisma.$connect();
    // Verify connection with a lightweight query
    await prisma.$queryRaw`SELECT 1`;
    logger.info('✅ PostgreSQL database connected successfully');
  } catch (error) {
    logger.error('❌ Failed to connect to PostgreSQL:', {
      error: error.message,
      hint: 'Check DATABASE_URL in your .env file',
    });
    throw error;
  }
};

// ─── Transaction Helper ───────────────────────────────────────────────────────
const withTransaction = async (callback) => {
  return prisma.$transaction(callback, {
    maxWait: 5000,   // 5s max wait
    timeout: 10000,  // 10s timeout
  });
};

module.exports = { prisma, connectDatabase, withTransaction };
