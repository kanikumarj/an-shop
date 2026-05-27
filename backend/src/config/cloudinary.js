/**
 * config/cloudinary.js  [ENTERPRISE EDITION]
 * ============================================
 * Cloudinary SDK with multiple optimized storage profiles:
 *
 *   productStorage     — 800×800 WebP, auto quality, 5MB limit
 *   thumbnailStorage   — 400×400 WebP, high compression
 *   categoryStorage    — 600×400 banner, 3MB limit
 *   avatarStorage      — 200×200 face-crop, 2MB limit
 *   screenshotStorage  — Raw upload for payment proofs, 10MB limit
 *   reviewStorage      — Customer review photos, 3MB limit
 *
 * Helpers:
 *   uploadToCloudinary(filePath, folder, options) — direct upload
 *   deleteFromCloudinary(publicId)                — single delete
 *   deleteMultipleFromCloudinary(publicIds[])     — batch delete
 *   generateTransformUrl(publicId, transforms)    — on-the-fly URL
 *   extractPublicId(url)                          — parse from URL
 */

'use strict';

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const path = require('path');
const logger = require('../utils/logger');

// ─── Configure Cloudinary ─────────────────────────────────────────────────────
if (!process.env.CLOUDINARY_CLOUD_NAME) {
  logger.warn('⚠️ Cloudinary credentials not configured. Image uploads will fail.');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ─── Allowed MIME Types ─────────────────────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_DOC_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// ─── File Filters ──────────────────────────────────────────────────────────────
const imageFilter = (req, file, cb) => {
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
    return cb(null, true);
  }
  cb(new Error(`Invalid file type "${file.mimetype}". Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`), false);
};

const docOrImageFilter = (req, file, cb) => {
  if (ALLOWED_DOC_TYPES.includes(file.mimetype)) {
    return cb(null, true);
  }
  cb(new Error(`Invalid file type "${file.mimetype}". Allowed: ${ALLOWED_DOC_TYPES.join(', ')}`), false);
};

// ─── Safe Public ID Generator ─────────────────────────────────────────────────
const makePublicId = (prefix) => {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}_${ts}_${rand}`;
};

// ─── 1. Product Main Images ───────────────────────────────────────────────────
const productStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/products`,
    format: 'webp',
    public_id: makePublicId('prod'),
    transformation: [
      // Main image: 800×800, padded to square
      {
        width: 800,
        height: 800,
        crop: 'pad',
        background: 'white',
        quality: 'auto:good',
        fetch_format: 'webp',
      },
    ],
    tags: ['product', req.body?.categoryId || 'uncategorized'],
  }),
});

// ─── 2. Product Thumbnails (separate small version) ───────────────────────────
const thumbnailStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/products/thumbnails`,
    format: 'webp',
    public_id: makePublicId('thumb'),
    transformation: [
      {
        width: 300,
        height: 300,
        crop: 'fill',
        gravity: 'center',
        quality: 'auto:low',
        fetch_format: 'webp',
      },
    ],
  }),
});

// ─── 3. Category Banners ──────────────────────────────────────────────────────
const categoryStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/categories`,
    format: 'webp',
    public_id: makePublicId('cat'),
    transformation: [
      { width: 1200, height: 400, crop: 'fill', gravity: 'auto', quality: 'auto:good' },
    ],
  }),
});

// ─── 4. User Avatars ──────────────────────────────────────────────────────────
const avatarStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/avatars`,
    format: 'webp',
    public_id: makePublicId(`avatar_${req.user?.id || 'u'}`),
    transformation: [
      { width: 200, height: 200, crop: 'fill', gravity: 'face', quality: 'auto:good' },
    ],
  }),
});

// ─── 5. Payment Screenshots (preserve quality) ───────────────────────────────
const screenshotStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/payment-screenshots`,
    public_id: makePublicId('ss'),
    // No format conversion — preserve original for verification
    transformation: [
      { quality: 'auto:best', fetch_format: 'auto' },
    ],
    tags: ['payment_proof', req.params?.orderId || 'unknown_order'],
  }),
});

// ─── 6. Review Images ─────────────────────────────────────────────────────────
const reviewStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `${process.env.CLOUDINARY_FOLDER || 'an-shop'}/reviews`,
    format: 'webp',
    public_id: makePublicId('rev'),
    transformation: [
      { width: 600, height: 600, crop: 'limit', quality: 'auto:good' },
    ],
  }),
});

// ─── Multer Upload Instances ───────────────────────────────────────────────────
const MAX_PRODUCT_SIZE   = parseInt(process.env.MAX_FILE_SIZE)     || 5 * 1024 * 1024;  // 5MB
const MAX_AVATAR_SIZE    = 2 * 1024 * 1024;   // 2MB
const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_REVIEW_SIZE    = 3 * 1024 * 1024;   // 3MB
const MAX_CATEGORY_SIZE  = 3 * 1024 * 1024;   // 3MB

/**
 * Upload multiple product images (max 8 per request)
 * Field name: "images"
 */
const uploadProductImages = multer({
  storage: productStorage,
  fileFilter: imageFilter,
  limits: {
    fileSize: MAX_PRODUCT_SIZE,
    files: 8,
  },
}).array('images', 8);

/**
 * Upload single product image
 * Field name: "image"
 */
const uploadSingleProduct = multer({
  storage: productStorage,
  fileFilter: imageFilter,
  limits: { fileSize: MAX_PRODUCT_SIZE },
}).single('image');

/**
 * Upload category image
 * Field name: "image"
 */
const uploadCategoryImage = multer({
  storage: categoryStorage,
  fileFilter: imageFilter,
  limits: { fileSize: MAX_CATEGORY_SIZE },
}).single('image');

/**
 * Upload user avatar
 * Field name: "avatar"
 */
const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: { fileSize: MAX_AVATAR_SIZE },
}).single('avatar');

/**
 * Upload payment screenshot
 * Field name: "screenshot"
 */
const uploadPaymentScreenshot = multer({
  storage: screenshotStorage,
  fileFilter: docOrImageFilter,
  limits: { fileSize: MAX_SCREENSHOT_SIZE },
}).single('screenshot');

/**
 * Upload review images (max 5)
 * Field name: "images"
 */
const uploadReviewImages = multer({
  storage: reviewStorage,
  fileFilter: imageFilter,
  limits: { fileSize: MAX_REVIEW_SIZE, files: 5 },
}).array('images', 5);

// ─── Direct Upload Helpers ────────────────────────────────────────────────────

/**
 * Upload a file path or buffer directly to Cloudinary
 */
const uploadToCloudinary = async (fileSource, folder = 'an-shop/misc', options = {}) => {
  try {
    const result = await cloudinary.uploader.upload(fileSource, {
      folder,
      resource_type: 'auto',
      quality: 'auto:good',
      ...options,
    });

    return {
      url: result.secure_url,
      publicId: result.public_id,
      thumbnailUrl: cloudinary.url(result.public_id, {
        width: 300, height: 300, crop: 'fill', quality: 'auto:low', format: 'webp', secure: true,
      }),
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (error) {
    logger.error('❌ Cloudinary upload error:', { error: error.message, folder });
    throw new Error(`Image upload failed: ${error.message}`);
  }
};

/**
 * Delete a single image from Cloudinary by public ID
 */
const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return;
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    if (result.result !== 'ok' && result.result !== 'not found') {
      logger.warn('⚠️ Cloudinary delete unexpected result:', { publicId, result: result.result });
    }
    logger.debug('🗑️ Cloudinary deleted:', { publicId, result: result.result });
    return result;
  } catch (error) {
    logger.error('❌ Cloudinary delete error:', { publicId, error: error.message });
    // Don't throw — deletion failure shouldn't crash the request
  }
};

/**
 * Delete multiple images from Cloudinary in one batch API call
 */
const deleteMultipleFromCloudinary = async (publicIds = []) => {
  const validIds = publicIds.filter(Boolean);
  if (validIds.length === 0) return;

  try {
    const result = await cloudinary.api.delete_resources(validIds);
    const failed = Object.entries(result.deleted || {})
      .filter(([, status]) => status !== 'deleted')
      .map(([id]) => id);

    if (failed.length > 0) {
      logger.warn('⚠️ Some Cloudinary deletes failed:', { failed });
    }

    logger.info('🗑️ Cloudinary batch delete:', {
      requested: validIds.length,
      failed: failed.length,
    });

    return result;
  } catch (error) {
    logger.error('❌ Cloudinary batch delete error:', { error: error.message });
  }
};

/**
 * Generate a transformed Cloudinary URL without re-uploading
 * Useful for serving different sizes from the same image
 */
const generateTransformUrl = (publicId, transforms = {}) => {
  return cloudinary.url(publicId, {
    secure: true,
    quality: 'auto',
    fetch_format: 'auto',
    ...transforms,
  });
};

/**
 * Generate a set of responsive image URLs from a single public ID
 * Returns: { original, large, medium, small, thumbnail, blur }
 */
const generateResponsiveUrls = (publicId) => {
  if (!publicId) return null;

  const base = { secure: true, fetch_format: 'webp' };

  return {
    original: cloudinary.url(publicId, { ...base, quality: 'auto:best' }),
    large:    cloudinary.url(publicId, { ...base, width: 1200, crop: 'limit', quality: 'auto:good' }),
    medium:   cloudinary.url(publicId, { ...base, width: 800, height: 800, crop: 'pad', background: 'white', quality: 'auto:good' }),
    small:    cloudinary.url(publicId, { ...base, width: 400, height: 400, crop: 'fill', quality: 'auto:good' }),
    thumbnail: cloudinary.url(publicId, { ...base, width: 150, height: 150, crop: 'fill', quality: 'auto:low' }),
    blur:     cloudinary.url(publicId, { ...base, width: 20, height: 20, crop: 'fill', quality: 10, effect: 'blur:800' }),
  };
};

/**
 * Extract Cloudinary public ID from a full URL
 */
const extractPublicId = (url) => {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    // Find 'upload' segment — public ID starts after version/upload
    const uploadIdx = pathParts.indexOf('upload');
    if (uploadIdx === -1) return null;

    // Skip version segment if present (e.g., "v1234567890")
    let start = uploadIdx + 1;
    if (pathParts[start]?.startsWith('v') && /^v\d+$/.test(pathParts[start])) {
      start++;
    }

    // Join remaining parts and remove extension
    const publicIdWithExt = pathParts.slice(start).join('/');
    return publicIdWithExt.replace(/\.[^/.]+$/, '');
  } catch {
    // Fallback for non-standard URLs
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    const folderStart = url.indexOf(`${process.env.CLOUDINARY_FOLDER || 'an-shop'}/`);
    if (folderStart === -1) return null;
    return url.slice(folderStart).split('.')[0];
  }
};

module.exports = {
  cloudinary,
  // Multer instances
  uploadProductImages,
  uploadSingleProduct,
  uploadCategoryImage,
  uploadAvatar,
  uploadPaymentScreenshot,
  uploadReviewImages,
  // Direct helpers
  uploadToCloudinary,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  generateTransformUrl,
  generateResponsiveUrls,
  extractPublicId,
};
