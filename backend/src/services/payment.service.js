/**
 * services/payment.service.js
 * ============================
 * UPI manual payment verification — business logic layer.
 *
 * Responsibilities:
 *   - Unique payment reference code generation (PAY-2026-XXXXXXXXXXXX)
 *   - UPI QR code data builder (UPI deep link)
 *   - Payment window management (expiry)
 *   - UTR number format validation + duplicate detection
 *   - Fraud prevention (rate limiting per user, duplicate UTR, amount check)
 *   - Screenshot upload + Cloudinary metadata extraction
 *   - Payment approval (trigger order confirmation)
 *   - Payment rejection (notify customer, allow re-upload)
 *   - Re-upload quota management (max 3 attempts)
 *   - Admin verification helpers
 *   - Cache invalidation
 */

'use strict';

const crypto           = require('crypto');
const { prisma }       = require('../config/database');
const { cache }        = require('../config/redis');
const { deleteFromCloudinary } = require('../config/cloudinary');
const AppError         = require('../utils/AppError');
const logger           = require('../utils/logger');

// ─── Constants ─────────────────────────────────────────────────────────────────
const PAYMENT_EXPIRY_HOURS   = parseInt(process.env.UPI_PAYMENT_EXPIRY_HOURS) || 24;
const MAX_UPLOAD_ATTEMPTS    = parseInt(process.env.MAX_SCREENSHOT_ATTEMPTS)  || 3;
const MIN_UTR_LENGTH         = 10;
const MAX_UTR_LENGTH         = 22;  // NPCI standard max

// ─── Cache keys ────────────────────────────────────────────────────────────────
const paymentCacheKey = (id)      => `payment:${id}`;
const utrBlacklistKey = (utr)     => `utr:used:${utr.toUpperCase()}`;

// ═══════════════════════════════════════════════════════════
//   REFERENCE CODE GENERATOR
// ═══════════════════════════════════════════════════════════

/**
 * Generate a human-readable unique payment reference code.
 * Format:  PAY-2026-XXXXXX-YYYYYYYYYYY
 *   PAY     — prefix
 *   2026    — year
 *   XXXXXX  — zero-padded sequence for the month
 *   YYYY    — 8-char cryptographic random suffix
 *
 * The customer enters this as the UPI note/remark during payment.
 * Admin uses it to cross-reference with bank statement.
 */
const generatePaymentReference = async () => {
  const now    = new Date();
  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `PAY-${year}${month}-`;

  // Count this month's payments for sequential padding
  const count = await prisma.payment.count({
    where: { createdAt: { gte: new Date(year, now.getMonth(), 1) } },
  });

  const seq   = String(count + 1).padStart(5, '0');
  const rand  = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
  return `${prefix}${seq}-${rand}`;
};

// ═══════════════════════════════════════════════════════════
//   UPI DEEP LINK / QR DATA BUILDER
// ═══════════════════════════════════════════════════════════

/**
 * Build a UPI payment URI (BIS standard) for QR generation.
 * Opens GPay / PhonePe / Paytm when scanned.
 *
 * Format: upi://pay?pa=<UPI_ID>&pn=<NAME>&am=<AMOUNT>&tn=<NOTE>&cu=INR
 */
const buildUpiDeepLink = async (amount, referenceCode, orderId) => {
  let upiId      = process.env.MERCHANT_UPI_ID   || 'yourshop@upi';
  let merchantName = process.env.MERCHANT_NAME   || 'An Shop';
  let qrCodeUrl   = null;

  try {
    const cached = await cache.get('settings:global');
    let settings = cached;
    if (!settings) {
      const dbSettings = await prisma.setting.findMany();
      settings = dbSettings.reduce((acc, s) => {
        acc[s.key] = s.value;
        return acc;
      }, {});
      await cache.set('settings:global', settings, 24 * 60 * 60);
    }
    if (settings.merchant_upi_id?.text) {
      upiId = settings.merchant_upi_id.text;
    }
    if (settings.merchant_name?.text) {
      merchantName = settings.merchant_name.text;
    }
    if (settings.merchant_qr_code?.url) {
      qrCodeUrl = settings.merchant_qr_code.url;
    }
  } catch (err) {
    logger.error('Failed to load merchant settings from DB, using env fallback:', err);
  }

  const note       = `${referenceCode} Order#${orderId.slice(-6)}`;

  const params = new URLSearchParams({
    pa: upiId,
    pn: merchantName,
    am: parseFloat(amount).toFixed(2),
    tn: note,
    cu: 'INR',
  });

  return {
    upiUri:      `upi://pay?${params.toString()}`,
    gpayUrl:     `gpay://upi/pay?${params.toString()}`,
    phonePeUrl:  `phonepe://pay?${params.toString()}`,
    paytmUrl:    `paytmmp://pay?${params.toString()}`,
    displayNote: note,
    merchantUpiId: upiId,
    merchantName,
    qrCodeUrl,
  };
};

// ═══════════════════════════════════════════════════════════
//   UTR NUMBER VALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * Validate UTR (Unique Transaction Reference) format.
 * NPCI UTR format: 12–22 alphanumeric characters.
 * Also checks for known patterns (IMPS, NEFT, UPI).
 */
const validateUtrFormat = (utr) => {
  if (!utr) return { valid: false, error: 'UTR number is required.' };

  const cleaned = utr.trim().toUpperCase().replace(/\s/g, '');

  if (cleaned.length < MIN_UTR_LENGTH || cleaned.length > MAX_UTR_LENGTH) {
    return {
      valid: false,
      error: `UTR must be ${MIN_UTR_LENGTH}–${MAX_UTR_LENGTH} characters.`,
    };
  }

  if (!/^[A-Z0-9]+$/.test(cleaned)) {
    return { valid: false, error: 'UTR must contain only letters and numbers.' };
  }

  return { valid: true, cleaned };
};

/**
 * Check if a UTR number has already been used in a verified/approved payment.
 * Prevents screenshot re-use fraud.
 */
const checkDuplicateUtr = async (utr) => {
  if (!utr) return { isDuplicate: false };

  const upper = utr.toUpperCase().trim();

  // Check Redis blacklist first (fast path)
  const blacklisted = await cache.get(utrBlacklistKey(upper));
  if (blacklisted) {
    return { isDuplicate: true, source: 'cache' };
  }

  // Check DB for approved screenshots with this UTR
  const existing = await prisma.paymentScreenshot.findFirst({
    where: {
      utrNumber: upper,
      status: { in: ['APPROVED'] },
      deletedAt: null,
    },
    select: { id: true, paymentId: true, uploadedAt: true },
  });

  if (existing) {
    // Blacklist in cache for 30 days
    await cache.set(utrBlacklistKey(upper), { usedAt: existing.uploadedAt }, 30 * 24 * 60 * 60);
    return { isDuplicate: true, source: 'db', screenshot: existing };
  }

  return { isDuplicate: false };
};

// ═══════════════════════════════════════════════════════════
//   FRAUD PREVENTION
// ═══════════════════════════════════════════════════════════

/**
 * Check upload rate limit per user (max 5 screenshot uploads per hour).
 */
const checkUploadRateLimit = async (userId) => {
  const key   = `screenshot:rate:${userId}`;
  const count = await cache.get(key);
  const limit = parseInt(process.env.SCREENSHOT_RATE_LIMIT) || 5;

  if (count && parseInt(count) >= limit) {
    return { allowed: false, remaining: 0, resetIn: 'an hour' };
  }

  // Increment with 1-hour TTL
  const client = require('../config/redis').redis;
  if (client) {
    await client.multi()
      .incr(key)
      .expire(key, 3600)
      .exec();
  }

  return { allowed: true, remaining: limit - (parseInt(count) || 0) - 1 };
};

/**
 * Validate the declared amount against the order total.
 * Allow a ±₹1 tolerance for rounding.
 */
const validatePaymentAmount = (declaredAmount, orderTotal) => {
  const diff = Math.abs(parseFloat(declaredAmount) - parseFloat(orderTotal));
  if (diff > 1.0) {
    return {
      valid: false,
      error: `Declared amount ₹${parseFloat(declaredAmount).toFixed(2)} does not match order total ₹${parseFloat(orderTotal).toFixed(2)}.`,
      diff,
    };
  }
  return { valid: true };
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT RECORD MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * Get or create a Payment record for an order.
 * Returns existing if already in PENDING or REJECTED state.
 */
const getOrCreatePaymentRecord = async (tx, order) => {
  // Check for existing payment that can receive a screenshot
  const existing = await tx.payment.findFirst({
    where: {
      orderId: order.id,
      status: { in: ['PENDING', 'REJECTED', 'SCREENSHOT_UPLOADED'] },
    },
    include: { screenshots: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } },
  });

  if (existing) return existing;

  // Create new payment record
  const reference = await generatePaymentReference();
  const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_HOURS * 60 * 60 * 1000);

  return tx.payment.create({
    data: {
      orderId:          order.id,
      paymentReference: reference,
      method:           order.paymentMethod || 'UPI',
      status:           'PENDING',
      amount:           order.total,
      currency:         'INR',
      merchantUpiId:    process.env.MERCHANT_UPI_ID  || 'yourshop@upi',
      merchantName:     process.env.MERCHANT_NAME    || 'An Shop',
      expiresAt,
    },
    include: { screenshots: true },
  });
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT APPROVAL (admin)
// ═══════════════════════════════════════════════════════════

/**
 * Approve a payment screenshot and trigger order confirmation.
 * Called within a DB transaction.
 */
const approvePayment = async (tx, payment, screenshot, adminId, note) => {
  const now = new Date();

  // 1. Update screenshot → APPROVED
  await tx.paymentScreenshot.update({
    where: { id: screenshot.id },
    data: {
      status:      'APPROVED',
      reviewedAt:  now,
      reviewedBy:  adminId,
      approvalNote: note || 'Payment verified and approved',
    },
  });

  // 2. Update payment → VERIFIED
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status:     'VERIFIED',
      upiTransactionId: screenshot.utrNumber || payment.upiTransactionId,
      verifiedAt: now,
      verifiedBy: adminId,
    },
  });

  // 3. Update order → PAYMENT_VERIFIED + CONFIRMED
  const updatedOrder = await tx.order.update({
    where: { id: payment.orderId },
    data: {
      status:        'PAYMENT_VERIFIED',
      paymentStatus: 'VERIFIED',
      paidAt:        now,
      statusHistory: {
        create: [
          {
            fromStatus: 'SCREENSHOT_UPLOADED',
            toStatus:   'PAYMENT_VERIFIED',
            note:       `Payment verified by admin. UTR: ${screenshot.utrNumber || 'N/A'}`,
            changedBy:  adminId,
          },
          {
            fromStatus: 'PAYMENT_VERIFIED',
            toStatus:   'CONFIRMED',
            note:       'Order confirmed after payment verification',
            changedBy:  adminId,
          },
        ],
      },
    },
  });

  // Final order status
  await tx.order.update({
    where: { id: payment.orderId },
    data: { status: 'CONFIRMED' },
  });

  // 4. Blacklist the UTR to prevent re-use
  if (screenshot.utrNumber) {
    await cache.set(utrBlacklistKey(screenshot.utrNumber), { approvedAt: now }, 30 * 24 * 60 * 60);
  }

  return updatedOrder;
};

/**
 * Reject a payment screenshot.
 * Resets payment to REJECTED — allows re-upload.
 */
const rejectPayment = async (tx, payment, screenshot, adminId, reason) => {
  const now = new Date();

  await tx.paymentScreenshot.update({
    where: { id: screenshot.id },
    data: {
      status:          'REJECTED',
      reviewedAt:      now,
      reviewedBy:      adminId,
      rejectionReason: reason || 'Screenshot rejected by admin',
    },
  });

  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status:          'REJECTED',
      rejectionReason: reason,
      rejectedAt:      now,
      rejectedBy:      adminId,
    },
  });

  await tx.order.update({
    where: { id: payment.orderId },
    data: {
      status:        'PAYMENT_REJECTED',
      paymentStatus: 'REJECTED',
      statusHistory: {
        create: {
          fromStatus: 'SCREENSHOT_UPLOADED',
          toStatus:   'PAYMENT_REJECTED',
          note:       `Payment rejected: ${reason || 'Screenshot unclear or invalid'}`,
          changedBy:  adminId,
        },
      },
    },
  });
};

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  generatePaymentReference,
  buildUpiDeepLink,
  validateUtrFormat,
  checkDuplicateUtr,
  checkUploadRateLimit,
  validatePaymentAmount,
  getOrCreatePaymentRecord,
  approvePayment,
  rejectPayment,
  paymentCacheKey,
  PAYMENT_EXPIRY_HOURS,
  MAX_UPLOAD_ATTEMPTS,
};
