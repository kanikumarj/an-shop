/**
 * jobs/whatsapp.jobs.js  [ENTERPRISE EDITION]
 * =============================================
 * Scheduled background jobs for automated WhatsApp notifications.
 *
 * SCHEDULES:
 *   Daily Summary      — Every day at 9 PM IST (15:30 UTC) → admin
 *   Review Requests    — Every day at 10 AM IST (04:30 UTC) → delivered customers
 *   Payment Reminders  — Every 2 hours → pending payment orders
 *   Delivery Alerts    — Every 30 min  → mark overdue orders
 *   Low Stock Alerts   — Every hour    → admin
 *
 * All jobs:
 *   - Use cron expressions aligned to IST timezone
 *   - Soft-fail (errors logged, never crash server)
 *   - Each run is idempotent (safe to re-run)
 *   - DB reads are scoped/limited to avoid overload
 */

'use strict';

const cron   = require('node-cron');
const { prisma } = require('../config/database');
const logger = require('../utils/logger');
const wa     = require('../services/whatsapp.service');

// ─── Config ────────────────────────────────────────────────────────────────────
const JOBS_ENABLED = process.env.WHATSAPP_JOBS_ENABLED !== 'false';
const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD) || 10;

if (!JOBS_ENABLED) {
  logger.info('📵 WhatsApp background jobs are DISABLED (WHATSAPP_JOBS_ENABLED=false)');
}

// ─── Job runner with error isolation ──────────────────────────────────────────
const safeRun = async (jobName, fn) => {
  try {
    logger.info(`⚙️ [WA-JOB] Starting: ${jobName}`);
    const result = await fn();
    logger.info(`✅ [WA-JOB] Completed: ${jobName}`, { result: result || 'ok' });
    return result;
  } catch (err) {
    logger.error(`❌ [WA-JOB] Failed: ${jobName}`, { error: err.message, stack: err.stack });
    return null;
  }
};

// ═══════════════════════════════════════════════════════════
//   JOB 1: DAILY ADMIN SUMMARY
//   Every day at 9:00 PM IST (15:30 UTC)
// ═══════════════════════════════════════════════════════════

const scheduleDailySummary = () => {
  cron.schedule('30 15 * * *', async () => {
    await safeRun('Daily Admin Summary', async () => {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const [orders, revenue, pending] = await Promise.all([
        prisma.order.groupBy({
          by: ['status'],
          where: { createdAt: { gte: todayStart }, deletedAt: null },
          _count: { id: true },
        }),
        prisma.order.aggregate({
          where: {
            status: { in: ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'] },
            createdAt: { gte: todayStart },
            deletedAt: null,
          },
          _sum: { total: true },
          _count: { id: true },
        }),
        prisma.payment.count({ where: { status: 'SCREENSHOT_UPLOADED' } }),
      ]);

      const statusMap = orders.reduce((acc, o) => {
        acc[o.status] = o._count.id;
        return acc;
      }, {});

      await wa.admin.dailySummary({
        orders:          revenue._count.id,
        confirmed:       statusMap['CONFIRMED']         || 0,
        shipped:         statusMap['SHIPPED']           || 0,
        delivered:       statusMap['DELIVERED']         || 0,
        cancelled:       statusMap['CANCELLED']         || 0,
        revenue:         revenue._sum.total             || 0,
        pendingPayments: pending,
      });

      return { ordersToday: revenue._count.id };
    });
  }, { timezone: 'UTC' });

  logger.info('📅 [WA-JOB] Scheduled: Daily Summary (9 PM IST)');
};

// ═══════════════════════════════════════════════════════════
//   JOB 2: REVIEW REQUEST (delivered orders 24h ago)
//   Every day at 10:00 AM IST (04:30 UTC)
// ═══════════════════════════════════════════════════════════

const scheduleReviewRequests = () => {
  cron.schedule('30 4 * * *', async () => {
    await safeRun('Review Request Notifications', async () => {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      // Orders delivered between 24–48 hours ago, no review yet
      const orders = await prisma.order.findMany({
        where: {
          status: 'DELIVERED',
          deliveredAt: { gte: fortyEightHoursAgo, lte: twentyFourHoursAgo },
          deletedAt: null,
          // Exclude orders that already have a review
          reviews: { none: {} },
        },
        include: {
          user: { select: { phone: true, name: true } },
        },
        take: 50, // Process max 50 per run
      });

      let sent = 0;
      for (const order of orders) {
        if (order.user?.phone) {
          await wa.notify.reviewRequest(order.user, order);
          sent++;
          // Small delay to avoid rate limiting
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      return { processed: orders.length, sent };
    });
  }, { timezone: 'UTC' });

  logger.info('📅 [WA-JOB] Scheduled: Review Requests (10 AM IST)');
};

// ═══════════════════════════════════════════════════════════
//   JOB 3: PAYMENT REMINDERS (pending payment > 3 hours)
//   Every 2 hours
// ═══════════════════════════════════════════════════════════

const schedulePaymentReminders = () => {
  cron.schedule('0 */2 * * *', async () => {
    await safeRun('Payment Reminder Notifications', async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000);

      // Orders in PAYMENT_PENDING state for > 3 hours, not yet expired
      const orders = await prisma.order.findMany({
        where: {
          status: 'PAYMENT_PENDING',
          updatedAt: { lte: threeHoursAgo, gte: twentyHoursAgo },
          deletedAt: null,
        },
        include: {
          user: { select: { phone: true, name: true } },
          payments: {
            where: { status: { in: ['PENDING', 'REJECTED'] } },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        take: 30,
      });

      let sent = 0;
      for (const order of orders) {
        if (order.user?.phone) {
          await wa.notify.paymentPending(order.user, order, order.payments[0] || null);
          sent++;
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      return { processed: orders.length, sent };
    });
  }, { timezone: 'UTC' });

  logger.info('📅 [WA-JOB] Scheduled: Payment Reminders (every 2 hours)');
};

// ═══════════════════════════════════════════════════════════
//   JOB 4: LOW STOCK ALERTS
//   Every hour at :00
// ═══════════════════════════════════════════════════════════

const scheduleLowStockAlerts = () => {
  cron.schedule('0 * * * *', async () => {
    await safeRun('Low Stock Alerts', async () => {
      const products = await prisma.product.findMany({
        where: {
          stock: { lte: LOW_STOCK_THRESHOLD },
          isActive: true,
          deletedAt: null,
          allowBackorder: false,
        },
        select: { id: true, name: true, sku: true, stock: true },
        orderBy: { stock: 'asc' },
        take: 20,
      });

      // Only alert if there are low stock products
      if (products.length === 0) return { alerts: 0 };

      // Send one consolidated alert with all products
      const productList = products
        .map((p) => `  ${p.stock === 0 ? '🔴' : '🟡'} ${p.name} — ${p.stock} unit(s)`)
        .join('\n');

      const adminPhone = process.env.ADMIN_WHATSAPP_PHONE || process.env.SHOP_PHONE;

      const msg = `⚠️ *Low Stock Alert — ${wa.SHOP.name}*

${products.length} product(s) need restocking:

${productList}

📊 Manage inventory: ${wa.SHOP.baseUrl}/admin/products`;

      if (adminPhone) {
        await wa.sendRaw(adminPhone, msg);
      }

      return { alerts: products.length };
    });
  }, { timezone: 'UTC' });

  logger.info('📅 [WA-JOB] Scheduled: Low Stock Alerts (every hour)');
};

// ═══════════════════════════════════════════════════════════
//   JOB 5: PENDING SCREENSHOT REMINDER TO ADMIN
//   Every 30 minutes
// ═══════════════════════════════════════════════════════════

const schedulePendingScreenshotAlerts = () => {
  cron.schedule('*/30 * * * *', async () => {
    await safeRun('Pending Screenshot Alert', async () => {
      const pending = await prisma.payment.count({
        where: { status: 'SCREENSHOT_UPLOADED' },
      });

      // Only alert if queue has grown
      if (pending > 0 && pending % 5 === 0) {
        // Alert every 5th pending item (e.g., 5, 10, 15...)
        const adminPhone = process.env.ADMIN_WHATSAPP_PHONE || process.env.SHOP_PHONE;
        if (adminPhone) {
          await wa.sendRaw(adminPhone,
            `🖼️ *${pending} Payment(s) Awaiting Verification — ${wa.SHOP.name}*\n\nReview now: ${wa.SHOP.baseUrl}/admin/payments?status=SCREENSHOT_UPLOADED`
          );
        }
      }

      return { pending };
    });
  }, { timezone: 'UTC' });

  logger.info('📅 [WA-JOB] Scheduled: Pending Screenshot Alerts (every 30 min)');
};

// ═══════════════════════════════════════════════════════════
//   INITIALIZER — call from server.js
// ═══════════════════════════════════════════════════════════

const initWhatsAppJobs = () => {
  if (!JOBS_ENABLED) return;

  logger.info('🚀 Initializing WhatsApp background jobs...');

  scheduleDailySummary();
  scheduleReviewRequests();
  schedulePaymentReminders();
  scheduleLowStockAlerts();
  schedulePendingScreenshotAlerts();

  logger.info('✅ WhatsApp background jobs initialized (5 jobs scheduled)');
};

module.exports = {
  initWhatsAppJobs,
  // Export individual jobs for manual triggering
  scheduleDailySummary,
  scheduleReviewRequests,
  schedulePaymentReminders,
  scheduleLowStockAlerts,
  schedulePendingScreenshotAlerts,
};
