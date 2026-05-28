/**
 * services/product.service.js
 * ============================
 * Product business logic — separated from HTTP controllers.
 *
 * Responsibilities:
 *   - Cache-aware product queries (Redis)
 *   - Stock management with atomic DB operations
 *   - Cloudinary image lifecycle management
 *   - Slug uniqueness enforcement
 *   - Inventory reservation/release (cart integration)
 *   - Bulk operations
 */

'use strict';

const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const { deleteFromCloudinary, deleteMultipleFromCloudinary, generateResponsiveUrls } = require('../config/cloudinary');
const { slugify } = require('../utils/helpers');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ─── Cache Keys ────────────────────────────────────────────────────────────────
const CK = {
  product: (id)     => `product:id:${id}`,
  productSlug: (s)  => `product:slug:${s}`,
  productList: (q)  => `products:list:${JSON.stringify(q)}`,
  featured:     ()  => 'products:featured',
  bestsellers:  ()  => 'products:bestsellers',
  newArrivals:  ()  => 'products:new-arrivals',
  onSale:       ()  => 'products:on-sale',
  categories:   ()  => 'categories:all',
  category: (s)     => `category:slug:${s}`,
  stats:        ()  => 'products:stats',
};

const CACHE_TTL = {
  product: 600,       // 10min
  list: 120,          // 2min
  featured: 600,      // 10min
  stats: 300,         // 5min
};

// ─── Product Field Sets ────────────────────────────────────────────────────────

/** Compact card format for listing pages */
const CARD_SELECT = {
  id: true,
  name: true,
  slug: true,
  shortDescription: true,
  basePrice: true,
  comparePrice: true,
  stock: true,
  isActive: true,
  isFeatured: true,
  isBestseller: true,
  isNewArrival: true,
  isOnSale: true,
  avgRating: true,
  totalReviews: true,
  totalSold: true,
  tags: true,
  categoryId: true,
  category: { select: { id: true, name: true, slug: true, icon: true } },
  images: {
    where: { isPrimary: true },
    select: { url: true, alt: true, publicId: true },
    take: 1,
  },
  createdAt: true,
};

/** Full product detail for product page */
const DETAIL_INCLUDE = {
  category: { select: { id: true, name: true, slug: true, icon: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  variants: {
    where: { isActive: true, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
  },
  reviews: {
    where: { status: 'APPROVED' },
    take: 10,
    orderBy: [{ helpfulCount: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true, rating: true, title: true, body: true, images: true,
      isVerifiedPurchase: true, helpfulCount: true, adminReply: true,
      createdAt: true,
      user: { select: { name: true, avatar: true } },
    },
  },
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT QUERIES
// ═══════════════════════════════════════════════════════════

/**
 * Build a Prisma WHERE clause from query params
 */
const buildProductFilter = (query = {}, adminMode = false) => {
  const {
    category, categoryId, minPrice, maxPrice, tags,
    inStock, featured, bestseller, newArrival, onSale,
    q, rating, certifications,
  } = query;

  const isActiveFilter = adminMode ? {} : { isActive: true };

  return {
    ...isActiveFilter,
    deletedAt: null,

    // Category filter (by slug or ID)
    ...(category    && { category: { slug: category } }),
    ...(categoryId  && { categoryId }),

    // Price range
    ...((minPrice || maxPrice) && {
      basePrice: {
        ...(minPrice && { gte: parseFloat(minPrice) }),
        ...(maxPrice && { lte: parseFloat(maxPrice) }),
      },
    }),

    // Tags (ANY match)
    ...(tags && { tags: { hasSome: Array.isArray(tags) ? tags : tags.split(',').map((t) => t.trim()) } }),

    // Boolean flags
    ...(inStock     === 'true'  && { stock: { gt: 0 } }),
    ...(featured    === 'true'  && { isFeatured: true }),
    ...(bestseller  === 'true'  && { isBestseller: true }),
    ...(newArrival  === 'true'  && { isNewArrival: true }),
    ...(onSale      === 'true'  && { isOnSale: true }),

    // Minimum rating
    ...(rating && { avgRating: { gte: parseFloat(rating) } }),

    // Certifications (JSON array contains)
    ...(certifications && { certifications: { hasSome: certifications.split(',') } }),

    // Full-text search
    ...(q && q.trim().length >= 2 && {
      OR: [
        { name:             { contains: q, mode: 'insensitive' } },
        { shortDescription: { contains: q, mode: 'insensitive' } },
        { description:      { contains: q, mode: 'insensitive' } },
        { tags:             { hasSome: [q.toLowerCase()] } },
        { ingredients:      { contains: q, mode: 'insensitive' } },
        { madeIn:           { contains: q, mode: 'insensitive' } },
        { category: { name: { contains: q, mode: 'insensitive' } } },
      ],
    }),
  };
};

/**
 * Build Prisma orderBy from sort param
 * Supported: price, -price, rating, -rating, sold, -sold, name, newest, oldest
 */
const buildProductSort = (sort = 'newest') => {
  const sortMap = {
    newest:       { createdAt:  'desc' },
    oldest:       { createdAt:  'asc'  },
    price:        { basePrice:  'asc'  },
    '-price':     { basePrice:  'desc' },
    rating:       { avgRating:  'desc' },
    '-rating':    { avgRating:  'asc'  },
    sold:         { totalSold:  'desc' },
    '-sold':      { totalSold:  'asc'  },
    name:         { name:       'asc'  },
    '-name':      { name:       'desc' },
    stock:        { stock:      'desc' },
    '-stock':     { stock:      'asc'  },
  };

  return sortMap[sort] || { createdAt: 'desc' };
};

// ═══════════════════════════════════════════════════════════
//   CACHE INVALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * Invalidate all product-related cache entries
 */
const invalidateProductCache = async (productId = null, slug = null) => {
  const keysToDelete = [
    CK.featured(),
    CK.bestsellers(),
    CK.newArrivals(),
    CK.onSale(),
    CK.stats(),
  ];

  if (productId) keysToDelete.push(CK.product(productId));
  if (slug)      keysToDelete.push(CK.productSlug(slug));

  await Promise.all(keysToDelete.map((k) => cache.del(k)));

  // Pattern-delete product list caches
  await cache.delPattern('products:list:*');

  logger.debug('🗑️ Product cache invalidated', { productId, slug });
};

// ═══════════════════════════════════════════════════════════
//   SLUG MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * Generate a unique slug — appends counter if conflict exists
 */
const generateUniqueSlug = async (name, excludeId = null) => {
  const base = slugify(name);
  let candidate = base;
  let counter = 1;

  while (true) {
    const existing = await prisma.product.findFirst({
      where: {
        slug: candidate,
        ...(excludeId && { id: { not: excludeId } }),
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!existing) return candidate;

    counter++;
    candidate = `${base}-${counter}`;
  }
};

// ═══════════════════════════════════════════════════════════
//   STOCK MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * Atomically deduct stock — called when order is placed.
 * Uses Prisma's updateMany to prevent negative stock.
 * @returns {{ success: boolean, productId, requested, available? }}
 */
const deductStock = async (productId, quantity, variantId = null) => {
  if (variantId) {
    const result = await prisma.productVariant.updateMany({
      where: {
        id: variantId,
        productId,
        stock: { gte: quantity },
      },
      data: { stock: { decrement: quantity } },
    });

    if (result.count === 0) {
      const variant = await prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { stock: true },
      });
      return { success: false, productId, variantId, requested: quantity, available: variant?.stock ?? 0 };
    }

    return { success: true, productId, variantId, quantity };
  }

  const result = await prisma.product.updateMany({
    where: {
      id: productId,
      stock: { gte: quantity },
    },
    data: { stock: { decrement: quantity } },
  });

  if (result.count === 0) {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    return { success: false, productId, requested: quantity, available: product?.stock ?? 0 };
  }

  return { success: true, productId, quantity };
};

/**
 * Restore stock — called when order is cancelled or refunded.
 */
const restoreStock = async (productId, quantity, variantId = null) => {
  if (variantId) {
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { stock: { increment: quantity } },
    });
  } else {
    await prisma.product.update({
      where: { id: productId },
      data: { stock: { increment: quantity } },
    });
  }
};

/**
 * Reserve stock in cart (soft reservation — informational only)
 */
const reserveStock = async (productId, quantity, reserve = true) => {
  await prisma.product.update({
    where: { id: productId },
    data: {
      reservedStock: reserve
        ? { increment: quantity }
        : { decrement: Math.max(0, quantity) },
    },
  }).catch(() => {}); // Non-critical — don't throw
};

/**
 * Check stock availability for a list of cart items.
 * @param {Array<{ productId, variantId?, quantity }>} items
 * @returns {{ valid: boolean, failures: Array }}
 */
const validateStockForOrder = async (items) => {
  const failures = [];

  for (const item of items) {
    if (item.variantId) {
      const variant = await prisma.productVariant.findFirst({
        where: { id: item.variantId, productId: item.productId, isActive: true, deletedAt: null },
        select: { stock: true, name: true },
      });

      if (!variant || variant.stock < item.quantity) {
        failures.push({
          productId: item.productId,
          variantId: item.variantId,
          variantName: variant?.name,
          requested: item.quantity,
          available: variant?.stock ?? 0,
        });
      }
    } else {
      const product = await prisma.product.findFirst({
        where: { id: item.productId, isActive: true, deletedAt: null },
        select: { stock: true, name: true, allowBackorder: true },
      });

      if (!product || (!product.allowBackorder && product.stock < item.quantity)) {
        failures.push({
          productId: item.productId,
          productName: product?.name,
          requested: item.quantity,
          available: product?.stock ?? 0,
        });
      }
    }
  }

  return { valid: failures.length === 0, failures };
};

// ═══════════════════════════════════════════════════════════
//   IMAGE MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * Attach uploaded images to a product record.
 * @param {string} productId
 * @param {Array<Express.Multer.File>} files
 * @param {boolean} setFirstAsPrimary  — Set first image as primary if no primary exists
 */
const attachProductImages = async (productId, files, setFirstAsPrimary = true) => {
  if (!files || files.length === 0) return [];

  const existingCount = await prisma.productImage.count({ where: { productId } });
  const hasPrimary = existingCount === 0;

  const imageData = files.map((file, index) => {
    const isLocal = file.path && !file.path.startsWith('http');
    const url = isLocal ? `/uploads/${file.filename}` : file.path;
    const thumbnailUrl = isLocal ? `/uploads/${file.filename}` : (generateResponsiveUrls(file.filename)?.thumbnail || file.path);

    return {
      productId,
      url,
      publicId: file.filename,
      thumbnailUrl,
      alt: file.originalname?.split('.')[0] || `Product image ${index + 1}`,
      type: 'image',
      fileSizeBytes: file.size || null,
      isPrimary: setFirstAsPrimary && hasPrimary && index === 0,
      sortOrder: existingCount + index,
    };
  });

  const created = await prisma.productImage.createMany({
    data: imageData,
  });

  logger.info('📸 Product images attached:', { productId, count: files.length });
  return created;
};

/**
 * Delete product images from both DB and Cloudinary.
 * @param {string[]} imageIds  — ProductImage IDs to delete
 */
const deleteProductImages = async (imageIds = []) => {
  if (imageIds.length === 0) return;

  const images = await prisma.productImage.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, publicId: true, productId: true },
  });

  // Delete from DB
  await prisma.productImage.deleteMany({ where: { id: { in: imageIds } } });

  // Delete from Cloudinary (don't fail if Cloudinary errors)
  const publicIds = images.map((i) => i.publicId).filter(Boolean);
  await deleteMultipleFromCloudinary(publicIds);

  logger.info('🗑️ Product images deleted:', { count: imageIds.length });
};

/**
 * Set a specific image as the primary image for a product.
 */
const setPrimaryImage = async (productId, imageId) => {
  await prisma.$transaction([
    prisma.productImage.updateMany({
      where: { productId },
      data: { isPrimary: false },
    }),
    prisma.productImage.update({
      where: { id: imageId, productId },
      data: { isPrimary: true },
    }),
  ]);
};

/**
 * Reorder product images by providing an ordered array of image IDs.
 */
const reorderImages = async (productId, orderedImageIds = []) => {
  await prisma.$transaction(
    orderedImageIds.map((imageId, index) =>
      prisma.productImage.updateMany({
        where: { id: imageId, productId },
        data: { sortOrder: index },
      })
    )
  );
};

// ═══════════════════════════════════════════════════════════
//   RATING AGGREGATION
// ═══════════════════════════════════════════════════════════

/**
 * Recalculate and persist the product's average rating.
 * Called after a review is created, updated, or approved.
 */
const recalculateRating = async (productId) => {
  const result = await prisma.review.aggregate({
    where: { productId, status: 'APPROVED' },
    _avg: { rating: true },
    _count: { rating: true },
  });

  await prisma.product.update({
    where: { id: productId },
    data: {
      avgRating: result._avg.rating || 0,
      totalReviews: result._count.rating,
    },
  });

  await cache.del(CK.product(productId));
};

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Filters & sorting
  buildProductFilter,
  buildProductSort,
  // Cache
  invalidateProductCache,
  CK,
  CACHE_TTL,
  // Field sets
  CARD_SELECT,
  DETAIL_INCLUDE,
  // Slug
  generateUniqueSlug,
  // Stock
  deductStock,
  restoreStock,
  reserveStock,
  validateStockForOrder,
  // Images
  attachProductImages,
  deleteProductImages,
  setPrimaryImage,
  reorderImages,
  // Rating
  recalculateRating,
};
