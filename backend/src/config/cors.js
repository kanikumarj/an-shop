/**
 * config/cors.js
 * ===============
 * Environment-aware CORS configuration.
 */

'use strict';

const logger = require('../utils/logger');

const getAllowedOrigins = () => {
  const origins = process.env.ALLOWED_ORIGINS || '';
  return origins.split(',').map((o) => o.trim()).filter(Boolean);
};

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();

    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return callback(null, true);

    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    logger.warn('⚠️ CORS blocked request from:', { origin });
    callback(new Error(`Origin ${origin} not allowed by CORS policy`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-API-Key',
    'X-Request-ID',
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count', 'X-Current-Page'],
  maxAge: 86400, // 24 hours preflight cache
};

module.exports = corsOptions;
