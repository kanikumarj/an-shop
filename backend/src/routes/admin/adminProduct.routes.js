/**
 * routes/admin/adminProduct.routes.js  [ENTERPRISE EDITION]
 * ===========================================================
 * Admin product management — CRUD, images, variants, stock, categories.
 *
 * All routes require: JWT auth + ADMIN or SUPERADMIN role.
 */

'use strict';

const { Router } = require('express');
const adminProductController = require('../../controllers/admin/adminProduct.controller');
const { protect, adminOnly } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const {
  uploadProductImages,
  uploadCategoryImage,
} = require('../../config/cloudinary');

// ── Zod Schemas ────────────────────────────────────────────────────────────────
const {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
  updateStockSchema,
  createCategorySchema,
  updateCategorySchema,
  bulkStatusSchema,
  bulkDeleteSchema,
} = require('../../validations/product.validation');

const router = Router();

// All admin product routes require authentication + admin role
router.use(protect, adminOnly);

// ─────────────────────────────────────────────────────────────────────────────
//   ANALYTICS & DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/products/analytics
router.get('/analytics', adminProductController.getProductAnalytics);

// ─────────────────────────────────────────────────────────────────────────────
//   BULK OPERATIONS  (before /:id to avoid route conflict)
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /admin/products/bulk/status
router.patch('/bulk/status',
  validate(bulkStatusSchema),
  adminProductController.bulkUpdateStatus
);

// PATCH /admin/products/bulk/delete
router.patch('/bulk/delete',
  validate(bulkDeleteSchema),
  adminProductController.bulkDelete
);

// ─────────────────────────────────────────────────────────────────────────────
//   PRODUCT CRUD
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/products
// Query: ?page=1&limit=20&sort=newest&isActive=true&category=uuid&deleted=false
router.get('/', adminProductController.listProducts);

// POST /admin/products  (with optional image upload)
router.post('/',
  uploadProductImages,
  validate(createProductSchema),
  adminProductController.createProduct
);

// GET /admin/products/:id
router.get('/:id', adminProductController.getProduct);

// PUT /admin/products/:id  (all fields)
router.put('/:id',
  validate(updateProductSchema),
  adminProductController.updateProduct
);

// DELETE /admin/products/:id  (soft delete)
router.delete('/:id', adminProductController.deleteProduct);

// DELETE /admin/products/:id/permanent  (hard delete + Cloudinary cleanup)
router.delete('/:id/permanent', adminProductController.hardDeleteProduct);

// POST /admin/products/:id/restore  (undo soft delete)
router.post('/:id/restore', adminProductController.restoreProduct);

// ─────────────────────────────────────────────────────────────────────────────
//   IMAGE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/products/:id/images  — Upload multiple images (max 8)
router.post('/:id/images',
  uploadProductImages,
  adminProductController.uploadProductImages
);

// DELETE /admin/products/:id/images/:imageId
router.delete('/:id/images/:imageId', adminProductController.deleteProductImage);

// PATCH /admin/products/:id/images/primary  — Set primary image
// Body: { imageId: "uuid" }
router.patch('/:id/images/primary', adminProductController.setPrimaryImage);

// PATCH /admin/products/:id/images/reorder  — Reorder images
// Body: { orderedImageIds: ["id1", "id2", "id3"] }
router.patch('/:id/images/reorder', adminProductController.reorderImages);

// ─────────────────────────────────────────────────────────────────────────────
//   VARIANT MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/products/:id/variants
router.post('/:id/variants',
  validate(createVariantSchema),
  adminProductController.createVariant
);

// PUT /admin/products/:id/variants/:vid
router.put('/:id/variants/:vid',
  validate(updateVariantSchema),
  adminProductController.updateVariant
);

// DELETE /admin/products/:id/variants/:vid
router.delete('/:id/variants/:vid', adminProductController.deleteVariant);

// ─────────────────────────────────────────────────────────────────────────────
//   STOCK MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// PATCH /admin/products/:id/stock
// Body: { stock: 100, reason: "purchase_received", variantId?: "uuid" }
router.patch('/:id/stock',
  validate(updateStockSchema),
  adminProductController.updateStock
);

module.exports = router;
