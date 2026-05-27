/**
 * validations/cart.validation.js
 * ================================
 * Zod schemas for all cart endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Add to Cart ──────────────────────────────────────────────────────────────
exports.addToCartSchema = z.object({
  productId: z
    .string({ required_error: 'Product ID is required.' })
    .uuid('Invalid product ID.'),

  variantId: z
    .string()
    .uuid('Invalid variant ID.')
    .optional()
    .nullable(),

  quantity: z
    .number({ invalid_type_error: 'Quantity must be a number.' })
    .int('Quantity must be a whole number.')
    .min(1, 'Quantity must be at least 1.')
    .max(50, 'Maximum 50 units per item.')
    .default(1),

  notes: z
    .string()
    .max(300, 'Notes must not exceed 300 characters.')
    .optional()
    .nullable(),
});

// ─── Update Cart Item ─────────────────────────────────────────────────────────
exports.updateCartSchema = z.object({
  quantity: z
    .number({ required_error: 'Quantity is required.', invalid_type_error: 'Quantity must be a number.' })
    .int('Quantity must be a whole number.')
    .min(1, 'Quantity must be at least 1.')
    .max(50, 'Maximum 50 units per item.'),
});

// ─── Batch Add ────────────────────────────────────────────────────────────────
exports.batchAddSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid('Invalid product ID.'),
        variantId: z.string().uuid().optional().nullable(),
        quantity:  z.number().int().min(1).max(50).default(1),
      })
    )
    .min(1, 'At least one item is required.')
    .max(20, 'Maximum 20 items per batch.'),
});

// ─── Apply Coupon ─────────────────────────────────────────────────────────────
exports.applyCouponSchema = z.object({
  code: z
    .string({ required_error: 'Coupon code is required.' })
    .min(3, 'Invalid coupon code.')
    .max(30, 'Coupon code is too long.')
    .toUpperCase()
    .trim(),
});

// ─── Guest Cart Sync ──────────────────────────────────────────────────────────
exports.syncCartSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().optional().nullable(),
        quantity:  z.number().int().min(1).max(50).default(1),
      })
    )
    .max(30, 'Cannot sync more than 30 items at once.'),
});

// ─── Update Item Notes ────────────────────────────────────────────────────────
exports.updateNotesSchema = z.object({
  notes: z
    .string()
    .max(300, 'Notes must not exceed 300 characters.')
    .optional()
    .nullable(),
});
