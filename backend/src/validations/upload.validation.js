/**
 * validations/upload.validation.js
 * ==================================
 * Zod schemas for upload-related endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Delete Single Image ──────────────────────────────────────────────────────
exports.deleteImageSchema = z.object({
  publicId: z
    .string({ required_error: 'publicId is required.' })
    .min(5,   'Invalid publicId.')
    .max(500, 'publicId too long.'),
});

// ─── Bulk Delete Images ───────────────────────────────────────────────────────
exports.bulkDeleteSchema = z.object({
  publicIds: z
    .array(z.string().min(5).max(500))
    .min(1,  'At least one publicId is required.')
    .max(50, 'Cannot delete more than 50 images at once.'),
});

// ─── Transform URL ────────────────────────────────────────────────────────────
exports.transformSchema = z.object({
  publicId: z
    .string({ required_error: 'publicId is required.' })
    .min(5)
    .max(500),

  preset: z
    .enum(['thumbnail', 'card', 'large', 'banner', 'avatar', 'blur'])
    .default('card'),

  transforms: z
    .record(z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .default({}),
});

// ─── Signed URL ───────────────────────────────────────────────────────────────
exports.signedUrlSchema = z.object({
  publicId: z
    .string({ required_error: 'publicId is required.' })
    .min(5)
    .max(500),

  expiresInSeconds: z
    .coerce.number()
    .int()
    .min(60,         'Minimum expiry: 60 seconds.')
    .max(86400,      'Maximum expiry: 24 hours (86400 seconds).')
    .default(3600),
});

// ─── Asset Info ───────────────────────────────────────────────────────────────
exports.assetInfoSchema = z.object({
  publicId: z
    .string({ required_error: 'publicId is required.' })
    .min(5)
    .max(500),
});
