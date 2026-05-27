/**
 * validations/product.validation.js
 * ====================================
 * Zod schemas for all product management endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Shared fields ────────────────────────────────────────────────────────────
const priceField = (label = 'Price') =>
  z.number({ required_error: `${label} is required.`, invalid_type_error: `${label} must be a number.` })
    .min(0, `${label} cannot be negative.`)
    .max(99999.99, `${label} is too high.`);

const optionalPriceField = () =>
  z.number().min(0).max(99999.99).optional().nullable();

const stockField = () =>
  z.number().int('Stock must be a whole number.').min(0, 'Stock cannot be negative.').max(999999);

// ─── Create Product ───────────────────────────────────────────────────────────
exports.createProductSchema = z.object({
  name: z
    .string({ required_error: 'Product name is required.' })
    .min(3, 'Name must be at least 3 characters.')
    .max(200, 'Name must not exceed 200 characters.')
    .trim(),

  sku: z
    .string()
    .min(2, 'SKU too short.')
    .max(50, 'SKU too long.')
    .regex(/^[A-Z0-9_-]+$/i, 'SKU can only contain letters, numbers, hyphens and underscores.')
    .toUpperCase()
    .optional(),

  description: z
    .string({ required_error: 'Description is required.' })
    .min(20, 'Description must be at least 20 characters.')
    .trim(),

  shortDescription: z.string().max(500).optional().nullable(),
  categoryId: z.string({ required_error: 'Category is required.' }).uuid('Invalid category ID.'),

  basePrice:    priceField('Price'),
  comparePrice: optionalPriceField(),
  costPrice:    optionalPriceField(),
  taxPercent:   z.number().min(0).max(100).default(18),
  taxInclusive: z.boolean().default(true),

  stock:             stockField().default(0),
  lowStockThreshold: z.number().int().min(0).default(10),
  trackInventory:    z.boolean().default(true),
  allowBackorder:    z.boolean().default(false),

  weight:     z.number().min(0).max(50000).optional().nullable(),
  dimensions: z.object({
    length: z.number().min(0).optional(),
    width:  z.number().min(0).optional(),
    height: z.number().min(0).optional(),
  }).optional().nullable(),

  ingredients:    z.string().optional().nullable(),
  allergens:      z.string().max(500).optional().nullable(),
  shelfLife:      z.string().max(100).optional().nullable(),
  storageInfo:    z.string().max(300).optional().nullable(),
  madeIn:         z.string().max(100).optional().nullable(),
  certifications: z.array(z.string()).optional().default([]),
  nutritionInfo:  z.record(z.any()).optional().nullable(),

  tags:           z.array(z.string().trim().toLowerCase()).optional().default([]),
  searchKeywords: z.string().optional().nullable(),

  isActive:    z.boolean().default(true),
  isFeatured:  z.boolean().default(false),
  isBestseller:z.boolean().default(false),
  isNewArrival:z.boolean().default(false),
  isOnSale:    z.boolean().default(false),

  metaTitle:       z.string().max(70).optional().nullable(),
  metaDescription: z.string().max(160).optional().nullable(),
})
.refine(
  (d) => !d.comparePrice || d.comparePrice >= d.basePrice,
  { message: 'Compare price must be greater than or equal to the selling price.', path: ['comparePrice'] }
);

exports.updateProductSchema = exports.createProductSchema
  .partial()
  .refine(
    (d) => !d.comparePrice || !d.basePrice || d.comparePrice >= d.basePrice,
    { message: 'Compare price must be >= selling price.', path: ['comparePrice'] }
  );

exports.createVariantSchema = z.object({
  name:         z.string({ required_error: 'Variant name is required.' }).min(1).max(100).trim(),
  sku:          z.string({ required_error: 'Variant SKU is required.' }).min(2).max(50).toUpperCase(),
  price:        priceField('Variant price'),
  comparePrice: optionalPriceField(),
  costPrice:    optionalPriceField(),
  stock:        stockField().default(0),
  attributes:   z.record(z.any()).optional().nullable(),
  imageUrl:     z.string().url().optional().nullable(),
  sortOrder:    z.number().int().min(0).default(0),
  isActive:     z.boolean().default(true),
  isDefault:    z.boolean().default(false),
});

exports.updateVariantSchema = exports.createVariantSchema.partial();

exports.updateStockSchema = z.object({
  stock:     stockField(),
  variantId: z.string().uuid().optional().nullable(),
  reason:    z.enum(['manual_adjustment', 'purchase_received', 'damaged', 'returned', 'correction', 'other']).default('manual_adjustment'),
  note:      z.string().max(300).optional(),
});

exports.createCategorySchema = z.object({
  name:            z.string({ required_error: 'Category name is required.' }).min(2).max(100).trim(),
  slug:            z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug: lowercase letters, numbers, hyphens only.').optional(),
  description:     z.string().max(500).optional().nullable(),
  icon:            z.string().max(50).optional().nullable(),
  parentId:        z.string().uuid().optional().nullable(),
  sortOrder:       z.number().int().min(0).default(0),
  isActive:        z.boolean().default(true),
  isFeatured:      z.boolean().default(false),
  metaTitle:       z.string().max(70).optional().nullable(),
  metaDescription: z.string().max(160).optional().nullable(),
});

exports.updateCategorySchema = exports.createCategorySchema.partial();

exports.searchQuerySchema = z.object({
  q:        z.string().min(2).optional(),
  category: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  rating:   z.coerce.number().min(1).max(5).optional(),
  sort:     z.enum(['newest', 'oldest', 'price', '-price', 'rating', '-rating', 'sold', '-sold', 'name', '-name']).default('newest'),
  page:     z.coerce.number().int().min(1).default(1),
  limit:    z.coerce.number().int().min(1).max(100).default(20),
  inStock:  z.enum(['true', 'false']).optional(),
  onSale:   z.enum(['true', 'false']).optional(),
  tags:     z.string().optional(),
}).refine(
  (d) => !d.minPrice || !d.maxPrice || d.minPrice <= d.maxPrice,
  { message: 'minPrice must be <= maxPrice.', path: ['minPrice'] }
);

exports.bulkStatusSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(100),
  isActive:   z.boolean(),
});

exports.bulkDeleteSchema = z.object({
  productIds: z.array(z.string().uuid()).min(1).max(100),
});
