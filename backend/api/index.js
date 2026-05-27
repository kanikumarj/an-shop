'use strict';

/**
 * api/index.js
 * ============
 * Vercel Serverless Function Entry Point.
 * Lazily initializes database and cache connections for cold starts
 * and routes all traffic to the main Express application.
 */

// Load environment variables
require('dotenv').config();

const app = require('../src/app');
const { connectDatabase } = require('../src/config/database');
const { connectRedis } = require('../src/config/redis');
const logger = require('../src/utils/logger');

let initialized = false;

/**
 * Serverless initializations. Runs once per serverless execution context boot.
 */
const initializeServerless = async () => {
  if (initialized) return;

  try {
    // 1. Connect to PostgreSQL database via Prisma Client
    await connectDatabase();
    logger.info('✅ PostgreSQL connected (Serverless Context)');

    // 2. Connect to Redis (Upstash or hosted Redis recommended for serverless)
    await connectRedis();
    logger.info('✅ Redis initialized (Serverless Context)');

    initialized = true;
  } catch (err) {
    logger.error('❌ Serverless context initialization failed:', err);
    // Don't crash the serverless container, let subsequent requests retry or fail gracefully
  }
};

// Vercel Serverless Function Handler
module.exports = async (req, res) => {
  // Ensure database and caching are connected before routing request
  await initializeServerless();

  // Hand over routing and handling to Express app
  return app(req, res);
};
