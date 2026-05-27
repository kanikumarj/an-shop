/**
 * validations/category.validation.js
 */
'use strict';
const { z } = require('zod');

exports.categorySchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  parentId: z.string().uuid().optional().nullable(),
  icon: z.string().max(50).optional(),
  isActive: z.boolean().default(true).or(z.string().transform((v) => v !== 'false')),
  sortOrder: z.preprocess((v) => (v === undefined || v === null ? undefined : Number(v)), z.number().int().default(0)),
});
