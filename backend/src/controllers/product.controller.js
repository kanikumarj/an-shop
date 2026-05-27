/**
 * controllers/product.controller.js  [ENTERPRISE EDITION]
 * ===========================================================
 * Public product browsing APIs with Redis caching.
 *
 * Routes served:
 *   GET /products                  — Paginated list with filters
 *   GET /products/search           — Full-text search
 *   GET /products/featured         — Featured products
 *   GET /products/bestsellers      — Bestseller products
 *   GET /products/new-arrivals     — New arrival products
 *   GET /products/on-sale          — Products on sale
 *   GET /products/stats            — Aggregated product statistics
 *   GET /products/:id              — Product by ID (full detail)
 *   GET /products/slug/:slug       — Product by slug (full detail)
 *   GET /products/:id/related      — Related products
 *   GET /products/:id/reviews      — Paginated product reviews
 *   GET /products/:id/variants     — Product variants list
 */

'use strict';

const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const {
  buildProductFilter,
  buildProductSort,
  CARD_SELECT,
  DETAIL_INCLUDE,
  CK,
  CACHE_TTL,
} = require('../services/product.service');

// ─── Shared pagination helper ─────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ═══════════════════════════════════════════════════════════
//   GET ALL PRODUCTS — with full filter/sort/pagination
// ═══════════════════════════════════════════════════════════

exports.getAllProducts = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const sort  = req.query.sort || 'newest';
  const where = buildProductFilter(req.query);
  const orderBy = buildProductSort(sort);

  // Cache key includes all query params
  const cacheKey = CK.productList({ page, limit, sort, ...req.query });
  const cached = await cache.get(cacheKey);

  if (cached) {
    return res.json({
      success: true,
      message: 'Products fetched.',
      ...cached,
      cached: true,
    });
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      select: CARD_SELECT,
      orderBy,
      skip,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  const pagination = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };

  const response = { data: products, pagination };
  await cache.set(cacheKey, response, CACHE_TTL.list);

  ApiResponse.paginated(res, products, pagination, 'Products fetched.');
};

// ═══════════════════════════════════════════════════════════
//   FULL-TEXT SEARCH
// ═══════════════════════════════════════════════════════════

exports.searchProducts = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    throw AppError.badRequest('Search query must be at least 2 characters.');
  }

  const { page, limit, skip } = getPagination(req.query);

  const where = buildProductFilter({ ...req.query, q });
  const orderBy = buildProductSort(req.query.sort);

  const [products, total] = await Promise.all([
    prisma.product.findMany({ where, select: CARD_SELECT, orderBy, skip, take: limit }),
    prisma.product.count({ where }),
  ]);

  const pagination = {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };

  logger.info('🔍 Product search:', { q, total, ip: req.ip });

  ApiResponse.paginated(res, products, pagination, `Found ${total} result(s) for "${q}"`);
};

// ═══════════════════════════════════════════════════════════
//   FEATURED PRODUCTS
// ═══════════════════════════════════════════════════════════

exports.getFeaturedProducts = async (req, res) => {
  const cached = await cache.get(CK.featured());
  if (cached) return ApiResponse.success(res, cached, 'Featured products.');

  const products = await prisma.product.findMany({
    where: { isActive: true, isFeatured: true, stock: { gt: 0 }, deletedAt: null },
    select: CARD_SELECT,
    orderBy: [{ totalSold: 'desc' }, { avgRating: 'desc' }],
    take: parseInt(req.query.limit) || 12,
  });

  await cache.set(CK.featured(), products, CACHE_TTL.featured);
  ApiResponse.success(res, products, 'Featured products.');
};

// ═══════════════════════════════════════════════════════════
//   BESTSELLERS
// ═══════════════════════════════════════════════════════════

exports.getBestsellers = async (req, res) => {
  const cached = await cache.get(CK.bestsellers());
  if (cached) return ApiResponse.success(res, cached, 'Bestsellers.');

  const products = await prisma.product.findMany({
    where: { isActive: true, isBestseller: true, stock: { gt: 0 }, deletedAt: null },
    select: CARD_SELECT,
    orderBy: { totalSold: 'desc' },
    take: parseInt(req.query.limit) || 12,
  });

  await cache.set(CK.bestsellers(), products, CACHE_TTL.featured);
  ApiResponse.success(res, products, 'Bestsellers.');
};

// ═══════════════════════════════════════════════════════════
//   NEW ARRIVALS
// ═══════════════════════════════════════════════════════════

exports.getNewArrivals = async (req, res) => {
  const cached = await cache.get(CK.newArrivals());
  if (cached) return ApiResponse.success(res, cached, 'New arrivals.');

  const products = await prisma.product.findMany({
    where: { isActive: true, isNewArrival: true, deletedAt: null },
    select: CARD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: parseInt(req.query.limit) || 12,
  });

  await cache.set(CK.newArrivals(), products, CACHE_TTL.featured);
  ApiResponse.success(res, products, 'New arrivals.');
};

// ═══════════════════════════════════════════════════════════
//   ON SALE
// ═══════════════════════════════════════════════════════════

exports.getOnSale = async (req, res) => {
  const cached = await cache.get(CK.onSale());
  if (cached) return ApiResponse.success(res, cached, 'Products on sale.');

  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      isOnSale: true,
      comparePrice: { not: null },
      stock: { gt: 0 },
      deletedAt: null,
    },
    select: CARD_SELECT,
    orderBy: { createdAt: 'desc' },
    take: parseInt(req.query.limit) || 16,
  });

  await cache.set(CK.onSale(), products, CACHE_TTL.featured);
  ApiResponse.success(res, products, 'Products on sale.');
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT BY ID
// ═══════════════════════════════════════════════════════════

exports.getProductById = async (req, res) => {
  const { id } = req.params;

  const cached = await cache.get(CK.product(id));
  if (cached) return ApiResponse.success(res, cached);

  const product = await prisma.product.findFirst({
    where: { id, isActive: true, deletedAt: null },
    include: DETAIL_INCLUDE,
  });

  if (!product) throw AppError.notFound('Product');

  // Increment view count (async — don't await)
  prisma.product.update({
    where: { id },
    data: { totalViews: { increment: 1 } },
  }).catch(() => {});

  await cache.set(CK.product(id), product, CACHE_TTL.product);
  ApiResponse.success(res, product);
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT BY SLUG
// ═══════════════════════════════════════════════════════════

exports.getProductBySlug = async (req, res) => {
  const { slug } = req.params;

  const cached = await cache.get(CK.productSlug(slug));
  if (cached) return ApiResponse.success(res, cached);

  const product = await prisma.product.findFirst({
    where: { slug, isActive: true, deletedAt: null },
    include: DETAIL_INCLUDE,
  });

  if (!product) throw AppError.notFound('Product');

  prisma.product.update({ where: { id: product.id }, data: { totalViews: { increment: 1 } } }).catch(() => {});

  await cache.set(CK.productSlug(slug), product, CACHE_TTL.product);
  ApiResponse.success(res, product);
};

// ═══════════════════════════════════════════════════════════
//   RELATED PRODUCTS
// ═══════════════════════════════════════════════════════════

exports.getRelatedProducts = async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { categoryId: true, tags: true },
  });

  if (!product) throw AppError.notFound('Product');

  const related = await prisma.product.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      id: { not: id },
      OR: [
        { categoryId: product.categoryId },
        ...(product.tags.length > 0 ? [{ tags: { hasSome: product.tags } }] : []),
      ],
    },
    select: CARD_SELECT,
    orderBy: { totalSold: 'desc' },
    take: 8,
  });

  ApiResponse.success(res, related, 'Related products.');
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT REVIEWS (paginated)
// ═══════════════════════════════════════════════════════════

exports.getProductReviews = async (req, res) => {
  const { id } = req.params;
  const { page, limit, skip } = getPagination(req.query);
  const sort = req.query.sort || 'helpful';

  const orderBy = {
    helpful:  [{ helpfulCount: 'desc' }, { createdAt: 'desc' }],
    newest:   { createdAt: 'desc' },
    highest:  { rating: 'desc' },
    lowest:   { rating: 'asc' },
  }[sort] || [{ helpfulCount: 'desc' }];

  const where = {
    productId: id,
    status: 'APPROVED',
  };

  const [reviews, total, stats] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take: limit,
      orderBy,
      select: {
        id: true, rating: true, title: true, body: true, images: true,
        isVerifiedPurchase: true, helpfulCount: true, notHelpfulCount: true,
        adminReply: true, adminReplyAt: true, createdAt: true,
        user: { select: { name: true, avatar: true } },
      },
    }),
    prisma.review.count({ where }),
    // Rating distribution
    prisma.review.groupBy({
      by: ['rating'],
      where,
      _count: { rating: true },
    }),
  ]);

  // Build rating breakdown: { 5: 42, 4: 18, 3: 6, 2: 2, 1: 1 }
  const ratingBreakdown = [5, 4, 3, 2, 1].reduce((acc, r) => {
    acc[r] = stats.find((s) => s.rating === r)?._count?.rating || 0;
    return acc;
  }, {});

  const pagination = {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };

  ApiResponse.paginated(res, reviews, pagination, 'Reviews fetched.', { ratingBreakdown });
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT VARIANTS
// ═══════════════════════════════════════════════════════════

exports.getProductVariants = async (req, res) => {
  const { id } = req.params;

  const variants = await prisma.productVariant.findMany({
    where: { productId: id, isActive: true, deletedAt: null },
    orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }],
  });

  ApiResponse.success(res, variants, 'Variants fetched.');
};

// ═══════════════════════════════════════════════════════════
//   PUBLIC PRODUCT STATISTICS (Aggregated)
// ═══════════════════════════════════════════════════════════

exports.getProductStats = async (req, res) => {
  const cached = await cache.get(CK.stats());
  if (cached) return ApiResponse.success(res, cached, 'Product statistics.');

  const [total, inStock, onSale, featured, byCategory] = await Promise.all([
    prisma.product.count({ where: { isActive: true, deletedAt: null } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, stock: { gt: 0 } } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, isOnSale: true } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, isFeatured: true } }),
    prisma.category.findMany({
      where: { isActive: true, deletedAt: null },
      select: {
        id: true, name: true, slug: true, icon: true,
        _count: { select: { products: { where: { isActive: true, deletedAt: null } } } },
      },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  const stats = {
    total,
    inStock,
    outOfStock: total - inStock,
    onSale,
    featured,
    byCategory: byCategory.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      icon: c.icon,
      productCount: c._count.products,
    })),
  };

  await cache.set(CK.stats(), stats, CACHE_TTL.stats);
  ApiResponse.success(res, stats, 'Product statistics.');
};
