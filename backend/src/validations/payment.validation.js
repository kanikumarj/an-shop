/**
 * validations/payment.validation.js
 * ====================================
 * Zod schemas for all UPI payment endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Upload Screenshot ────────────────────────────────────────────────────────
exports.uploadScreenshotSchema = z.object({
  utrNumber: z
    .string({ required_error: 'UTR number is required.' })
    .min(10, 'UTR must be at least 10 characters.')
    .max(22,  'UTR must not exceed 22 characters.')
    .regex(/^[A-Z0-9]+$/i, 'UTR must contain only letters and numbers.')
    .toUpperCase()
    .trim(),

  payerName: z
    .string()
    .max(100, 'Payer name must not exceed 100 characters.')
    .optional()
    .nullable(),

  payerUpiId: z
    .string()
    .max(50, 'UPI ID too long.')
    .optional()
    .nullable(),

  paidAmount: z
    .coerce.number()
    .min(1, 'Paid amount must be at least ₹1.')
    .max(999999, 'Paid amount exceeds limit.')
    .optional()
    .nullable(),

  paidAt: z
    .string()
    .datetime({ message: 'Invalid date format. Use ISO 8601.' })
    .optional()
    .nullable(),

  remarks: z
    .string()
    .max(500, 'Remarks must not exceed 500 characters.')
    .optional()
    .nullable(),
});

// ─── Admin: Approve Payment ───────────────────────────────────────────────────
exports.approvePaymentSchema = z.object({
  screenshotId: z
    .string()
    .uuid('Invalid screenshot ID.')
    .optional()
    .nullable(),

  note: z
    .string()
    .max(500, 'Note must not exceed 500 characters.')
    .optional()
    .nullable(),
});

// ─── Admin: Reject Payment ────────────────────────────────────────────────────
exports.rejectPaymentSchema = z.object({
  reason: z
    .string({ required_error: 'Rejection reason is required.' })
    .min(5,   'Please provide a detailed reason (at least 5 characters).')
    .max(500, 'Reason must not exceed 500 characters.'),

  screenshotId: z
    .string()
    .uuid()
    .optional()
    .nullable(),

  notifyCustomer: z
    .boolean()
    .default(true),
});

// ─── Admin: Flag Payment ──────────────────────────────────────────────────────
exports.flagPaymentSchema = z.object({
  reason: z
    .string({ required_error: 'Flag reason is required.' })
    .min(5)
    .max(300),
});

// ─── Admin: Query Filters ─────────────────────────────────────────────────────
exports.paymentQuerySchema = z.object({
  status:  z.enum([
    'PENDING', 'SCREENSHOT_UPLOADED', 'VERIFIED',
    'REJECTED', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED',
  ]).optional(),
  method:  z.enum(['UPI', 'BANK_TRANSFER', 'CASH_ON_DELIVERY', 'RAZORPAY', 'PAYTM']).optional(),
  from:    z.string().datetime().optional(),
  to:      z.string().datetime().optional(),
  q:       z.string().min(2).optional(),
  page:    z.coerce.number().int().min(1).default(1),
  limit:   z.coerce.number().int().min(1).max(100).default(20),
  sortBy:  z.enum(['updatedAt', 'createdAt', 'amount']).default('updatedAt'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
