/**
 * jobs/cronJobs.js  [ENTERPRISE EDITION]
 * ========================================
 * All application-level background cron jobs.
 *
 * JOBS:
 *   Email Queue Processor   — Every minute
 *   OTP Cleanup             — Every hour
 *   Token Blacklist Cleanup — Every day at 3 AM IST
 *   Product Stats Refresh   — Every 30 min
 *   Session Cleanup         — Every day at 2 AM IST
 */

'use strict';

const cron   = require('node-cron');
const logger = require('../utils/logger');

const safeRun = async (name, fn) => {
  try {
    const result = await fn();
    if (result) logger.debug(`✅ [CRON] ${name}:`, result);
  } catch (err) {
    logger.error(`❌ [CRON] ${name} failed:`, { error: err.message });
  }
};

const startCronJobs = () => {
  // ── Email Queue Processor — every minute ──────────────────
  cron.schedule('* * * * *', async () => {
    await safeRun('Email Queue', async () => {
      const email = require('../services/email.service');
      return email.processQueue(15);
    });
  });

  // ── OTP Cleanup — every hour ──────────────────────────────
  cron.schedule('0 * * * *', async () => {
    await safeRun('OTP Cleanup', async () => {
      const { prisma } = require('../config/database');
      const result = await prisma.oTP.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }).catch(() => ({ count: 0 }));
      return { deleted: result.count };
    });
  });

  // ── Token Blacklist Cleanup — every day at 3 AM IST (21:30 UTC) ──
  cron.schedule('30 21 * * *', async () => {
    await safeRun('Token Blacklist Cleanup', async () => {
      const { redis } = require('../config/redis');
      if (!redis) return { status: 'Redis unavailable' };
      // Redis TTL handles expiry automatically — just log the key count
      const count = await redis.keys('blacklist:jti:*').catch(() => []);
      return { activeBlacklistTokens: count.length };
    });
  }, { timezone: 'UTC' });

  // ── Product Bestseller Stats Refresh — every 30 min ──────
  cron.schedule('*/30 * * * *', async () => {
    await safeRun('Product Stats Refresh', async () => {
      const { cache, CACHE_KEYS } = require('../config/redis');
      // Invalidate cached product lists so they refresh on next request
      await cache.delPattern('products:bestsellers').catch(() => {});
      await cache.delPattern('products:featured').catch(() => {});
      return { invalidated: ['bestsellers', 'featured'] };
    });
  });

  logger.info('✅ Cron jobs started (4 jobs)');
};

module.exports = { startCronJobs };
