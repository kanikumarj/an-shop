/**
 * services/notification.service.js  [ENTERPRISE EDITION]
 * =========================================================
 * Unified notification hub — in-app + WhatsApp + Email.
 *
 * All notification channels route through this service.
 * Call `notificationService.send()` from any controller
 * and it fans out to the appropriate channels.
 *
 * CHANNELS:
 *   in-app   → Prisma DB + WebSocket push
 *   whatsapp → whatsapp.service.js (Twilio + Meta)
 *   email    → email.service.js (Nodemailer)
 */

'use strict';

const { prisma } = require('../config/database');
const logger     = require('../utils/logger');

// Lazy-load to avoid circular imports
const getWa    = () => require('./whatsapp.service');
const getEmail = () => require('./email.service');

// ─── Notification types that get WhatsApp + Email ─────────────────────────────
const WA_CHANNELS = new Set([
  'ORDER_PLACED', 'ORDER_CONFIRMED', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED',
  'SCREENSHOT_UPLOADED', 'ORDER_PROCESSING', 'ORDER_PACKED', 'ORDER_SHIPPED',
  'OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'ORDER_CANCELLED',
  'RETURN_REQUESTED', 'REFUND_PROCESSED',
  'PAYMENT_SUCCESS', 'PAYMENT_PENDING',
  'OTP', 'WELCOME', 'LOGIN_ALERT',
]);

const EMAIL_CHANNELS = new Set([
  'ORDER_PLACED', 'ORDER_CONFIRMED', 'PAYMENT_VERIFIED', 'PAYMENT_REJECTED',
  'ORDER_DELIVERED', 'ORDER_CANCELLED', 'REFUND_PROCESSED',
  'PAYMENT_SUCCESS',
]);

// ─── Icon Map ─────────────────────────────────────────────────────────────────
const NOTIFICATION_ICONS = {
  ORDER_PLACED:        '📦',
  ORDER_CONFIRMED:     '✅',
  ORDER_PROCESSING:    '👩‍🍳',
  ORDER_PACKED:        '📫',
  ORDER_SHIPPED:       '🚚',
  OUT_FOR_DELIVERY:    '🏍️',
  ORDER_DELIVERED:     '🏠',
  ORDER_CANCELLED:     '❌',
  PAYMENT_SUCCESS:     '💳',
  PAYMENT_VERIFIED:    '✅',
  PAYMENT_REJECTED:    '❌',
  PAYMENT_PENDING:     '⏳',
  SCREENSHOT_UPLOADED: '🖼️',
  RETURN_REQUESTED:    '↩️',
  REFUND_PROCESSED:    '💰',
  REVIEW_REQUEST:      '⭐',
  PROMO:               '🎁',
  SYSTEM:              '🔔',
  OTP:                 '🔐',
  WELCOME:             '🎉',
  LOGIN_ALERT:         '🔐',
  LOW_STOCK:           '⚠️',
};

// ═══════════════════════════════════════════════════════════
//   CREATE IN-APP NOTIFICATION
// ═══════════════════════════════════════════════════════════

const createNotification = async ({ userId, type, title, message, data = null }) => {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        data,
      },
    });

    // Real-time push via WebSocket
    setImmediate(() => {
      try {
        const { getIO } = require('../websocket/socket');
        const io = getIO();
        if (io) {
          io.to(`user:${userId}`).emit('notification', {
            ...notification,
            icon: NOTIFICATION_ICONS[type] || '🔔',
            unread: true,
          });
        }
      } catch (_) {}
    });

    return notification;
  } catch (error) {
    logger.warn('⚠️ Notification DB create failed:', { error: error.message, userId, type });
    return null;
  }
};

// ═══════════════════════════════════════════════════════════
//   MULTI-CHANNEL SEND
// ═══════════════════════════════════════════════════════════

/**
 * Fan out a notification across all enabled channels.
 *
 * @param {object}  params
 * @param {string}  params.userId     — Target user ID (for in-app + WS)
 * @param {object}  [params.user]     — Full user object { phone, email, name } (for WA/email)
 * @param {object}  [params.order]    — Order object (for order notifications)
 * @param {string}  params.type       — Notification type key
 * @param {string}  params.title      — In-app notification title
 * @param {string}  params.message    — In-app notification body
 * @param {object}  [params.data]     — Extra metadata stored in DB
 * @param {boolean} [params.skipWa]   — Skip WhatsApp
 * @param {boolean} [params.skipEmail]— Skip Email
 */
const send = async ({
  userId,
  user,
  order,
  type,
  title,
  message,
  data = null,
  skipWa    = false,
  skipEmail = false,
}) => {
  const results = { inApp: null, whatsapp: null, email: null };

  // ── 1. In-app notification (always) ──────────────────────
  results.inApp = await createNotification({ userId, type, title, message, data });

  // ── 2. WhatsApp (fire-and-forget, non-blocking) ───────────
  if (!skipWa && WA_CHANNELS.has(type) && user?.phone) {
    setImmediate(async () => {
      try {
        const wa = getWa();
        // Use status dispatcher if we have an order
        if (order) {
          await wa.dispatchStatusNotification(user, order, type.replace('ORDER_', ''));
        }
      } catch (err) {
        logger.warn('⚠️ WhatsApp notification failed:', { type, error: err.message });
      }
    });
  }

  // ── 3. Email (fire-and-forget) ────────────────────────────
  if (!skipEmail && EMAIL_CHANNELS.has(type) && user?.email) {
    setImmediate(async () => {
      try {
        const emailService = getEmail();
        if (type === 'ORDER_PLACED' && order)       await emailService.sendOrderConfirmation(user.email, order);
        if (type === 'PAYMENT_VERIFIED' && order)   await emailService.sendPaymentConfirmation(user.email, order);
        if (type === 'PAYMENT_SUCCESS' && order)    await emailService.sendPaymentConfirmation(user.email, order);
      } catch (err) {
        logger.warn('⚠️ Email notification failed:', { type, error: err.message });
      }
    });
  }

  return results;
};

// ═══════════════════════════════════════════════════════════
//   BULK IN-APP NOTIFICATIONS
// ═══════════════════════════════════════════════════════════

const createBulkNotification = async (userIds, { type, title, message, data = null }) => {
  try {
    const notifications = await prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, type, title, message, data })),
      skipDuplicates: true,
    });

    // Push to all connected users
    setImmediate(() => {
      try {
        const { getIO } = require('../websocket/socket');
        const io = getIO();
        if (io) {
          userIds.forEach((uid) =>
            io.to(`user:${uid}`).emit('notification', {
              type, title, message,
              icon: NOTIFICATION_ICONS[type] || '🔔',
              unread: true,
            })
          );
        }
      } catch (_) {}
    });

    return notifications;
  } catch (error) {
    logger.warn('⚠️ Bulk notification failed:', { error: error.message, count: userIds.length });
    return null;
  }
};

// ═══════════════════════════════════════════════════════════
//   MARK AS READ
// ═══════════════════════════════════════════════════════════

const markAsRead = async (userId, notificationId = null) => {
  const where = notificationId
    ? { id: notificationId, userId }
    : { userId, isRead: false };

  return prisma.notification.updateMany({
    where,
    data: { isRead: true, readAt: new Date() },
  });
};

// ═══════════════════════════════════════════════════════════
//   GET UNREAD COUNT
// ═══════════════════════════════════════════════════════════

const getUnreadCount = async (userId) => {
  return prisma.notification.count({ where: { userId, isRead: false } });
};

// ═══════════════════════════════════════════════════════════
//   ADMIN BROADCAST
// ═══════════════════════════════════════════════════════════

const broadcastToAdmins = async ({ type, title, message, data = null }) => {
  const admins = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPERADMIN'] }, deletedAt: null },
    select: { id: true },
  });

  const userIds = admins.map((a) => a.id);
  return createBulkNotification(userIds, { type, title, message, data });
};

module.exports = {
  send,
  createNotification,
  createBulkNotification,
  markAsRead,
  getUnreadCount,
  broadcastToAdmins,
  NOTIFICATION_ICONS,
};
