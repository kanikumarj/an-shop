/**
 * middleware/cache.middleware.js  [ENTERPRISE EDITION]
 * ======================================================
 * Redis HTTP response caching + cache invalidation helpers.
 *
 * FEATURES:
 *   - cacheResponse(ttl)  — Caches GET response in Redis by URL + user
 *   - invalidateCache(...patterns) — Invalidate by key pattern after writes
 *   - cacheByRole(ttl)    — TTL varies by user role (admin gets shorter cache)
 *   - noCacheHeaders      — Forces no-cache on sensitive endpoints
 *   - cacheStats          — GET /admin/cache/stats endpoint helper
 *   - warmCache(fn, key, ttl) — Pre-warm a cache key manually
 *
 * CACHE KEY FORMAT:
 *   cache:GET:/api/v1/products?page=1:public              (public)
 *   cache:GET:/api/v1/cart:user:{userId}                  (user-specific)
 *   cache:GET:/api/v1/admin/dashboard:admin               (admin)
 *
 * USAGE:
 *   // Cache public product list for 5 min:
 *   router.get('/products', cacheResponse(300), productController.list);
 *
 *   // Invalidate after a product is updated:
 *   router.put('/products/:id', productController.update, invalidateCache('products:*', 'product:*'));
 */

'use strict';

const logger = require('../utils/logger');

// ─── Cache key builder ─────────────────────────────────────────────────────────
const buildCacheKey = (req) => {
  const url     = req.originalUrl || req.url;
  const userId  = req.user?.id || 'public';
  const role    = req.user?.role || 'public';

  // Strip auth-specific parts for shared caches, keep userId for private
  const userSegment = userId !== 'public'
    ? (role === 'CUSTOMER' ? `user:${userId}` : role.toLowerCase())
    : 'public';

  return `cache:${req.method}:${url}:${userSegment}`;
};

// ─── Get Redis safely ─────────────────────────────────────────────────────────
const getRedis = () => {
  try {
    const { cache } = require('../config/redis');
    return cache;
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════
//   CACHE RESPONSE (main caching middleware)
// ═══════════════════════════════════════════════════════════

/**
 * Caches successful (2xx) JSON GET responses in Redis.
 *
 * @param {number} ttlSeconds  — Cache lifetime in seconds (default: 300)
 * @param {object} options
 *   @param {boolean} options.userSpecific — Separate cache per user (default: true for auth routes)
 *   @param {boolean} options.adminSkip    — Skip caching for admin users (default: true)
 *   @param {string}  options.keyPrefix    — Custom key prefix
 */
const cacheResponse = (ttlSeconds = 300, options = {}) => async (req, res, next) => {
  // Only cache GET requests
  if (req.method !== 'GET') return next();

  const {
    adminSkip   = true,
    keyPrefix   = null,
  } = options;

  // Skip caching for admin users by default (they need fresh data)
  if (adminSkip && req.user?.role && ['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
    return next();
  }

  const cache = getRedis();
  if (!cache) return next();

  const key = keyPrefix ? `${keyPrefix}:${req.originalUrl}` : buildCacheKey(req);

  try {
    const cached = await cache.get(key);
    if (cached) {
      logger.debug(`⚡ Cache HIT: ${key}`);
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', key);
      return res.status(200).json({
        ...cached,
        _cached: true,
        _cachedAt: cached._cachedAt,
      });
    }
  } catch (err) {
    logger.warn('⚠️ Cache GET error:', { error: err.message, key });
    return next(); // Fail open — never block request on cache error
  }

  // Override res.json to intercept and cache the response
  const originalJson = res.json.bind(res);
  res.json = function (data) {
    // Only cache successful responses
    if (res.statusCode >= 200 && res.statusCode < 300 && data?.success !== false) {
      const toCache = { ...data, _cached: true, _cachedAt: new Date().toISOString() };
      cache.set(key, toCache, ttlSeconds).catch((e) =>
        logger.warn('⚠️ Cache SET error:', { error: e.message, key })
      );
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-TTL', ttlSeconds);
    }
    return originalJson(data);
  };

  next();
};

// ═══════════════════════════════════════════════════════════
//   INVALIDATE CACHE (after writes)
// ═══════════════════════════════════════════════════════════

/**
 * Middleware factory — invalidates Redis keys matching given patterns.
 * Call AFTER a write operation completes.
 *
 * @param {...string} patterns — Glob patterns, e.g. 'products:*', 'cache:GET:/api/v1/products*'
 *
 * Usage:
 *   router.post('/products', protect, invalidateCache('products:*', 'cache:GET:*products*'), ctrl.create);
 */
const invalidateCache = (...patterns) => async (req, res, next) => {
  const cache = getRedis();

  if (cache && patterns.length > 0) {
    setImmediate(async () => {
      for (const pattern of patterns) {
        try {
          await cache.delPattern(pattern);
          logger.debug(`🗑️ Cache invalidated: ${pattern}`);
        } catch (err) {
          logger.warn('⚠️ Cache invalidation error:', { error: err.message, pattern });
        }
      }
    });
  }

  next();
};

// ═══════════════════════════════════════════════════════════
//   ROLE-AWARE CACHING
// ═══════════════════════════════════════════════════════════

/**
 * Different TTLs by role. Use on routes that serve different data per role.
 *
 * @param {object} ttlByRole — e.g. { public: 600, CUSTOMER: 300, ADMIN: 30 }
 */
const cacheByRole = (ttlByRole = { public: 600, CUSTOMER: 300, ADMIN: 30 }) =>
  (req, res, next) => {
    const role = req.user?.role || 'public';
    const ttl  = ttlByRole[role] ?? ttlByRole.public ?? 300;
    return cacheResponse(ttl)(req, res, next);
  };

// ═══════════════════════════════════════════════════════════
//   NO CACHE HEADERS
// ═══════════════════════════════════════════════════════════

/**
 * Prevents browser/CDN caching on sensitive endpoints.
 * Apply to: /auth/*, /orders/*, /cart/*, /payments/*
 */
const noCacheHeaders = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

// ═══════════════════════════════════════════════════════════
//   WARM CACHE (manual pre-warming)
// ═══════════════════════════════════════════════════════════

/**
 * Pre-populate a cache key by running a data-fetching function.
 * Call from server startup or cron jobs.
 *
 * @param {string}   key       — Redis cache key
 * @param {Function} fetchFn   — Async function returning the data
 * @param {number}   ttl       — TTL in seconds
 */
const warmCache = async (key, fetchFn, ttl = 600) => {
  const cache = getRedis();
  if (!cache) return;

  try {
    const data = await fetchFn();
    await cache.set(key, { ...data, _cached: true, _cachedAt: new Date().toISOString() }, ttl);
    logger.info(`🔥 Cache warmed: ${key} (TTL: ${ttl}s)`);
    return data;
  } catch (err) {
    logger.warn('⚠️ Cache warm failed:', { key, error: err.message });
    return null;
  }
};

// ═══════════════════════════════════════════════════════════
//   CACHE STATS HELPER (admin endpoint)
// ═══════════════════════════════════════════════════════════

/**
 * Returns Redis cache statistics.
 * Usage: router.get('/admin/cache/stats', protect, adminOnly, cacheStats)
 */
const cacheStats = async (req, res) => {
  try {
    const { redis } = require('../config/redis');
    if (!redis) {
      return res.json({ success: true, data: { status: 'Redis not connected' } });
    }

    const info    = await redis.info('stats');
    const memory  = await redis.info('memory');
    const keyCount= await redis.dbsize();

    // Parse relevant info sections
    const parseInfo = (str) => {
      const result = {};
      str.split('\n').forEach((line) => {
        const [k, v] = line.split(':');
        if (k && v) result[k.trim()] = v.trim();
      });
      return result;
    };

    const statsInfo = parseInfo(info);
    const memInfo   = parseInfo(memory);

    res.json({
      success: true,
      data: {
        keyCount,
        hits:           parseInt(statsInfo.keyspace_hits      || 0),
        misses:         parseInt(statsInfo.keyspace_misses    || 0),
        hitRate:        statsInfo.keyspace_hits && statsInfo.keyspace_misses
          ? ((statsInfo.keyspace_hits / (parseInt(statsInfo.keyspace_hits) + parseInt(statsInfo.keyspace_misses))) * 100).toFixed(1) + '%'
          : 'N/A',
        evictedKeys:    parseInt(statsInfo.evicted_keys || 0),
        usedMemory:     memInfo.used_memory_human,
        maxMemory:      memInfo.maxmemory_human || 'unlimited',
        connectedClients: parseInt(statsInfo.connected_clients || 0),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  cacheResponse,
  invalidateCache,
  cacheByRole,
  noCacheHeaders,
  warmCache,
  cacheStats,
  buildCacheKey,
};
