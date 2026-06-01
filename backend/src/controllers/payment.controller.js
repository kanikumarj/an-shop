/**
 * controllers/payment.controller.js  [ENTERPRISE UPI EDITION]
 * =============================================================
 * Complete manual UPI payment verification workflow.
 *
 * CUSTOMER FLOW:
 *   POST /payments/initiate/:orderId         — Get payment details + UPI deep link
 *   GET  /payments/:orderId/status           — Check payment status
 *   POST /payments/:orderId/upload           — Upload payment screenshot
 *   GET  /payments/:orderId/screenshots      — List my uploaded screenshots
 *   GET  /payments/:orderId/invoice          — Download invoice (post-payment)
 *
 * ADMIN FLOW (via adminPayment.controller.js):
 *   GET  /admin/payments                     — Verification queue
 *   GET  /admin/payments/:id                 — Screenshot detail
 *   POST /admin/payments/:id/approve         — Approve payment
 *   POST /admin/payments/:id/reject          — Reject with reason
 *   GET  /admin/payments/analytics           — Revenue + verification stats
 */

'use strict';

const { prisma }          = require('../config/database');
const { withTransaction } = require('../config/database');
const { cache, CACHE_KEYS } = require('../config/redis');
const { ApiResponse }     = require('../utils/ApiResponse');
const AppError            = require('../utils/AppError');
const logger              = require('../utils/logger');
const { deleteFromCloudinary } = require('../config/cloudinary');

const {
  buildUpiDeepLink,
  validateUtrFormat,
  checkDuplicateUtr,
  checkUploadRateLimit,
  validatePaymentAmount,
  getOrCreatePaymentRecord,
  paymentCacheKey,
  PAYMENT_EXPIRY_HOURS,
  MAX_UPLOAD_ATTEMPTS,
} = require('../services/payment.service');

// ═══════════════════════════════════════════════════════════
//   INITIATE UPI PAYMENT
//   POST /payments/initiate/:orderId
// ═══════════════════════════════════════════════════════════

exports.initiatePayment = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  // Load the order
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId, deletedAt: null },
    select: {
      id: true, orderNumber: true, status: true,
      paymentStatus: true, paymentMethod: true,
      total: true, subtotal: true, shippingCharge: true, taxAmount: true,
    },
  });

  if (!order) throw AppError.notFound('Order');

  // Only allow payment for orders awaiting payment
  const allowedStatuses = ['PENDING', 'PAYMENT_PENDING', 'PAYMENT_REJECTED'];
  if (!allowedStatuses.includes(order.status)) {
    throw AppError.badRequest(
      `Payment cannot be initiated for an order in "${order.status}" status.`,
      'PAYMENT_NOT_APPLICABLE'
    );
  }

  // Get or create payment record (within transaction)
  const payment = await withTransaction(async (tx) => {
    const rec = await getOrCreatePaymentRecord(tx, order);

    // Move order to PAYMENT_PENDING if it was just PENDING
    if (order.status === 'PENDING') {
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'PAYMENT_PENDING',
          statusHistory: {
            create: {
              fromStatus: 'PENDING',
              toStatus:   'PAYMENT_PENDING',
              note:       'Customer initiated UPI payment',
              changedBy:  userId,
            },
          },
        },
      });
    }

    return rec;
  });

  // Build UPI deep link data
  const upiLinks = await buildUpiDeepLink(order.total, payment.paymentReference, order.id);

  // Check expiry
  const isExpired  = payment.expiresAt && new Date() > new Date(payment.expiresAt);
  const expiresIn  = payment.expiresAt
    ? Math.max(0, Math.floor((new Date(payment.expiresAt) - Date.now()) / 1000 / 60))
    : null; // minutes remaining

  // Screenshots count
  const uploadCount = payment.screenshots?.length || 0;
  const canUpload   = !isExpired && uploadCount < MAX_UPLOAD_ATTEMPTS;

  logger.apiEvent('PAYMENT_INITIATED', { userId, orderId, paymentId: payment.id });

  ApiResponse.success(res, {
    payment: {
      id:               payment.id,
      reference:        payment.paymentReference,
      status:           payment.status,
      amount:           parseFloat(payment.amount),
      expiresAt:        payment.expiresAt,
      expiresInMinutes: expiresIn,
      isExpired,
      uploadAttempts:   uploadCount,
      maxAttempts:      MAX_UPLOAD_ATTEMPTS,
      canUpload,
    },
    order: {
      orderNumber: order.orderNumber,
      total:       parseFloat(order.total),
      subtotal:    parseFloat(order.subtotal),
      shipping:    parseFloat(order.shippingCharge),
      tax:         parseFloat(order.taxAmount),
    },
    upiDetails: {
      merchantUpiId:  upiLinks.merchantUpiId,
      merchantName:   upiLinks.merchantName,
      amount:         parseFloat(order.total),
      referenceCode:  payment.paymentReference,
      paymentNote:    upiLinks.displayNote,
      qrCodeUrl:      upiLinks.qrCodeUrl,
      instructions: [
        `1. Open GPay, PhonePe, Paytm, or any UPI app`,
        `2. Pay ₹${parseFloat(order.total).toFixed(2)} to ${upiLinks.merchantUpiId}`,
        `3. In the "Note/Remark" field, enter: ${payment.paymentReference}`,
        `4. Complete the payment and save your screenshot`,
        `5. Upload the screenshot here with your UTR number`,
      ],
    },
    deepLinks: {
      upi:     upiLinks.upiUri,
      gpay:    upiLinks.gpayUrl,
      phonePe: upiLinks.phonePeUrl,
      paytm:   upiLinks.paytmUrl,
    },
  }, 'Payment initiated. Please complete UPI transfer and upload screenshot.');
};

// ═══════════════════════════════════════════════════════════
//   UPLOAD PAYMENT SCREENSHOT
//   POST /payments/:orderId/upload
// ═══════════════════════════════════════════════════════════

exports.uploadScreenshot = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  // Multer already ran — file is on req.file
  if (!req.file) {
    throw AppError.badRequest('No screenshot file uploaded. Please attach an image.', 'FILE_REQUIRED');
  }

  const {
    utrNumber,
    payerName,
    paidAmount,
    paidAt,
    remarks,
  } = req.body;

  // Helper to delete file on error
  const cleanupFile = async () => {
    try {
      const fs = require('fs');
      if (req.file.path && fs.existsSync(req.file.path) && !req.file.path.startsWith('http')) {
        fs.unlinkSync(req.file.path);
      } else if (req.file.filename) {
        await deleteFromCloudinary(req.file.filename).catch(() => {});
      }
    } catch (_) {}
  };

  try {
    // ── 1. Fraud: Rate limit ──────────────────────────────────
    const rateCheck = await checkUploadRateLimit(userId);
    if (!rateCheck.allowed) {
      throw AppError.tooManyRequests('Upload limit reached (5 per hour). Please wait before trying again.');
    }

    // ── 2. Validate UTR format ────────────────────────────────
    const utrValidation = validateUtrFormat(utrNumber);
    if (!utrValidation.valid) {
      throw AppError.badRequest(utrValidation.error, 'INVALID_UTR');
    }

    // ── 3. Load order ─────────────────────────────────────────
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId, deletedAt: null },
      select: {
        id: true, orderNumber: true, status: true,
        total: true, paymentMethod: true,
      },
    });

    if (!order) {
      throw AppError.notFound('Order');
    }

    const uploadableStatuses = ['PAYMENT_PENDING', 'PAYMENT_REJECTED'];
    if (!uploadableStatuses.includes(order.status)) {
      throw AppError.badRequest(
        `Screenshots can only be uploaded for orders awaiting payment. Current status: ${order.status}.`,
        'UPLOAD_NOT_ALLOWED'
      );
    }

    // ── 4. Get existing payment record ────────────────────────
    const payment = await prisma.payment.findFirst({
      where: { orderId, status: { in: ['PENDING', 'REJECTED', 'SCREENSHOT_UPLOADED'] } },
      include: { screenshots: { where: { deletedAt: null } } },
    });

    if (!payment) {
      throw AppError.badRequest('No active payment record found. Please initiate payment first.');
    }

    // ── 5. Fraud: Validate declared amount ─────────────────────
    if (paidAmount) {
      const amountCheck = validatePaymentAmount(paidAmount, order.total);
      if (!amountCheck.valid) {
        throw AppError.badRequest(amountCheck.error, 'AMOUNT_MISMATCH');
      }
    }

    // ── 6. Fraud: Check duplicate UTR ─────────────────────────
    const dupCheck = await checkDuplicateUtr(utrValidation.cleaned, payment.id);
    if (dupCheck.isDuplicate) {
      logger.securityEvent('DUPLICATE_UTR_ATTEMPT', {
        userId,
        orderId,
        utr: utrValidation.cleaned,
        source: dupCheck.source,
      });
      throw AppError.badRequest(
        'This UTR number has already been used. Please check your UTR or contact support.',
        'DUPLICATE_UTR'
      );
    }

    // ── 7. Check max attempts ─────────────────────────────────
    const attemptNumber = payment.screenshots.length + 1;
    if (attemptNumber > MAX_UPLOAD_ATTEMPTS) {
      throw AppError.badRequest(
        `Maximum ${MAX_UPLOAD_ATTEMPTS} screenshot uploads allowed per payment. Please contact support.`,
        'MAX_ATTEMPTS_EXCEEDED'
      );
    }

    // ── 8. Save screenshot + update statuses ─────────────────
    const screenshot = await withTransaction(async (tx) => {
      // Create screenshot record
      const ss = await tx.paymentScreenshot.create({
        data: {
          paymentId:    payment.id,
          uploadedBy:   userId,
          fileUrl:      req.file.path.startsWith('http') ? req.file.path : `/uploads/${req.file.filename}`,
          publicId:     req.file.filename,
          thumbnailUrl: null,
          fileName:     req.file.originalname || 'screenshot',
          fileType:     req.file.mimetype,
          fileSizeBytes: req.file.size,
          width:        req.file.width  || null,
          height:       req.file.height || null,
          utrNumber:    utrValidation.cleaned,
          payerName:    payerName   || null,
          paidAmount:   paidAmount  ? parseFloat(paidAmount) : null,
          paidAt:       paidAt      ? new Date(paidAt) : null,
          remarks:      remarks     || null,
          status:       'PENDING_REVIEW',
          attemptNumber,
          ipAddress:    req.ip,
          userAgent:    req.headers['user-agent'],
        },
      });

      // Update payment status → SCREENSHOT_UPLOADED
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status:           'SCREENSHOT_UPLOADED',
          upiTransactionId: utrValidation.cleaned,
          upiId:            req.body.payerUpiId || null,
        },
      });

      // Update order status → SCREENSHOT_UPLOADED
      await tx.order.update({
        where: { id: orderId },
        data: {
          status:        'SCREENSHOT_UPLOADED',
          paymentStatus: 'SCREENSHOT_UPLOADED',
          statusHistory: {
            create: {
              fromStatus: order.status,
              toStatus:   'SCREENSHOT_UPLOADED',
              note:       `Screenshot uploaded by customer. UTR: ${utrValidation.cleaned}. Attempt #${attemptNumber}`,
              changedBy:  userId,
            },
          },
        },
      });

      return ss;
    });

    // ── 9. Invalidate caches ──────────────────────────────────
    await Promise.all([
      cache.del(CACHE_KEYS.userCart(userId)),
      cache.del(`order:${orderId}`),
      cache.del(paymentCacheKey(payment.id)),
    ]);

    logger.apiEvent('SCREENSHOT_UPLOADED', {
      userId,
      orderId,
      paymentId:     payment.id,
      screenshotId:  screenshot.id,
      utr:           utrValidation.cleaned,
      attemptNumber,
    });

    ApiResponse.success(res, {
      screenshotId:  screenshot.id,
      status:        'PENDING_REVIEW',
      attemptNumber,
      attemptsLeft:  MAX_UPLOAD_ATTEMPTS - attemptNumber,
      utrNumber:     utrValidation.cleaned,
      message:       'Your payment screenshot has been submitted for admin review.',
    }, `Screenshot uploaded successfully! Our team will verify it within 2–4 hours.`, 201);

  } catch (error) {
    // Perform cleanup
    await cleanupFile();
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════
//   GET PAYMENT STATUS
//   GET /payments/:orderId/status
// ═══════════════════════════════════════════════════════════

exports.getPaymentStatus = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  const cacheKey = paymentCacheKey(`status:${orderId}`);
  const cached   = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Payment status.', 200, true);

  const payment = await prisma.payment.findFirst({
    where: { orderId, order: { userId } },
    select: {
      id: true,
      paymentReference: true,
      method: true,
      status: true,
      amount: true,
      upiId: true,
      upiTransactionId: true,
      verifiedAt: true,
      rejectionReason: true,
      rejectedAt: true,
      expiresAt: true,
      createdAt: true,
      screenshots: {
        where: { deletedAt: null },
        select: {
          id: true,
          status: true,
          utrNumber: true,
          paidAmount: true,
          paidAt: true,
          attemptNumber: true,
          rejectionReason: true,
          approvalNote: true,
          reviewedAt: true,
          uploadedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!payment) throw AppError.notFound('Payment record');

  const isExpired  = payment.expiresAt && new Date() > new Date(payment.expiresAt);
  const uploadCount = payment.screenshots.length;

  const data = {
    ...payment,
    amount:        parseFloat(payment.amount),
    isExpired,
    attemptsUsed:  uploadCount,
    attemptsLeft:  Math.max(0, MAX_UPLOAD_ATTEMPTS - uploadCount),
    canUpload:     !isExpired && uploadCount < MAX_UPLOAD_ATTEMPTS
                   && ['PENDING', 'REJECTED'].includes(payment.status),
    expiresInMinutes: payment.expiresAt
      ? Math.max(0, Math.floor((new Date(payment.expiresAt) - Date.now()) / 60000))
      : null,
  };

  await cache.set(cacheKey, data, 60); // 1min cache
  ApiResponse.success(res, data, 'Payment status.');
};

// ═══════════════════════════════════════════════════════════
//   LIST MY SCREENSHOTS
//   GET /payments/:orderId/screenshots
// ═══════════════════════════════════════════════════════════

exports.getMyScreenshots = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  const payment = await prisma.payment.findFirst({
    where: { orderId, order: { userId } },
    select: { id: true },
  });

  if (!payment) throw AppError.notFound('Payment');

  const screenshots = await prisma.paymentScreenshot.findMany({
    where: { paymentId: payment.id, deletedAt: null },
    select: {
      id: true,
      fileUrl: true,
      thumbnailUrl: true,
      utrNumber: true,
      paidAmount: true,
      paidAt: true,
      status: true,
      attemptNumber: true,
      rejectionReason: true,
      approvalNote: true,
      reviewedAt: true,
      uploadedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  ApiResponse.success(res, screenshots, `${screenshots.length} screenshot(s).`);
};

// ═══════════════════════════════════════════════════════════
//   GET FULL PAYMENT DETAILS
//   GET /payments/:orderId
// ═══════════════════════════════════════════════════════════

exports.getPaymentDetails = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  const payment = await prisma.payment.findFirst({
    where: { orderId, order: { userId } },
    include: {
      screenshots: {
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!payment) throw AppError.notFound('Payment');
  ApiResponse.success(res, payment);
};

// ═══════════════════════════════════════════════════════════
//   GET UPI PAYMENT INSTRUCTIONS
//   GET /payments/:orderId/instructions
// ═══════════════════════════════════════════════════════════

exports.getPaymentInstructions = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: { id: true, orderNumber: true, total: true, status: true },
  });

  if (!order) throw AppError.notFound('Order');

  const payment = await prisma.payment.findFirst({
    where: { orderId },
    select: { paymentReference: true, amount: true, expiresAt: true, status: true },
  });

  if (!payment) throw AppError.notFound('Payment record. Please initiate payment first.');

  const upiLinks = await buildUpiDeepLink(order.total, payment.paymentReference, order.id);

  ApiResponse.success(res, {
    reference:     payment.paymentReference,
    amount:        parseFloat(order.total),
    merchantUpiId: upiLinks.merchantUpiId,
    merchantName:  upiLinks.merchantName,
    paymentNote:   upiLinks.displayNote,
    qrCodeUrl:     upiLinks.qrCodeUrl,
    expiresAt:     payment.expiresAt,
    deepLinks: {
      upi:     upiLinks.upiUri,
      gpay:    upiLinks.gpayUrl,
      phonePe: upiLinks.phonePeUrl,
      paytm:   upiLinks.paytmUrl,
    },
    steps: [
      `Open GPay / PhonePe / Paytm or any UPI app`,
      `Send ₹${parseFloat(order.total).toFixed(2)} to ${upiLinks.merchantUpiId}`,
      `Add remark/note: "${payment.paymentReference}"`,
      `Take a full screenshot showing: ✓ Amount  ✓ UPI ID  ✓ UTR number  ✓ Date`,
      `Upload the screenshot with your UTR number`,
    ],
  }, 'UPI payment instructions.');
};
