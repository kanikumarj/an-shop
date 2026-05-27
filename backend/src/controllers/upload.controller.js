/**
 * controllers/upload.controller.js  [ENTERPRISE EDITION]
 * ========================================================
 * Unified media upload management — all upload types in one place.
 *
 * PRODUCT IMAGES:
 *   POST /upload/product              — Single product image
 *   POST /upload/products             — Bulk (up to 8 images)
 *   DELETE /upload/image              — Delete by publicId
 *   DELETE /upload/images             — Bulk delete
 *
 * PROFILE AVATAR:
 *   POST /upload/avatar               — Replace user avatar on Cloudinary + DB
 *
 * PAYMENT SCREENSHOT:
 *   POST /upload/screenshot/:orderId  — Payment proof (also updates order flow)
 *
 * REVIEW IMAGES:
 *   POST /upload/review               — Customer review photos
 *
 * CATEGORY IMAGE:
 *   POST /upload/category             — Admin: category banner
 *
 * UTILITIES:
 *   POST /upload/transform            — On-the-fly Cloudinary transform URL
 *   POST /upload/signed-url           — Generate time-limited private URL
 *   GET  /upload/info/:publicId       — Cloudinary asset metadata
 */

'use strict';

const { prisma }          = require('../config/database');
const { ApiResponse }     = require('../utils/ApiResponse');
const AppError            = require('../utils/AppError');
const logger              = require('../utils/logger');

const {
  deleteFromCloudinary,
  extractPublicId,
  generateResponsiveUrls,
  cloudinary,
} = require('../config/cloudinary');

const {
  enrichUploadResult,
  bulkDelete,
  buildTransformUrl,
  generateSignedUrl,
  UPLOAD_POLICIES,
} = require('../services/upload.service');

// ═══════════════════════════════════════════════════════════
//   PRODUCT IMAGE — Single
//   POST /upload/product
// ═══════════════════════════════════════════════════════════

exports.uploadProductImage = async (req, res) => {
  if (!req.file) throw AppError.badRequest('No image file uploaded.', 'FILE_REQUIRED');

  const result = enrichUploadResult(req.file, 'product');
  const responsive = generateResponsiveUrls(result.publicId);

  logger.apiEvent('UPLOAD_PRODUCT_IMAGE', {
    userId:   req.user.id,
    publicId: result.publicId,
    size:     result.sizeBytes,
  });

  ApiResponse.success(res, {
    ...result,
    responsive,
    transformUrls: {
      thumbnail: buildTransformUrl(result.publicId, 'thumbnail'),
      card:      buildTransformUrl(result.publicId, 'card'),
      large:     buildTransformUrl(result.publicId, 'large'),
      blur:      buildTransformUrl(result.publicId, 'blur'),
    },
  }, 'Product image uploaded successfully.', 201);
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT IMAGES — Bulk
//   POST /upload/products
// ═══════════════════════════════════════════════════════════

exports.uploadProductImages = async (req, res) => {
  if (!req.files?.length) throw AppError.badRequest('No images uploaded.', 'FILES_REQUIRED');

  const results = req.files.map((file, idx) => {
    const r = enrichUploadResult(file, 'product');
    return {
      ...r,
      index: idx,
      isPrimary: idx === 0,
      transformUrls: {
        thumbnail: buildTransformUrl(r.publicId, 'thumbnail'),
        card:      buildTransformUrl(r.publicId, 'card'),
        large:     buildTransformUrl(r.publicId, 'large'),
        blur:      buildTransformUrl(r.publicId, 'blur'),
      },
    };
  });

  logger.apiEvent('UPLOAD_PRODUCT_IMAGES_BULK', {
    userId: req.user.id,
    count:  results.length,
  });

  ApiResponse.success(res, {
    images: results,
    count:  results.length,
    primaryUrl: results[0]?.url || null,
  }, `${results.length} product image(s) uploaded successfully.`, 201);
};

// ═══════════════════════════════════════════════════════════
//   USER AVATAR
//   POST /upload/avatar
// ═══════════════════════════════════════════════════════════

exports.uploadAvatar = async (req, res) => {
  if (!req.file) throw AppError.badRequest('No avatar image uploaded.', 'FILE_REQUIRED');

  const userId = req.user.id;

  // Delete old avatar from Cloudinary (if exists)
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { avatar: true, avatarPublicId: true },
  });

  if (user?.avatarPublicId) {
    await deleteFromCloudinary(user.avatarPublicId).catch((err) => {
      logger.warn('⚠️ Old avatar delete failed:', { error: err.message, publicId: user.avatarPublicId });
    });
  }

  const result = enrichUploadResult(req.file, 'avatar');

  // Update user record
  await prisma.user.update({
    where: { id: userId },
    data: {
      avatar:         result.url,
      avatarPublicId: result.publicId,
    },
  });

  logger.apiEvent('UPLOAD_AVATAR', { userId, publicId: result.publicId });

  ApiResponse.success(res, {
    url:       result.url,
    publicId:  result.publicId,
    transformUrls: {
      avatar: buildTransformUrl(result.publicId, 'avatar'),
      thumb:  buildTransformUrl(result.publicId, 'thumbnail'),
    },
  }, 'Profile photo updated successfully.', 200);
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT SCREENSHOT
//   POST /upload/screenshot/:orderId
//   (also handled by payment.controller — this is a standalone endpoint)
// ═══════════════════════════════════════════════════════════

exports.uploadPaymentScreenshot = async (req, res) => {
  if (!req.file) throw AppError.badRequest('No screenshot uploaded.', 'FILE_REQUIRED');

  const { orderId } = req.params;
  const userId      = req.user.id;

  // Verify order belongs to this user
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId, deletedAt: null },
    select: { id: true, orderNumber: true, status: true },
  });

  if (!order) throw AppError.notFound('Order');

  const result = enrichUploadResult(req.file, 'screenshot');

  logger.apiEvent('UPLOAD_PAYMENT_SCREENSHOT', {
    userId,
    orderId,
    publicId: result.publicId,
    size:     result.sizeBytes,
  });

  // Return upload info — caller (payment flow) handles DB record creation
  ApiResponse.success(res, {
    url:          result.url,
    publicId:     result.publicId,
    mimeType:     result.mimeType,
    sizeBytes:    result.sizeBytes,
    originalName: result.originalName,
    // For admin verification: signed URL (1 hour)
    signedUrl:    generateSignedUrl(result.publicId, 3600),
  }, 'Screenshot uploaded successfully.', 201);
};

// ═══════════════════════════════════════════════════════════
//   REVIEW IMAGES
//   POST /upload/review
// ═══════════════════════════════════════════════════════════

exports.uploadReviewImages = async (req, res) => {
  if (!req.files?.length) throw AppError.badRequest('No review images uploaded.', 'FILES_REQUIRED');

  const results = req.files.map((file) => {
    const r = enrichUploadResult(file, 'review');
    return {
      url:      r.url,
      publicId: r.publicId,
      size:     r.sizeBytes,
      thumb:    buildTransformUrl(r.publicId, 'thumbnail'),
      medium:   buildTransformUrl(r.publicId, 'card'),
    };
  });

  ApiResponse.success(res, { images: results, count: results.length }, `${results.length} review image(s) uploaded.`, 201);
};

// ═══════════════════════════════════════════════════════════
//   CATEGORY IMAGE
//   POST /upload/category  [ADMIN]
// ═══════════════════════════════════════════════════════════

exports.uploadCategoryImage = async (req, res) => {
  if (!req.file) throw AppError.badRequest('No category image uploaded.', 'FILE_REQUIRED');

  const result = enrichUploadResult(req.file, 'category');

  logger.apiEvent('UPLOAD_CATEGORY_IMAGE', { adminId: req.user.id, publicId: result.publicId });

  ApiResponse.success(res, {
    url:      result.url,
    publicId: result.publicId,
    banner:   buildTransformUrl(result.publicId, 'banner'),
    thumb:    buildTransformUrl(result.publicId, 'thumbnail'),
  }, 'Category image uploaded.', 201);
};

// ═══════════════════════════════════════════════════════════
//   DELETE — Single Image
//   DELETE /upload/image
// ═══════════════════════════════════════════════════════════

exports.deleteImage = async (req, res) => {
  const { publicId } = req.body;
  if (!publicId) throw AppError.badRequest('publicId is required.');

  // Basic safety: only delete from our own Cloudinary folder
  const folder = process.env.CLOUDINARY_FOLDER || 'an-shop';
  if (!publicId.startsWith(folder)) {
    logger.securityEvent('UNAUTHORIZED_DELETE_ATTEMPT', { userId: req.user.id, publicId });
    throw AppError.forbidden('You can only delete assets from this application.');
  }

  await deleteFromCloudinary(publicId);
  logger.apiEvent('UPLOAD_IMAGE_DELETED', { userId: req.user.id, publicId });

  ApiResponse.success(res, { publicId, deleted: true }, 'Image deleted successfully.');
};

// ═══════════════════════════════════════════════════════════
//   DELETE — Bulk Images
//   DELETE /upload/images
// ═══════════════════════════════════════════════════════════

exports.deleteImages = async (req, res) => {
  const { publicIds } = req.body;
  if (!Array.isArray(publicIds) || publicIds.length === 0) {
    throw AppError.badRequest('publicIds must be a non-empty array.');
  }
  if (publicIds.length > 50) {
    throw AppError.badRequest('Cannot delete more than 50 images at once.');
  }

  // Safety: only delete from our folder
  const folder = process.env.CLOUDINARY_FOLDER || 'an-shop';
  const unauthorized = publicIds.filter((id) => !id.startsWith(folder));
  if (unauthorized.length > 0) {
    logger.securityEvent('BULK_UNAUTHORIZED_DELETE', { userId: req.user.id, unauthorized });
    throw AppError.forbidden('Some publicIds are outside the allowed folder.');
  }

  const report = await bulkDelete(publicIds);

  logger.apiEvent('UPLOAD_IMAGES_BULK_DELETED', {
    userId:  req.user.id,
    deleted: report.deleted.length,
    failed:  report.failed.length,
  });

  ApiResponse.success(res, report,
    `${report.deleted.length}/${report.total} image(s) deleted.`
  );
};

// ═══════════════════════════════════════════════════════════
//   TRANSFORM URL — On-the-fly
//   POST /upload/transform
// ═══════════════════════════════════════════════════════════

exports.getTransformUrl = (req, res) => {
  const { publicId, preset = 'card', transforms = {} } = req.body;
  if (!publicId) throw AppError.badRequest('publicId is required.');

  const allowedPresets = ['thumbnail', 'card', 'large', 'banner', 'avatar', 'blur'];
  if (!allowedPresets.includes(preset)) {
    throw AppError.badRequest(`Invalid preset "${preset}". Allowed: ${allowedPresets.join(', ')}.`);
  }

  const url = buildTransformUrl(publicId, preset, transforms);
  if (!url) throw AppError.badRequest('Could not generate transform URL.');

  ApiResponse.success(res, { url, preset, publicId });
};

// ═══════════════════════════════════════════════════════════
//   SIGNED URL — Time-limited private access
//   POST /upload/signed-url
// ═══════════════════════════════════════════════════════════

exports.getSignedUrl = (req, res) => {
  const { publicId, expiresInSeconds = 3600 } = req.body;
  if (!publicId) throw AppError.badRequest('publicId is required.');

  const maxExpiry = 24 * 60 * 60; // 24 hours max
  const expiry    = Math.min(parseInt(expiresInSeconds) || 3600, maxExpiry);

  const url = generateSignedUrl(publicId, expiry);
  if (!url) throw AppError.badRequest('Could not generate signed URL.');

  ApiResponse.success(res, {
    url,
    publicId,
    expiresInSeconds: expiry,
    expiresAt: new Date(Date.now() + expiry * 1000).toISOString(),
  }, 'Signed URL generated.');
};

// ═══════════════════════════════════════════════════════════
//   CLOUDINARY ASSET INFO
//   GET /upload/info/:publicId
// ═══════════════════════════════════════════════════════════

exports.getAssetInfo = async (req, res) => {
  // publicId may contain slashes — reconstruct from encoded param
  const publicId = decodeURIComponent(req.params.publicId);
  if (!publicId) throw AppError.badRequest('publicId is required.');

  try {
    const info = await cloudinary.api.resource(publicId, {
      image_metadata: true,
      colors: false,
    });

    ApiResponse.success(res, {
      publicId:   info.public_id,
      url:        info.secure_url,
      format:     info.format,
      width:      info.width,
      height:     info.height,
      bytes:      info.bytes,
      createdAt:  info.created_at,
      etag:       info.etag,
      folder:     info.folder,
      tags:       info.tags,
      responsive: generateResponsiveUrls(publicId),
    });
  } catch (err) {
    if (err.http_code === 404) throw AppError.notFound('Asset');
    throw AppError.badRequest(`Cloudinary error: ${err.message}`);
  }
};

// ═══════════════════════════════════════════════════════════
//   POLICY INFO
//   GET /upload/policies
// ═══════════════════════════════════════════════════════════

exports.getUploadPolicies = (req, res) => {
  // Return human-readable policy info for frontend
  const policies = Object.entries(UPLOAD_POLICIES).reduce((acc, [key, policy]) => {
    acc[key] = {
      maxSizeMB:    (policy.maxSizeBytes / 1024 / 1024).toFixed(0),
      allowedTypes: policy.allowedMimes,
      maxFiles:     policy.maxFiles,
      minSize:      `${policy.minWidth}×${policy.minHeight}px`,
    };
    return acc;
  }, {});

  ApiResponse.success(res, policies, 'Upload policies.');
};
