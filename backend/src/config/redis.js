/**
 * config/redis.js
 * ================
 * Redis client with retry strategy and connection management.
 */

'use strict';

const Redis = require('ioredis');
const logger = require('../utils/logger');

let redis = null;

// ─── Redis Client Factory ─────────────────────────────────────────────────────
const createRedisClient = () => {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 10000,
    commandTimeout: 5000,
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('❌ Redis max retries exceeded - giving up');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 100, 3000);
      logger.warn(`⚠️ Redis retry attempt ${times}, waiting ${delay}ms`);
      return delay;
    },
    reconnectOnError: (err) => {
      const targetErrors = ['READONLY', 'ECONNRESET', 'ENOTFOUND'];
      return targetErrors.some((e) => err.message.includes(e));
    },
  });

  client.on('connect', () => logger.info('🔗 Redis connecting...'));
  client.on('ready', () => logger.info('✅ Redis ready'));
  client.on('error', (err) => logger.error('❌ Redis error:', { message: err.message }));
  client.on('close', () => logger.warn('⚠️ Redis connection closed'));
  client.on('reconnecting', () => logger.info('🔄 Redis reconnecting...'));
  client.on('end', () => logger.info('📴 Redis connection ended'));

  return client;
};

// ─── Connect Redis ─────────────────────────────────────────────────────────────
const connectRedis = async () => {
  try {
    redis = createRedisClient();
    await redis.connect();
    await redis.ping(); // Verify connection
    logger.info('✅ Redis connected and responding to PING');
  } catch (error) {
    logger.warn('⚠️ Redis connection failed - running without cache:', {
      error: error.message,
    });
    // Don't throw — app should work without Redis in dev
    redis = null;
  }
};

// ─── Cache Helper Functions ────────────────────────────────────────────────────
const cache = {
  /**
   * Get value from cache
   */
  get: async (key) => {
    if (!redis) return null;
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn('⚠️ Cache GET error:', { key, error: err.message });
      return null;
    }
  },

  /**
   * Set value in cache with optional TTL
   */
  set: async (key, value, ttlSeconds = null) => {
    if (!redis) return false;
    try {
      const ttl = ttlSeconds || parseInt(process.env.REDIS_TTL) || 3600;
      await redis.setex(key, ttl, JSON.stringify(value));
      return true;
    } catch (err) {
      logger.warn('⚠️ Cache SET error:', { key, error: err.message });
      return false;
    }
  },

  /**
   * Delete key(s) from cache
   */
  del: async (...keys) => {
    if (!redis) return false;
    try {
      await redis.del(...keys);
      return true;
    } catch (err) {
      logger.warn('⚠️ Cache DEL error:', { keys, error: err.message });
      return false;
    }
  },

  /**
   * Delete keys matching a pattern
   */
  delPattern: async (pattern) => {
    if (!redis) return false;
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
      return true;
    } catch (err) {
      logger.warn('⚠️ Cache DEL PATTERN error:', { pattern, error: err.message });
      return false;
    }
  },

  /**
   * Check if key exists
   */
  exists: async (key) => {
    if (!redis) return false;
    try {
      return (await redis.exists(key)) === 1;
    } catch (err) {
      return false;
    }
  },

  /**
   * Set TTL on existing key
   */
  expire: async (key, ttlSeconds) => {
    if (!redis) return false;
    try {
      await redis.expire(key, ttlSeconds);
      return true;
    } catch (err) {
      return false;
    }
  },

  /**
   * Flush all cache (use carefully!)
   */
  flush: async () => {
    if (!redis) return false;
    try {
      await redis.flushdb();
      logger.warn('⚠️ Redis cache flushed');
      return true;
    } catch (err) {
      return false;
    }
  },
};

// ─── Cache Key Builders ────────────────────────────────────────────────────────
const CACHE_KEYS = {
  // Products
  product:      (id)          => `product:id:${id}`,
  productSlug:  (slug)        => `product:slug:${slug}`,
  products:     (query)       => `products:list:${JSON.stringify(query)}`,
  featured:     ()            => 'products:featured',
  bestsellers:  ()            => 'products:bestsellers',
  newArrivals:  ()            => 'products:new-arrivals',
  onSale:       ()            => 'products:on-sale',
  productStats: ()            => 'products:stats',

  // Categories
  category:     (slugOrId)    => `category:slug:${slugOrId}`,
  categories:   ()            => 'categories:all',

  // Cart
  userCart:     (userId)      => `cart:user:${userId}`,
  cartCoupon:   (userId)      => `cart:coupon:${userId}`,
  coupon:       (code)        => `coupon:code:${code.toUpperCase()}`,

  // Orders
  userOrders:   (userId, page)=> `orders:user:${userId}:page:${page}`,
  order:        (id)          => `order:${id}`,

  // Settings / misc
  settings:     ()            => 'settings:global',
};

module.exports = { redis, connectRedis, cache, CACHE_KEYS };
