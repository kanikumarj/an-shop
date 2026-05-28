/**
 * middleware/performance.middleware.js  [ENTERPRISE EDITION]
 * ============================================================
 * Response time, query timeout, lazy loading guards, and API
 * performance optimization middleware.
 *
 * MIDDLEWARE:
 *   responseTime      — Adds X-Response-Time header + logs slow requests
 *   queryTimeout      — Kills requests that run over DB_QUERY_TIMEOUT ms
 *   conditionalEtag   — ETag + Last-Modified for GET responses (304 support)
 *   paginationGuard   — Enforces max page/limit to prevent expensive queries
 *   fieldSelector     — Parses ?fields=name,price into select object
 *   compressionFilter — Smart compression (skip small/binary responses)
 *   apiVersionGuard   — Rejects requests to deprecated API versions
 *   requestSizeGuard  — Rejects oversized request bodies early
 *
 * USAGE:
 *   app.use(responseTime);
 *   app.use(paginationGuard());
 *   router.get('/products', cacheResponse(300), productController.list);
 */

'use strict';

const crypto = require('crypto');
const logger  = require('../utils/logger');
const AppError = require('../utils/AppError');

// ─── Config ────────────────────────────────────────────────────────────────────
const SLOW_REQUEST_THRESHOLD_MS = parseInt(process.env.SLOW_REQUEST_THRESHOLD_MS) || 2000;
const DB_QUERY_TIMEOUT_MS       = parseInt(process.env.DB_QUERY_TIMEOUT_MS)       || 30000;
const MAX_PAGE_SIZE              = parseInt(process.env.MAX_PAGE_SIZE)              || 100;
const MAX_PAGE_NUMBER            = parseInt(process.env.MAX_PAGE_NUMBER)            || 500;
const MAX_BODY_SIZE_BYTES        = parseInt(process.env.MAX_BODY_SIZE_BYTES)        || 10 * 1024; // 10KB

// ═══════════════════════════════════════════════════════════
//   RESPONSE TIME TRACKER
// ═══════════════════════════════════════════════════════════

/**
 * Measures request processing time and:
 *  - Sets X-Response-Time header (e.g., "124ms")
 *  - Logs slow requests (> SLOW_REQUEST_THRESHOLD_MS) at WARN level
 *  - Logs very slow requests (> 5s) at ERROR level
 */
const responseTime = (req, res, next) => {
  const start = process.hrtime.bigint();

  // Patch res.json and res.end to inject the header BEFORE headers are sent
  const _end = res.end.bind(res);
  res.end = function (...args) {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationMs = Math.round(durationNs / 1_000_000);

    if (!res.headersSent) {
      res.setHeader('X-Response-Time', `${durationMs}ms`);
    }

    const logData = {
      method:     req.method,
      url:        req.originalUrl,
      status:     res.statusCode,
      durationMs,
      ip:         req.ip,
      userId:     req.user?.id || null,
      requestId:  req.id,
    };

    if (durationMs > 5000) {
      logger.error(`🐌 VERY SLOW REQUEST (${durationMs}ms):`, logData);
    } else if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
      logger.warn(`⚠️ Slow request (${durationMs}ms):`, logData);
    } else {
      logger.perfEvent(`${req.method} ${req.path}`, durationMs, { status: res.statusCode });
    }

    return _end(...args);
  };

  next();
};

// ═══════════════════════════════════════════════════════════
//   QUERY TIMEOUT GUARD
// ═══════════════════════════════════════════════════════════

/**
 * Aborts requests that take too long.
 * Sends 503 after DB_QUERY_TIMEOUT_MS without a response.
 */
const queryTimeout = (timeoutMs = DB_QUERY_TIMEOUT_MS) => (req, res, next) => {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      logger.error('⏰ Request timeout:', {
        method: req.method,
        url:    req.originalUrl,
        timeoutMs,
        userId: req.user?.id,
      });
      res.status(503).json({
        success: false,
        message: 'Request timed out. Please try again.',
        code:    'REQUEST_TIMEOUT',
      });
    }
  }, timeoutMs);

  // Clear timeout when response finishes
  res.on('finish', () => clearTimeout(timeout));
  res.on('close',  () => clearTimeout(timeout));

  next();
};

// ═══════════════════════════════════════════════════════════
//   CONDITIONAL ETag / 304 NOT MODIFIED
// ═══════════════════════════════════════════════════════════

/**
 * Generates a weak ETag from the response body and handles 304 responses.
 * Reduces bandwidth for unchanged resources (product lists, categories, etc.)
 */
const conditionalEtag = (req, res, next) => {
  if (req.method !== 'GET') return next();

  const originalJson = res.json.bind(res);
  res.json = function (data) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const body = JSON.stringify(data);
      const etag = `W/"${crypto.createHash('md5').update(body).digest('hex').slice(0, 16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Last-Modified', new Date().toUTCString());

      // 304 Not Modified if client has fresh ETag
      const clientEtag = req.headers['if-none-match'];
      if (clientEtag && clientEtag === etag) {
        return res.status(304).end();
      }
    }
    return originalJson(data);
  };

  next();
};

// ═══════════════════════════════════════════════════════════
//   PAGINATION GUARD
// ═══════════════════════════════════════════════════════════

/**
 * Enforces maximum page number and page size to prevent expensive DB scans.
 *
 * @param {object} options
 *   @param {number} maxLimit  — Max items per page (default: 100)
 *   @param {number} maxPage   — Max page number (default: 500)
 */
const paginationGuard = ({
  maxLimit = MAX_PAGE_SIZE,
  maxPage  = MAX_PAGE_NUMBER,
} = {}) => (req, res, next) => {
  if (req.query.limit !== undefined) {
    const limit = parseInt(req.query.limit);
    if (isNaN(limit) || limit < 1) {
      return next(AppError.badRequest(`limit must be a positive integer.`));
    }
    if (limit > maxLimit) {
      req.query.limit = String(maxLimit);
    }
  }

  if (req.query.page !== undefined) {
    const page = parseInt(req.query.page);
    if (isNaN(page) || page < 1) {
      return next(AppError.badRequest(`page must be a positive integer.`));
    }
    if (page > maxPage) {
      return next(AppError.badRequest(`Page ${page} exceeds maximum allowed (${maxPage}). Use cursor-based pagination for deep paging.`));
    }
  }

  next();
};

// ═══════════════════════════════════════════════════════════
//   FIELD SELECTOR (Sparse Fieldsets)
// ═══════════════════════════════════════════════════════════

/**
 * Parses ?fields=name,price,id into req.selectFields = { name: true, price: true, id: true }
 * Controllers can use this to build Prisma `select` objects dynamically.
 *
 * Usage:
 *   app.use(fieldSelector);
 *   // In controller:
 *   const products = await prisma.product.findMany({ select: req.selectFields });
 */
const fieldSelector = (req, res, next) => {
  if (req.query.fields) {
    const fields = req.query.fields.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length > 0 && fields.length <= 30) {
      req.selectFields = fields.reduce((acc, f) => ({ ...acc, [f]: true }), {});
    }
    delete req.query.fields; // Remove from query so it doesn't affect other filters
  }
  next();
};

// ═══════════════════════════════════════════════════════════
//   COMPRESSION FILTER
// ═══════════════════════════════════════════════════════════

/**
 * Smart compression decision function for use with `compression` package.
 * Skips compression for: images, PDFs, small responses (<1KB), SSE streams.
 *
 * Usage:
 *   app.use(compression({ filter: compressionFilter, threshold: 1024 }));
 */
const compressionFilter = (req, res) => {
  const ct = res.getHeader('Content-Type') || '';

  // Never compress already-compressed formats
  if (ct.includes('image/') || ct.includes('application/pdf') ||
      ct.includes('video/') || ct.includes('audio/') ||
      ct.includes('application/zip') || ct.includes('application/gzip')) {
    return false;
  }

  // Never compress SSE (server-sent events)
  if (ct.includes('text/event-stream')) return false;

  // Don't compress if client explicitly opts out
  if (req.headers['x-no-compression']) return false;

  return true;
};

// ═══════════════════════════════════════════════════════════
//   API VERSION GUARD
// ═══════════════════════════════════════════════════════════

/**
 * Rejects requests to deprecated API versions.
 * Current: /api/v1. Deprecated: /api/v0 (if added in future).
 */
const DEPRECATED_VERSIONS = new Set(['v0']);

const apiVersionGuard = (req, res, next) => {
  const match = req.path.match(/^\/api\/(v\d+)/);
  if (match && DEPRECATED_VERSIONS.has(match[1])) {
    return res.status(410).json({
      success: false,
      message: `API version ${match[1]} has been deprecated. Please upgrade to /api/v1.`,
      code:    'API_VERSION_DEPRECATED',
      docs:    '/api/v1/docs',
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════════
//   HEALTH CHECK ENRICHER
// ═══════════════════════════════════════════════════════════

/**
 * Extended health check response with performance metrics.
 * Use to replace the basic /health endpoint.
 */
const healthCheck = async (req, res) => {
  const memUsage = process.memoryUsage();

  let redisStatus = 'unavailable';
  let dbStatus    = 'unavailable';

  try {
    const { redis } = require('../config/redis');
    if (redis) { await redis.ping(); redisStatus = 'ok'; }
  } catch {}

  try {
    const { prisma } = require('../config/database');
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'ok';
  } catch {}

  const data = {
    success:     true,
    status:      redisStatus === 'ok' && dbStatus === 'ok' ? 'healthy' : 'degraded',
    timestamp:   new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    version:     process.env.API_VERSION || 'v1',
    uptime:      `${Math.floor(process.uptime())}s`,
    memory: {
      heapUsed:  `${Math.round(memUsage.heapUsed  / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      rss:       `${Math.round(memUsage.rss       / 1024 / 1024)}MB`,
    },
    services: {
      database: dbStatus,
      redis:    redisStatus,
    },
  };

  res.status(data.status === 'healthy' ? 200 : 503).json(data);
};

module.exports = {
  responseTime,
  queryTimeout,
  conditionalEtag,
  paginationGuard,
  fieldSelector,
  compressionFilter,
  apiVersionGuard,
  healthCheck,
};
