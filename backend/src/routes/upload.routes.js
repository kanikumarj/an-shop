/**
 * routes/upload.routes.js  [ENTERPRISE EDITION]
 * ================================================
 * Unified media upload routes for all file types.
 *
 * CUSTOMER ROUTES (require protect):
 *   POST   /upload/avatar                  — Profile photo
 *   POST   /upload/review                  — Review images
 *   POST   /upload/screenshot/:orderId     — Payment screenshot
 *   GET    /upload/policies                — See upload limits
 *
 * AUTH USER ROUTES (product upload — restrict to sellers/admin):
 *   POST   /upload/product                 — Single product image
 *   POST   /upload/products                — Bulk product images
 *
 * ADMIN ROUTES:
 *   POST   /upload/category                — Category banner
 *   DELETE /upload/image                   — Delete single image
 *   DELETE /upload/images                  — Bulk delete
 *   POST   /upload/transform               — Get transform URL
 *   POST   /upload/signed-url              — Get signed URL
 *   GET    /upload/info/:publicId          — Cloudinary asset info
 */

'use strict';

const { Router }   = require('express');
const rateLimit    = require('express-rate-limit');

const uploadController = require('../controllers/upload.controller');
const { protect, adminOnly, restrictTo } = require('../middleware/auth');
const { validate }     = require('../middleware/validate');
const uploadMiddleware = require('../middleware/upload.middleware');

const {
  deleteImageSchema,
  bulkDeleteSchema,
  transformSchema,
  signedUrlSchema,
} = require('../validations/upload.validation');

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,     // 5 minutes
  max: 20,
  message: { success: false, message: 'Too many upload requests. Please wait 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const deleteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many delete requests.' },
});

const readLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many requests.' },
});

// ─────────────────────────────────────────────────────────────────────────────
//   PUBLIC (no auth) — Policy info only
// ─────────────────────────────────────────────────────────────────────────────

// GET /upload/policies — File size limits, accepted types
router.get('/policies', readLimiter, uploadController.getUploadPolicies);

// ─────────────────────────────────────────────────────────────────────────────
//   AUTH REQUIRED for all routes below
// ─────────────────────────────────────────────────────────────────────────────
router.use(protect);

// ─── Avatar ────────────────────────────────────────────────────────────────────

// POST /upload/avatar — field: "avatar" (max 2MB, JPEG/PNG/WebP)
router.post('/avatar',
  uploadLimiter,
  ...uploadMiddleware.avatar,
  uploadController.uploadAvatar
);

// ─── Review Images ─────────────────────────────────────────────────────────────

// POST /upload/review — field: "images" (up to 5, max 3MB each)
router.post('/review',
  uploadLimiter,
  ...uploadMiddleware.reviewImages,
  uploadController.uploadReviewImages
);

// ─── Payment Screenshot ────────────────────────────────────────────────────────

// POST /upload/screenshot/:orderId — field: "screenshot" (max 10MB, img/pdf)
router.post('/screenshot/:orderId',
  uploadLimiter,
  ...uploadMiddleware.paymentScreenshot,
  uploadController.uploadPaymentScreenshot
);

// ─── Product Images (admin / seller) ──────────────────────────────────────────

// POST /upload/product — field: "image" (single, max 5MB)
router.post('/product',
  uploadLimiter,
  restrictTo('ADMIN', 'SUPERADMIN'),
  ...uploadMiddleware.productImage,
  uploadController.uploadProductImage
);

// POST /upload/products — field: "images" (up to 8, 5MB each)
router.post('/products',
  uploadLimiter,
  restrictTo('ADMIN', 'SUPERADMIN'),
  ...uploadMiddleware.productImages,
  uploadController.uploadProductImages
);

// ─── Category Image (admin only) ───────────────────────────────────────────────

// POST /upload/category — field: "image" (3MB banner)
router.post('/category',
  uploadLimiter,
  adminOnly,
  ...uploadMiddleware.categoryImage,
  uploadController.uploadCategoryImage
);

// ─── Asset Management (admin only) ────────────────────────────────────────────

// DELETE /upload/image — body: { publicId }
router.delete('/image',
  deleteLimiter,
  adminOnly,
  validate(deleteImageSchema),
  uploadController.deleteImage
);

// DELETE /upload/images — body: { publicIds: [] }
router.delete('/images',
  deleteLimiter,
  adminOnly,
  validate(bulkDeleteSchema),
  uploadController.deleteImages
);

// POST /upload/transform — body: { publicId, preset, transforms? }
router.post('/transform',
  readLimiter,
  validate(transformSchema),
  uploadController.getTransformUrl
);

// POST /upload/signed-url — body: { publicId, expiresInSeconds? }
router.post('/signed-url',
  readLimiter,
  adminOnly,
  validate(signedUrlSchema),
  uploadController.getSignedUrl
);

// GET /upload/info/:publicId — Cloudinary asset metadata
// publicId may contain slashes — use a wildcard
router.get('/info/:publicId(*)',
  readLimiter,
  adminOnly,
  uploadController.getAssetInfo
);

module.exports = router;
