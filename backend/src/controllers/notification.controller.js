/**
 * controllers/notification.controller.js  [ENTERPRISE EDITION]
 * ==============================================================
 * In-app notification management endpoints.
 *
 * GET    /notifications             — Paginated list (latest first)
 * GET    /notifications/unread      — Unread count only (for badge)
 * GET    /notifications/summary     — Recent 5 + unread count (navbar)
 * PATCH  /notifications/:id/read    — Mark one as read
 * PATCH  /notifications/read-all    — Mark all as read
 * DELETE /notifications/:id         — Delete a notification
 * DELETE /notifications             — Clear all notifications
 *
 * ADMIN:
 * POST   /admin/notifications/broadcast  — Send to all / role-based
 * POST   /admin/notifications/whatsapp   — Send WhatsApp to a user
 * POST   /admin/notifications/test-wa    — Test WhatsApp (sandbox)
 */

'use strict';

const { prisma }    = require('../config/database');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError      = require('../utils/AppError');
const logger        = require('../utils/logger');
const {
  createNotification,
  createBulkNotification,
  markAsRead,
  getUnreadCount,
  broadcastToAdmins,
} = require('../services/notification.service');

const wa = require('../services/whatsapp.service');

// ─── Pagination helper ─────────────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

// ═══════════════════════════════════════════════════════════
//   GET NOTIFICATIONS (paginated)
// ═══════════════════════════════════════════════════════════

exports.getNotifications = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { type, unreadOnly }  = req.query;
  const userId = req.user.id;

  const where = {
    userId,
    ...(type       && { type }),
    ...(unreadOnly === 'true' && { isRead: false }),
  };

  const [notifications, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  ApiResponse.paginated(res, notifications, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
    unread,
  }, `${notifications.length} notification(s).`);
};

// ═══════════════════════════════════════════════════════════
//   NAVBAR SUMMARY (recent + unread count)
// ═══════════════════════════════════════════════════════════

exports.getSummary = async (req, res) => {
  const userId = req.user.id;

  const [recent, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    getUnreadCount(userId),
  ]);

  ApiResponse.success(res, { recent, unread }, 'Notification summary.');
};

// ═══════════════════════════════════════════════════════════
//   UNREAD COUNT (badge endpoint — very lightweight)
// ═══════════════════════════════════════════════════════════

exports.getUnreadCount = async (req, res) => {
  const count = await getUnreadCount(req.user.id);
  ApiResponse.success(res, { unread: count });
};

// ═══════════════════════════════════════════════════════════
//   MARK ONE AS READ
// ═══════════════════════════════════════════════════════════

exports.markOneRead = async (req, res) => {
  const { id } = req.params;
  const userId  = req.user.id;

  const n = await prisma.notification.findFirst({ where: { id, userId } });
  if (!n) throw AppError.notFound('Notification');

  await markAsRead(userId, id);
  ApiResponse.success(res, null, 'Notification marked as read.');
};

// ═══════════════════════════════════════════════════════════
//   MARK ALL AS READ
// ═══════════════════════════════════════════════════════════

exports.markAllRead = async (req, res) => {
  const result = await markAsRead(req.user.id);
  ApiResponse.success(res, { updated: result.count }, 'All notifications marked as read.');
};

// ═══════════════════════════════════════════════════════════
//   DELETE ONE
// ═══════════════════════════════════════════════════════════

exports.deleteNotification = async (req, res) => {
  const { id } = req.params;
  const n = await prisma.notification.findFirst({
    where: { id, userId: req.user.id },
  });
  if (!n) throw AppError.notFound('Notification');

  await prisma.notification.delete({ where: { id } });
  ApiResponse.success(res, null, 'Notification deleted.');
};

// ═══════════════════════════════════════════════════════════
//   CLEAR ALL
// ═══════════════════════════════════════════════════════════

exports.clearAll = async (req, res) => {
  const result = await prisma.notification.deleteMany({
    where: { userId: req.user.id },
  });
  ApiResponse.success(res, { deleted: result.count }, `${result.count} notification(s) cleared.`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: BROADCAST NOTIFICATION
//   POST /admin/notifications/broadcast
// ═══════════════════════════════════════════════════════════

exports.adminBroadcast = async (req, res) => {
  const { type, title, message, targetRole, userIds, data } = req.body;

  let recipients = [];

  if (userIds?.length) {
    // Specific users
    recipients = userIds;
  } else if (targetRole) {
    // All users of a role
    const users = await prisma.user.findMany({
      where: { role: targetRole, deletedAt: null },
      select: { id: true },
    });
    recipients = users.map((u) => u.id);
  } else {
    // All customers
    const users = await prisma.user.findMany({
      where: { role: 'CUSTOMER', deletedAt: null },
      select: { id: true },
    });
    recipients = users.map((u) => u.id);
  }

  if (recipients.length === 0) {
    throw AppError.badRequest('No recipients found for broadcast.');
  }

  const result = await createBulkNotification(recipients, {
    type: type || 'PROMO',
    title,
    message,
    data: data || null,
  });

  logger.apiEvent('ADMIN_BROADCAST', {
    adminId: req.user.id,
    type,
    recipients: recipients.length,
  });

  ApiResponse.success(res, {
    recipientCount: recipients.length,
    created: result?.count || 0,
  }, `Notification broadcast to ${recipients.length} user(s).`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: SEND WHATSAPP TO SPECIFIC USER
//   POST /admin/notifications/whatsapp
// ═══════════════════════════════════════════════════════════

exports.adminSendWhatsApp = async (req, res) => {
  const { userId, phone, message, template, templateVars } = req.body;

  let targetPhone = phone;

  if (!targetPhone && userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, name: true },
    });
    if (!user?.phone) throw AppError.badRequest('User has no phone number registered.');
    targetPhone = user.phone;
  }

  if (!targetPhone) throw AppError.badRequest('phone or userId is required.');

  let result;
  if (template && wa.TEMPLATES[template]) {
    result = await wa.send(targetPhone, template, templateVars || {});
  } else {
    result = await wa.sendRaw(targetPhone, message);
  }

  logger.apiEvent('ADMIN_WHATSAPP_MANUAL', {
    adminId: req.user.id,
    phone:   wa.normalizePhone(targetPhone),
    template,
  });

  ApiResponse.success(res, result || { status: 'sent (no provider response)' }, 'WhatsApp message sent.');
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: TEST WHATSAPP (sandbox)
//   POST /admin/notifications/test-wa
// ═══════════════════════════════════════════════════════════

exports.testWhatsApp = async (req, res) => {
  const { phone } = req.body;
  if (!phone) throw AppError.badRequest('phone is required.');

  const result = await wa.sendRaw(phone,
    `🧪 *WhatsApp Test — ${wa.SHOP.name}*\n\nThis is a test message from your backend.\nTimestamp: ${new Date().toISOString()}\n\n✅ WhatsApp integration is working!`
  );

  ApiResponse.success(res, {
    normalizedPhone: wa.normalizePhone(phone),
    result: result || 'No response (provider may not be configured)',
    configured: {
      twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      meta:   !!(process.env.META_WHATSAPP_PHONE_ID && process.env.META_WHATSAPP_TOKEN),
    },
  }, 'Test WhatsApp sent.');
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: LIST AVAILABLE TEMPLATES
//   GET /admin/notifications/templates
// ═══════════════════════════════════════════════════════════

exports.listTemplates = (req, res) => {
  const templates = Object.keys(wa.TEMPLATES).map((key) => ({
    key,
    preview: wa.TEMPLATES[key]({
      name:          '{{name}}',
      orderNumber:   'ORD-2026-000001',
      total:         '₹526.50',
      orderId:       '{{orderId}}',
      otp:           '123456',
      expiresIn:     10,
      courierName:   'Blue Dart',
      trackingNumber:'BD123456789',
      reason:        '{{reason}}',
      amount:        '₹526.50',
      upiId:         process.env.MERCHANT_UPI_ID || 'yourshop@upi',
      referenceCode: 'PAY-202605-00001-ABCD1234',
    }).slice(0, 200) + '...',
  }));

  ApiResponse.success(res, templates, `${templates.length} templates available.`);
};
