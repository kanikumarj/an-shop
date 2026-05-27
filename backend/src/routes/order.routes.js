/**
 * routes/order.routes.js  [ENTERPRISE EDITION]
 * ==============================================
 * Customer-facing order management routes.
 */

'use strict';

const { Router } = require('express');
const rateLimit  = require('express-rate-limit');

const orderController = require('../controllers/order.controller');
const { protect }     = require('../middleware/auth');
const { validate }    = require('../middleware/validate');
const {
  createOrderSchema,
  cancelOrderSchema,
  returnRequestSchema,
  refundRequestSchema,
} = require('../validations/order.validation');

const router = Router();

router.use(protect);

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const orderReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many order requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const orderWriteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many order actions. Please wait.' },
});

const createOrderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Order placement limit reached. Please wait.' },
});

// ─── Read Routes ──────────────────────────────────────────────────────────────

// GET /orders/summary  — Dashboard widget counts + recent orders
router.get('/summary',   orderReadLimiter, orderController.getOrderSummary);

// GET /orders          — Paginated order history
// Query: ?page=1&limit=10&status=DELIVERED&from=2026-01-01&to=2026-12-31
router.get('/',          orderReadLimiter, orderController.getMyOrders);

// GET /orders/:id      — Full order detail
router.get('/:id',       orderReadLimiter, orderController.getOrderById);

// GET /orders/:id/track — Tracking timeline with step indicators
router.get('/:id/track', orderReadLimiter, orderController.trackOrder);

// GET /orders/:id/invoice — HTML invoice (?download=true for file download)
router.get('/:id/invoice', orderReadLimiter, orderController.downloadInvoice);

// ─── Write Routes ─────────────────────────────────────────────────────────────

// POST /orders         — Place order from cart
router.post('/',
  createOrderLimiter,
  validate(createOrderSchema),
  orderController.createOrder
);

// PATCH /orders/:id/cancel   — Customer cancellation
router.patch('/:id/cancel',
  orderWriteLimiter,
  validate(cancelOrderSchema),
  orderController.cancelOrder
);

// POST /orders/:id/return    — Request return (within window)
router.post('/:id/return',
  orderWriteLimiter,
  validate(returnRequestSchema),
  orderController.requestReturn
);

// POST /orders/:id/refund    — Request refund
router.post('/:id/refund',
  orderWriteLimiter,
  validate(refundRequestSchema),
  orderController.requestRefund
);

module.exports = router;
