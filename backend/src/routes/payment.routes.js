/**
 * routes/payment.routes.js  [ENTERPRISE UPI EDITION]
 * =====================================================
 * Customer-facing UPI payment workflow routes.
 */

'use strict';

const { Router }  = require('express');
const rateLimit   = require('express-rate-limit');

const paymentController = require('../controllers/payment.controller');
const { protect }       = require('../middleware/auth');
const { validate }      = require('../middleware/validate');
const { uploadPaymentScreenshot } = require('../config/cloudinary');
const { uploadScreenshotSchema }  = require('../validations/payment.validation');

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const paymentReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many payment requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutes
  max: 5,
  message: { success: false, message: 'Too many screenshot uploads. Wait 10 minutes.' },
});

const initiateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many payment initiation attempts.' },
});

// All routes require auth
router.use(protect);

// ─────────────────────────────────────────────────────────────────────────────
//   PAYMENT INITIATION & INFO
// ─────────────────────────────────────────────────────────────────────────────

// POST /payments/initiate/:orderId
// Returns: payment reference, UPI deep links for GPay/PhonePe/Paytm, instructions
router.post('/initiate/:orderId',
  initiateLimiter,
  paymentController.initiatePayment
);

// GET /payments/:orderId/instructions
// Returns: UPI ID, reference code, step-by-step instructions
router.get('/:orderId/instructions',
  paymentReadLimiter,
  paymentController.getPaymentInstructions
);

// GET /payments/:orderId/status
// Polling endpoint — lightweight, 1min cache
router.get('/:orderId/status',
  paymentReadLimiter,
  paymentController.getPaymentStatus
);

// GET /payments/:orderId
// Full payment detail with all screenshots
router.get('/:orderId',
  paymentReadLimiter,
  paymentController.getPaymentDetails
);

// GET /payments/:orderId/screenshots
// List all screenshots uploaded for this payment
router.get('/:orderId/screenshots',
  paymentReadLimiter,
  paymentController.getMyScreenshots
);

// ─────────────────────────────────────────────────────────────────────────────
//   SCREENSHOT UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

// POST /payments/:orderId/upload
// Multer → Cloudinary → DB record + order status update
router.post('/:orderId/upload',
  uploadLimiter,           // IP-level rate limit
  uploadPaymentScreenshot, // Multer → Cloudinary (10MB max, images/pdf)
  validate(uploadScreenshotSchema),
  paymentController.uploadScreenshot
);

module.exports = router;
