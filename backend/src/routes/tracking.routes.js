/**
 * routes/tracking.routes.js  [ENTERPRISE EDITION]
 * ==================================================
 * Shipment tracking routes — customer + admin.
 */

'use strict';

const { Router } = require('express');
const rateLimit  = require('express-rate-limit');
const trackingController = require('../controllers/tracking.controller');
const { protect, adminOnly } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { z } = require('zod');

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many tracking requests. Please wait.' },
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests.' },
});

// ─────────────────────────────────────────────────────────────────────────────
//   PUBLIC ROUTES (no auth)
// ─────────────────────────────────────────────────────────────────────────────

// GET /tracking/couriers — Supported courier list
router.get('/couriers', readLimiter, trackingController.listCouriers);

// GET /tracking/:trackingNumber — Public tracking by number (no auth)
router.get('/:trackingNumber', readLimiter, trackingController.trackByNumber);

// ─────────────────────────────────────────────────────────────────────────────
//   AUTH REQUIRED
// ─────────────────────────────────────────────────────────────────────────────

// GET /tracking/order/:orderId — Track my own order
router.get('/order/:orderId', protect, readLimiter, trackingController.trackMyOrder);

module.exports = router;
