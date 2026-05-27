/**
 * middleware/upload.middleware.js  [ENTERPRISE EDITION]
 * =======================================================
 * All Multer → Cloudinary upload middleware instances, organized by upload type.
 *
 * Each exported middleware is:
 *   1. Locked to a specific Cloudinary storage profile
 *   2. Configured with correct file type whitelist
 *   3. Enforces strict byte-size limits
 *   4. Includes a multerErrorHandler for clean error responses
 *
 * Usage in routes:
 *   router.post('/product', uploadMiddleware.productImages, controller.create);
 *   router.post('/avatar',  uploadMiddleware.avatar, controller.updateAvatar);
 *
 * Each middleware runs BEFORE the controller. If multer throws, the
 * multerErrorHandler converts it to a standard AppError 400 response.
 */

'use strict';

const multer = require('multer');
const {
  uploadProductImages,
  uploadSingleProduct,
  uploadCategoryImage,
  uploadAvatar,
  uploadPaymentScreenshot,
  uploadReviewImages,
} = require('../config/cloudinary');

const AppError = require('../utils/AppError');
const logger   = require('../utils/logger');
const { validateFileAgainstPolicy } = require('../services/upload.service');

// ─── Multer Error Wrapper ────────────────────────────────────────────────────────

/**
 * Wraps a multer middleware to intercept MulterError instances
 * and throw them as structured AppErrors instead of crashing.
 */
const wrapMulter = (multerMiddleware, policyName = null) => {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) {
        // Post-upload: run policy validation on each file
        if (policyName) {
          const files = req.files || (req.file ? [req.file] : []);
          const validations = files.map((f) => validateFileAgainstPolicy(f, policyName));
          Promise.all(validations)
            .then(() => next())
            .catch((valErr) => next(valErr));
        } else {
          next();
        }
        return;
      }

      // ── Multer-specific errors ───────────────────────────────────
      if (err instanceof multer.MulterError) {
        logger.warn('⚠️ Multer error:', { code: err.code, field: err.field });

        const messages = {
          LIMIT_FILE_SIZE:    'File is too large. Please upload a smaller file.',
          LIMIT_FILE_COUNT:   'Too many files. Check the maximum file count for this upload.',
          LIMIT_FIELD_KEY:    'Field name too long.',
          LIMIT_FIELD_VALUE:  'Field value too long.',
          LIMIT_FIELD_COUNT:  'Too many form fields.',
          LIMIT_UNEXPECTED_FILE: `Unexpected field "${err.field}". Check the correct field name.`,
          LIMIT_PART_COUNT:   'Too many form parts.',
        };

        return next(AppError.badRequest(
          messages[err.code] || `Upload error: ${err.message}`,
          err.code
        ));
      }

      // ── File filter rejections (from cloudinary.js imageFilter / docOrImageFilter) ──
      if (err && err.message) {
        return next(AppError.badRequest(err.message, 'INVALID_FILE_TYPE'));
      }

      next(err);
    });
  };
};

// ─── Multer Size Limiter (fallback, belt-and-suspenders) ─────────────────────────
const makeSizeLimiter = (maxBytes) => (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > maxBytes) {
    return next(AppError.badRequest(
      `Request too large (${(contentLength / 1024 / 1024).toFixed(2)}MB). Maximum: ${(maxBytes / 1024 / 1024).toFixed(0)}MB.`,
      'REQUEST_TOO_LARGE'
    ));
  }
  next();
};

// ─── Product Images ───────────────────────────────────────────────────────────────

/**
 * Upload multiple product images (up to 8).
 * Field name: "images"
 * Profile: 800×800 WebP, auto quality, white padding
 * Max size: 5MB per file
 */
exports.productImages = [
  makeSizeLimiter(5 * 8 * 1024 * 1024), // 40MB total guard for 8 files
  wrapMulter(uploadProductImages, 'product'),
];

/**
 * Upload a single product image.
 * Field name: "image"
 */
exports.productImage = [
  makeSizeLimiter(5 * 1024 * 1024),
  wrapMulter(uploadSingleProduct, 'product'),
];

// ─── Category Image ────────────────────────────────────────────────────────────────

/**
 * Upload a category banner image.
 * Field name: "image"
 * Profile: 1200×400 banner WebP
 * Max size: 3MB
 */
exports.categoryImage = [
  makeSizeLimiter(3 * 1024 * 1024),
  wrapMulter(uploadCategoryImage, 'category'),
];

// ─── User Avatar ────────────────────────────────────────────────────────────────────

/**
 * Upload a user profile avatar.
 * Field name: "avatar"
 * Profile: 200×200 face-crop WebP
 * Max size: 2MB
 */
exports.avatar = [
  makeSizeLimiter(2 * 1024 * 1024),
  wrapMulter(uploadAvatar, 'avatar'),
];

// ─── Payment Screenshot ─────────────────────────────────────────────────────────────

/**
 * Upload a UPI payment proof screenshot.
 * Field name: "screenshot"
 * Profile: Original quality, auto format, 10MB
 * Accepts: JPEG, PNG, WebP, PDF
 */
exports.paymentScreenshot = [
  makeSizeLimiter(10 * 1024 * 1024),
  wrapMulter(uploadPaymentScreenshot, 'screenshot'),
];

// ─── Review Images ────────────────────────────────────────────────────────────────

/**
 * Upload customer review images (up to 5).
 * Field name: "images"
 * Profile: 600×600 WebP limit crop
 * Max size: 3MB each
 */
exports.reviewImages = [
  makeSizeLimiter(15 * 1024 * 1024), // 5 × 3MB
  wrapMulter(uploadReviewImages, 'review'),
];

// ─── Request Body Size Guard (for multipart without files) ──────────────────────

/**
 * Reject oversized multipart requests before multer even runs.
 * Configured conservatively — override per-route if needed.
 */
exports.sizeGuard = (maxMB = 10) => makeSizeLimiter(maxMB * 1024 * 1024);
