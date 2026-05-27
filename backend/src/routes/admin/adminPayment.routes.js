/**
 * routes/admin/adminPayment.routes.js  [ENTERPRISE EDITION]
 * ===========================================================
 * Admin UPI payment verification panel routes.
 * All routes require JWT auth + ADMIN or SUPERADMIN role.
 */

'use strict';

const { Router } = require('express');
const adminPaymentController = require('../../controllers/admin/adminPayment.controller');
const { protect, adminOnly } = require('../../middleware/auth');
const { validate }           = require('../../middleware/validate');
const {
  approvePaymentSchema,
  rejectPaymentSchema,
  flagPaymentSchema,
  paymentQuerySchema,
} = require('../../validations/payment.validation');

const router = Router();

router.use(protect, adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
//   ANALYTICS & SPECIAL LOOKUPS  (before /:id to avoid conflicts)
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/payments/analytics?period=30d
router.get('/analytics', adminPaymentController.getPaymentAnalytics);

// GET /admin/payments/suspicious
// Shows: duplicate UTRs, amount mismatches, rapid uploaders
router.get('/suspicious', adminPaymentController.getSuspiciousPayments);

// GET /admin/payments/utr/:utr  — Find all screenshots with a UTR
router.get('/utr/:utr', adminPaymentController.lookupByUtr);

// GET /admin/payments/reference/:ref  — Find payment by reference code
router.get('/reference/:ref', adminPaymentController.lookupByReference);

// ─────────────────────────────────────────────────────────────────────────────
//   VERIFICATION QUEUE & DETAIL
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/payments
// Query: ?status=SCREENSHOT_UPLOADED&q=PAY-2026&sortBy=updatedAt&sortDir=asc
router.get('/', adminPaymentController.getPaymentQueue);

// GET /admin/payments/:id  — Full payment detail + UTR conflict check
router.get('/:id', adminPaymentController.getPaymentDetail);

// ─────────────────────────────────────────────────────────────────────────────
//   VERIFICATION ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/payments/:id/approve
// Body: { screenshotId?, note? }
router.post('/:id/approve',
  validate(approvePaymentSchema),
  adminPaymentController.approvePayment
);

// POST /admin/payments/:id/reject
// Body: { reason, screenshotId?, notifyCustomer? }
router.post('/:id/reject',
  validate(rejectPaymentSchema),
  adminPaymentController.rejectPayment
);

// POST /admin/payments/:id/flag
// Body: { reason }
router.post('/:id/flag',
  validate(flagPaymentSchema),
  adminPaymentController.flagPayment
);

module.exports = router;
