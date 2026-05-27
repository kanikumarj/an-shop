/**
 * routes/notification.routes.js  [ENTERPRISE EDITION]
 * ======================================================
 * In-app notification management + admin WhatsApp tools.
 */

'use strict';

const { Router }  = require('express');
const rateLimit   = require('express-rate-limit');

const notifController = require('../controllers/notification.controller');
const { protect, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { z } = require('zod');

const router = Router();
router.use(protect);

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many requests.' },
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many actions.' },
});

// ─────────────────────────────────────────────────────────────────────────────
//   CUSTOMER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /notifications/summary      — Navbar badge: recent 5 + unread count
router.get('/summary',             readLimiter, notifController.getSummary);

// GET /notifications/unread        — Just the unread count (for polling)
router.get('/unread',              readLimiter, notifController.getUnreadCount);

// GET /notifications               — Paginated full list
// Query: ?page=1&limit=20&type=ORDER_SHIPPED&unreadOnly=true
router.get('/',                    readLimiter, notifController.getNotifications);

// PATCH /notifications/read-all    — Mark all as read
router.patch('/read-all',          writeLimiter, notifController.markAllRead);

// PATCH /notifications/:id/read    — Mark one as read
router.patch('/:id/read',          writeLimiter, notifController.markOneRead);

// DELETE /notifications            — Clear all
router.delete('/',                 writeLimiter, notifController.clearAll);

// DELETE /notifications/:id        — Delete one
router.delete('/:id',              writeLimiter, notifController.deleteNotification);

// ─────────────────────────────────────────────────────────────────────────────
//   ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET  /notifications/admin/templates  — Preview all WA templates
router.get('/admin/templates', adminOnly, notifController.listTemplates);

// POST /notifications/admin/broadcast  — Push in-app notif to all/role/users
router.post('/admin/broadcast',
  adminOnly,
  validate(z.object({
    type:       z.string().optional().default('PROMO'),
    title:      z.string({ required_error: 'title is required.' }).min(3).max(100),
    message:    z.string({ required_error: 'message is required.' }).min(5).max(500),
    targetRole: z.enum(['CUSTOMER', 'ADMIN', 'SUPERADMIN']).optional(),
    userIds:    z.array(z.string().uuid()).optional(),
    data:       z.record(z.unknown()).optional(),
  })),
  notifController.adminBroadcast
);

// POST /notifications/admin/whatsapp  — Send WhatsApp to a specific user
router.post('/admin/whatsapp',
  adminOnly,
  validate(z.object({
    userId:      z.string().uuid().optional(),
    phone:       z.string().optional(),
    message:     z.string().max(1000).optional(),
    template:    z.string().optional(),
    templateVars:z.record(z.string()).optional(),
  }).refine((d) => d.userId || d.phone, {
    message: 'Either userId or phone is required.',
    path: ['userId'],
  })),
  notifController.adminSendWhatsApp
);

// POST /notifications/admin/test-wa   — Sandbox test
router.post('/admin/test-wa',
  adminOnly,
  validate(z.object({ phone: z.string({ required_error: 'phone is required.' }) })),
  notifController.testWhatsApp
);

module.exports = router;
