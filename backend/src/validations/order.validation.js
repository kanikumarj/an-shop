/**
 * validations/order.validation.js
 * ==================================
 * Zod schemas for all order endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Order Status Enum ────────────────────────────────────────────────────────
const ORDER_STATUSES = [
  'DRAFT', 'PENDING', 'PAYMENT_PENDING', 'SCREENSHOT_UPLOADED',
  'PAYMENT_VERIFIED', 'PAYMENT_REJECTED', 'CONFIRMED',
  'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY',
  'DELIVERED', 'CANCELLED', 'REFUND_REQUESTED', 'REFUNDED', 'RETURNED',
];

// ─── Create Order ─────────────────────────────────────────────────────────────
exports.createOrderSchema = z.object({
  addressId: z
    .string()
    .uuid('Invalid address ID.')
    .optional()
    .nullable(),

  paymentMethod: z
    .enum(['UPI', 'BANK_TRANSFER', 'CASH_ON_DELIVERY', 'RAZORPAY', 'PAYTM'], {
      invalid_type_error: 'Invalid payment method.',
    })
    .default('UPI'),

  couponCode: z
    .string()
    .min(3)
    .max(30)
    .toUpperCase()
    .trim()
    .optional()
    .nullable(),

  customerNotes: z
    .string()
    .max(500, 'Notes must not exceed 500 characters.')
    .optional()
    .nullable(),
});

// ─── Cancel Order ─────────────────────────────────────────────────────────────
exports.cancelOrderSchema = z.object({
  reason: z
    .string()
    .min(5, 'Please provide a reason (at least 5 characters).')
    .max(500, 'Reason must not exceed 500 characters.')
    .optional()
    .nullable(),
});

// ─── Return Request ───────────────────────────────────────────────────────────
exports.returnRequestSchema = z.object({
  reason: z
    .string({ required_error: 'Return reason is required.' })
    .min(10, 'Please describe the reason (at least 10 characters).')
    .max(500),

  itemIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one item to return.')
    .optional(),
});

// ─── Refund Request ───────────────────────────────────────────────────────────
exports.refundRequestSchema = z.object({
  reason: z
    .string()
    .min(5, 'Please provide a reason.')
    .max(500)
    .optional(),

  bankAccount: z
    .string()
    .max(200)
    .optional()
    .nullable(),
});

// ─── Admin: Update Status ──────────────────────────────────────────────────────
exports.updateStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, {
    required_error: 'Status is required.',
    invalid_type_error: 'Invalid order status.',
  }),

  note: z
    .string()
    .max(500)
    .optional()
    .nullable(),

  force: z
    .boolean()
    .default(false),
});

// ─── Admin: Verify Payment ────────────────────────────────────────────────────
exports.verifyPaymentSchema = z.object({
  action: z.enum(['APPROVE', 'REJECT'], {
    required_error: 'action must be "APPROVE" or "REJECT".',
  }),

  note: z
    .string()
    .max(300)
    .optional()
    .nullable(),

  rejectionReason: z
    .string()
    .max(300)
    .optional()
    .nullable(),
}).refine(
  (d) => d.action !== 'REJECT' || !!d.rejectionReason,
  { message: 'rejectionReason is required when action is "REJECT".', path: ['rejectionReason'] }
);

// ─── Admin: Ship Order ────────────────────────────────────────────────────────
exports.shipOrderSchema = z.object({
  trackingNumber: z
    .string({ required_error: 'Tracking number is required.' })
    .min(3, 'Invalid tracking number.')
    .max(100),

  courierName: z
    .string({ required_error: 'Courier name is required.' })
    .min(2)
    .max(100),

  courierUrl: z
    .string()
    .url('Invalid courier tracking URL.')
    .optional()
    .nullable(),

  estimatedDelivery: z
    .string()
    .datetime({ message: 'Invalid date format. Use ISO 8601 (e.g., 2026-06-01T00:00:00Z).' })
    .optional()
    .nullable(),

  note: z
    .string()
    .max(300)
    .optional()
    .nullable(),
});

// ─── Admin: Process Refund ────────────────────────────────────────────────────
exports.processRefundSchema = z.object({
  amount: z
    .number()
    .min(1, 'Refund amount must be at least ₹1.')
    .optional()
    .nullable(),

  transactionRef: z
    .string()
    .max(100)
    .optional()
    .nullable(),

  note: z
    .string()
    .max(500)
    .optional()
    .nullable(),
});

// ─── Admin: Mark Delivered ────────────────────────────────────────────────────
exports.markDeliveredSchema = z.object({
  note: z.string().max(300).optional().nullable(),
});

// ─── Admin: Cancel Order ──────────────────────────────────────────────────────
exports.adminCancelSchema = z.object({
  reason: z.string().min(5).max(500),
  restoreStock: z.boolean().default(true),
});

// ─── Admin: Notes ─────────────────────────────────────────────────────────────
exports.adminNotesSchema = z.object({
  notes: z
    .string({ required_error: 'Notes content is required.' })
    .max(2000, 'Notes must not exceed 2000 characters.'),
});
