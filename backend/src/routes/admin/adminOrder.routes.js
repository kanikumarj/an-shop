/**
 * routes/admin/adminOrder.routes.js  [ENTERPRISE EDITION]
 * =========================================================
 * Admin order management — full lifecycle control.
 * All routes require JWT auth + ADMIN or SUPERADMIN role.
 */

'use strict';

const { Router } = require('express');
const adminOrderController = require('../../controllers/admin/adminOrder.controller');
const { protect, adminOnly } = require('../../middleware/auth');
const { validate }           = require('../../middleware/validate');
const {
  updateStatusSchema,
  verifyPaymentSchema,
  shipOrderSchema,
  markDeliveredSchema,
  adminCancelSchema,
  processRefundSchema,
  adminNotesSchema,
} = require('../../validations/order.validation');

const router = Router();

router.use(protect, adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
//   ANALYTICS & SPECIAL QUEUES  (before /:id routes)
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/orders/analytics?period=30d
router.get('/analytics', adminOrderController.getOrderAnalytics);

// GET /admin/orders/pending-payment?page=1
// Payment screenshot verification queue (FIFO)
router.get('/pending-payment', adminOrderController.getPendingPayments);

// ─────────────────────────────────────────────────────────────────────────────
//   ORDER LIST & DETAIL
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/orders
// Query: ?status=PENDING&paymentStatus=SCREENSHOT_UPLOADED&q=ORD-2026&from=&to=&page=1&limit=20&sortBy=createdAt&sortDir=desc
router.get('/', adminOrderController.listOrders);

// GET /admin/orders/:id
router.get('/:id', adminOrderController.getOrder);

// GET /admin/orders/:id/invoice
router.get('/:id/invoice', adminOrderController.adminDownloadInvoice);

// ─────────────────────────────────────────────────────────────────────────────
//   STATUS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /admin/orders/:id/status
// Body: { status, note, force? }
router.patch('/:id/status',
  validate(updateStatusSchema),
  adminOrderController.updateOrderStatus
);

// PATCH /admin/orders/:id/payment
// Body: { action: "APPROVE"|"REJECT", note?, rejectionReason? }
router.patch('/:id/payment',
  validate(verifyPaymentSchema),
  adminOrderController.verifyPayment
);

// PATCH /admin/orders/:id/ship
// Body: { trackingNumber, courierName, courierUrl?, estimatedDelivery?, note? }
router.patch('/:id/ship',
  validate(shipOrderSchema),
  adminOrderController.shipOrder
);

// PATCH /admin/orders/:id/deliver
// Body: { note? }
router.patch('/:id/deliver',
  validate(markDeliveredSchema),
  adminOrderController.markDelivered
);

// PATCH /admin/orders/:id/cancel
// Body: { reason, restoreStock? }
router.patch('/:id/cancel',
  validate(adminCancelSchema),
  adminOrderController.adminCancelOrder
);

// PATCH /admin/orders/:id/refund
// Body: { amount?, transactionRef?, note? }
router.patch('/:id/refund',
  validate(processRefundSchema),
  adminOrderController.processRefund
);

// PATCH /admin/orders/:id/notes
// Body: { notes }
router.patch('/:id/notes',
  validate(adminNotesSchema),
  adminOrderController.addAdminNotes
);

module.exports = router;
