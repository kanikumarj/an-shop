/**
 * controllers/admin/adminProduct.controller.js  [ENTERPRISE EDITION]
 * ====================================================================
 * Admin CRUD for products, variants, images, categories, and stock.
 *
 * POST   /admin/products                        — Create product
 * GET    /admin/products                        — List all (incl. inactive/deleted)
 * GET    /admin/products/:id                    — Get product (full detail)
 * PUT    /admin/products/:id                    — Update product
 * DELETE /admin/products/:id                    — Soft delete
 * DELETE /admin/products/:id/permanent          — Hard delete + Cloudinary cleanup
 * POST   /admin/products/:id/restore            — Restore soft-deleted
 *
 * Images:
 * POST   /admin/products/:id/images             — Upload images
 * DELETE /admin/products/:id/images/:imageId    — Delete single image
 * PATCH  /admin/products/:id/images/primary     — Set primary image
 * PATCH  /admin/products/:id/images/reorder     — Reorder images
 *
 * Variants:
 * POST   /admin/products/:id/variants           — Add variant
 * PUT    /admin/products/:id/variants/:vid      — Update variant
 * DELETE /admin/products/:id/variants/:vid      — Delete variant
 *
 * Stock:
 * PATCH  /admin/products/:id/stock              — Update stock level
 * PATCH  /admin/products/:id/stock/bulk         — Bulk stock adjustment
 *
 * Categories:
 * GET    /admin/categories                      — All categories
 * POST   /admin/categories                      — Create category
 * PUT    /admin/categories/:id                  — Update category
 * DELETE /admin/categories/:id                  — Delete category
 *
 * Bulk:
 * PATCH  /admin/products/bulk/status            — Bulk status toggle
 * PATCH  /admin/products/bulk/delete            — Bulk soft-delete
 * POST   /admin/products/bulk/import            — Future: CSV import
 *
 * Analytics:
 * GET    /admin/products/analytics              — Product dashboard stats
 */

'use strict';

const { prisma } = require('../../config/database');
const { cache } = require('../../config/redis');
const { ApiResponse } = require('../../utils/ApiResponse');
const AppError = require('../../utils/AppError');
const logger = require('../../utils/logger');
const {
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  generateResponsiveUrls,
} = require('../../config/cloudinary');
const {
  generateUniqueSlug,
  invalidateProductCache,
  attachProductImages,
  deleteProductImages,
  setPrimaryImage,
  reorderImages,
  buildProductFilter,
  buildProductSort,
  CARD_SELECT,
  CK,
} = require('../../services/product.service');
const {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateStockSchema,
  createCategorySchema,
  updateCategorySchema,
} = require('../../validations/product.validation');

// ─── Pagination helper ─────────────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ─── Full admin product detail ─────────────────────────────────────────────────
const ADMIN_PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  variants: { orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }] },
  _count: {
    select: {
      reviews: true,
      orderItems: true,
      cartItems: true,
      wishlistItems: true,
    },
  },
};

// ═══════════════════════════════════════════════════════════
//   LIST PRODUCTS (admin view — all statuses)
// ═══════════════════════════════════════════════════════════

exports.listProducts = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { deleted } = req.query;  // ?deleted=true shows only soft-deleted

  const where = {
    ...buildProductFilter(req.query, true),   // adminMode=true: bypass isActive filter
    ...(deleted === 'true'
      ? { deletedAt: { not: null } }
      : { deletedAt: null }),
  };

  const orderBy = buildProductSort(req.query.sort || 'newest');

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        category: { select: { id: true, name: true, slug: true } },
        images: {
          where: { isPrimary: true },
          select: { url: true, thumbnailUrl: true, alt: true },
          take: 1,
        },
        _count: { select: { orderItems: true, reviews: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  ApiResponse.paginated(res, products, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  }, `${total} product(s) found.`);
};

// ═══════════════════════════════════════════════════════════
//   GET ONE PRODUCT (admin full detail)
// ═══════════════════════════════════════════════════════════

exports.getProduct = async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id },
    include: ADMIN_PRODUCT_INCLUDE,
  });

  if (!product) throw AppError.notFound('Product');
  ApiResponse.success(res, product);
};

// ═══════════════════════════════════════════════════════════
//   CREATE PRODUCT
// ═══════════════════════════════════════════════════════════

exports.createProduct = async (req, res) => {
  const data = createProductSchema.parse(req.body);

  // Validate category exists
  const category = await prisma.category.findFirst({
    where: { id: data.categoryId, deletedAt: null },
  });
  if (!category) throw AppError.notFound('Category');

  // Validate SKU uniqueness
  if (data.sku) {
    const skuExists = await prisma.product.findFirst({ where: { sku: data.sku } });
    if (skuExists) throw AppError.conflict(`SKU "${data.sku}" is already in use.`);
  }

  // Generate unique slug from name
  const slug = await generateUniqueSlug(data.name);

  const product = await prisma.product.create({
    data: {
      ...data,
      slug,
      createdBy: req.user.id,
    },
    include: ADMIN_PRODUCT_INCLUDE,
  });

  // Attach uploaded images (if any)
  if (req.files?.length > 0) {
    await attachProductImages(product.id, req.files, true);
    await invalidateProductCache(product.id, slug);
  }

  // Log admin action
  logger.apiEvent('PRODUCT_CREATED', {
    adminId: req.user.id,
    productId: product.id,
    name: product.name,
    sku: product.sku,
  });

  await invalidateProductCache();

  ApiResponse.created(res, product, 'Product created successfully.');
};

// ═══════════════════════════════════════════════════════════
//   UPDATE PRODUCT
// ═══════════════════════════════════════════════════════════

exports.updateProduct = async (req, res) => {
  const { id } = req.params;

  const existing = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, slug: true, sku: true },
  });
  if (!existing) throw AppError.notFound('Product');

  const data = updateProductSchema.parse(req.body);

  // SKU uniqueness check
  if (data.sku && data.sku !== existing.sku) {
    const skuExists = await prisma.product.findFirst({
      where: { sku: data.sku, id: { not: id } },
    });
    if (skuExists) throw AppError.conflict(`SKU "${data.sku}" is already in use.`);
  }

  // Auto-regenerate slug if name changed
  if (data.name && data.name !== existing.name) {
    data.slug = await generateUniqueSlug(data.name, id);
  }

  const updated = await prisma.product.update({
    where: { id },
    data: { ...data, updatedBy: req.user.id },
    include: ADMIN_PRODUCT_INCLUDE,
  });

  await invalidateProductCache(id, existing.slug);
  if (data.slug) await invalidateProductCache(null, data.slug);

  logger.apiEvent('PRODUCT_UPDATED', {
    adminId: req.user.id,
    productId: id,
    changedFields: Object.keys(data),
  });

  ApiResponse.success(res, updated, 'Product updated.');
};

// ═══════════════════════════════════════════════════════════
//   SOFT DELETE
// ═══════════════════════════════════════════════════════════

exports.deleteProduct = async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, slug: true },
  });
  if (!product) throw AppError.notFound('Product');

  await prisma.product.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      deletedBy: req.user.id,
      isActive: false,
    },
  });

  await invalidateProductCache(id, product.slug);

  logger.apiEvent('PRODUCT_SOFT_DELETED', {
    adminId: req.user.id,
    productId: id,
    name: product.name,
  });

  ApiResponse.success(res, null, 'Product deleted.');
};

// ═══════════════════════════════════════════════════════════
//   HARD DELETE (permanent, with Cloudinary cleanup)
// ═══════════════════════════════════════════════════════════

exports.hardDeleteProduct = async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      images: { select: { publicId: true } },
    },
  });
  if (!product) throw AppError.notFound('Product');

  // Delete from Cloudinary
  const publicIds = product.images.map((i) => i.publicId).filter(Boolean);
  await deleteMultipleFromCloudinary(publicIds);

  // Delete from DB (cascades to images, variants, reviews, cart items)
  await prisma.product.delete({ where: { id } });

  await invalidateProductCache(id, product.slug);

  logger.apiEvent('PRODUCT_HARD_DELETED', {
    adminId: req.user.id,
    productId: id,
    name: product.name,
    imagesDeleted: publicIds.length,
  });

  ApiResponse.success(res, null, 'Product permanently deleted.');
};

// ═══════════════════════════════════════════════════════════
//   RESTORE SOFT-DELETED PRODUCT
// ═══════════════════════════════════════════════════════════

exports.restoreProduct = async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findFirst({
    where: { id, deletedAt: { not: null } },
  });
  if (!product) throw AppError.notFound('Deleted product');

  const restored = await prisma.product.update({
    where: { id },
    data: { deletedAt: null, deletedBy: null, isActive: true },
    include: ADMIN_PRODUCT_INCLUDE,
  });

  await invalidateProductCache(id, product.slug);
  ApiResponse.success(res, restored, 'Product restored.');
};

// ═══════════════════════════════════════════════════════════
//   UPLOAD PRODUCT IMAGES
// ═══════════════════════════════════════════════════════════

exports.uploadProductImages = async (req, res) => {
  const { id } = req.params;

  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    select: { id: true },
  });
  if (!product) throw AppError.notFound('Product');

  if (!req.files || req.files.length === 0) {
    throw AppError.badRequest('No image files provided.');
  }

  await attachProductImages(id, req.files, true);

  // Return updated images list
  const images = await prisma.productImage.findMany({
    where: { productId: id },
    orderBy: { sortOrder: 'asc' },
  });

  await invalidateProductCache(id);
  ApiResponse.created(res, images, `${req.files.length} image(s) uploaded.`);
};

// ═══════════════════════════════════════════════════════════
//   DELETE A PRODUCT IMAGE
// ═══════════════════════════════════════════════════════════

exports.deleteProductImage = async (req, res) => {
  const { id, imageId } = req.params;

  const image = await prisma.productImage.findFirst({
    where: { id: imageId, productId: id },
  });
  if (!image) throw AppError.notFound('Product image');

  await deleteProductImages([imageId]);

  // If deleted image was primary, promote next image
  if (image.isPrimary) {
    const next = await prisma.productImage.findFirst({
      where: { productId: id },
      orderBy: { sortOrder: 'asc' },
    });
    if (next) {
      await prisma.productImage.update({
        where: { id: next.id },
        data: { isPrimary: true },
      });
    }
  }

  await invalidateProductCache(id);
  ApiResponse.success(res, null, 'Image deleted.');
};

// ═══════════════════════════════════════════════════════════
//   SET PRIMARY IMAGE
// ═══════════════════════════════════════════════════════════

exports.setPrimaryImage = async (req, res) => {
  const { id } = req.params;
  const { imageId } = req.body;

  await setPrimaryImage(id, imageId);
  await invalidateProductCache(id);
  ApiResponse.success(res, null, 'Primary image updated.');
};

// ═══════════════════════════════════════════════════════════
//   REORDER IMAGES
// ═══════════════════════════════════════════════════════════

exports.reorderImages = async (req, res) => {
  const { id } = req.params;
  const { orderedImageIds } = req.body;

  if (!Array.isArray(orderedImageIds) || orderedImageIds.length === 0) {
    throw AppError.badRequest('orderedImageIds must be a non-empty array.');
  }

  await reorderImages(id, orderedImageIds);
  await invalidateProductCache(id);
  ApiResponse.success(res, null, 'Image order updated.');
};

// ═══════════════════════════════════════════════════════════
//   VARIANTS: CREATE
// ═══════════════════════════════════════════════════════════

exports.createVariant = async (req, res) => {
  const { id } = req.params;
  const data = createVariantSchema.parse(req.body);

  // SKU uniqueness
  const skuExists = await prisma.productVariant.findFirst({ where: { sku: data.sku } });
  if (skuExists) throw AppError.conflict(`Variant SKU "${data.sku}" already exists.`);

  // If this is default, unset others
  if (data.isDefault) {
    await prisma.productVariant.updateMany({
      where: { productId: id },
      data: { isDefault: false },
    });
  }

  const variant = await prisma.productVariant.create({
    data: { productId: id, ...data },
  });

  // Update product to mark it has variants
  await prisma.product.update({ where: { id }, data: { hasVariants: true } });
  await invalidateProductCache(id);

  ApiResponse.created(res, variant, 'Variant added.');
};

// ═══════════════════════════════════════════════════════════
//   VARIANTS: UPDATE
// ═══════════════════════════════════════════════════════════

exports.updateVariant = async (req, res) => {
  const { id, vid } = req.params;

  const variant = await prisma.productVariant.findFirst({
    where: { id: vid, productId: id, deletedAt: null },
  });
  if (!variant) throw AppError.notFound('Variant');

  const updated = await prisma.productVariant.update({
    where: { id: vid },
    data: req.body,
  });

  await invalidateProductCache(id);
  ApiResponse.success(res, updated, 'Variant updated.');
};

// ═══════════════════════════════════════════════════════════
//   VARIANTS: DELETE
// ═══════════════════════════════════════════════════════════

exports.deleteVariant = async (req, res) => {
  const { id, vid } = req.params;

  await prisma.productVariant.update({
    where: { id: vid, productId: id },
    data: { deletedAt: new Date(), isActive: false },
  });

  // If no active variants remain, mark product as no variants
  const remaining = await prisma.productVariant.count({
    where: { productId: id, deletedAt: null, isActive: true },
  });
  if (remaining === 0) {
    await prisma.product.update({ where: { id }, data: { hasVariants: false } });
  }

  await invalidateProductCache(id);
  ApiResponse.success(res, null, 'Variant deleted.');
};

// ═══════════════════════════════════════════════════════════
//   STOCK MANAGEMENT
// ═══════════════════════════════════════════════════════════

exports.updateStock = async (req, res) => {
  const { id } = req.params;
  const { stock, reason, variantId } = updateStockSchema.parse(req.body);

  if (variantId) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId: id },
    });
    if (!variant) throw AppError.notFound('Variant');

    await prisma.productVariant.update({
      where: { id: variantId },
      data: { stock },
    });
  } else {
    await prisma.product.update({
      where: { id },
      data: { stock },
    });
  }

  logger.apiEvent('STOCK_UPDATED', {
    adminId: req.user.id,
    productId: id,
    variantId,
    stock,
    reason: reason || 'manual_adjustment',
  });

  await invalidateProductCache(id);
  ApiResponse.success(res, { id, variantId, stock }, 'Stock updated.');
};

// ═══════════════════════════════════════════════════════════
//   BULK OPERATIONS
// ═══════════════════════════════════════════════════════════

exports.bulkUpdateStatus = async (req, res) => {
  const { productIds, isActive } = req.body;

  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw AppError.badRequest('productIds must be a non-empty array.');
  }
  if (typeof isActive !== 'boolean') {
    throw AppError.badRequest('isActive must be a boolean.');
  }

  const result = await prisma.product.updateMany({
    where: { id: { in: productIds }, deletedAt: null },
    data: { isActive },
  });

  // Bust caches for all affected products
  await Promise.all(productIds.map((id) => invalidateProductCache(id)));

  logger.apiEvent('BULK_PRODUCT_STATUS', {
    adminId: req.user.id,
    count: result.count,
    isActive,
    productIds,
  });

  ApiResponse.success(res, { updated: result.count }, `${result.count} product(s) ${isActive ? 'activated' : 'deactivated'}.`);
};

exports.bulkDelete = async (req, res) => {
  const { productIds } = req.body;

  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw AppError.badRequest('productIds must be a non-empty array.');
  }

  const result = await prisma.product.updateMany({
    where: { id: { in: productIds }, deletedAt: null },
    data: { deletedAt: new Date(), deletedBy: req.user.id, isActive: false },
  });

  await Promise.all(productIds.map((id) => invalidateProductCache(id)));

  logger.apiEvent('BULK_PRODUCT_DELETE', {
    adminId: req.user.id,
    count: result.count,
    productIds,
  });

  ApiResponse.success(res, { deleted: result.count }, `${result.count} product(s) deleted.`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN ANALYTICS
// ═══════════════════════════════════════════════════════════

exports.getProductAnalytics = async (req, res) => {
  const [
    totalProducts,
    activeProducts,
    outOfStock,
    lowStock,
    totalCategories,
    topSelling,
    topRated,
    recentlyAdded,
    stockValue,
  ] = await Promise.all([
    // Counts
    prisma.product.count({ where: { deletedAt: null } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, stock: 0 } }),
    prisma.product.count({
      where: {
        isActive: true,
        deletedAt: null,
        stock: { gt: 0, lte: prisma.product.fields.lowStockThreshold },
      },
    }).catch(() => 0),
    prisma.category.count({ where: { deletedAt: null, isActive: true } }),

    // Top selling
    prisma.product.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true, totalSold: true, basePrice: true, stock: true,
        images: { where: { isPrimary: true }, select: { thumbnailUrl: true }, take: 1 },
      },
      orderBy: { totalSold: 'desc' },
      take: 5,
    }),

    // Top rated
    prisma.product.findMany({
      where: { isActive: true, deletedAt: null, totalReviews: { gt: 0 } },
      select: { id: true, name: true, avgRating: true, totalReviews: true,
        images: { where: { isPrimary: true }, select: { thumbnailUrl: true }, take: 1 },
      },
      orderBy: { avgRating: 'desc' },
      take: 5,
    }),

    // Recently added
    prisma.product.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true, basePrice: true, stock: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),

    // Total inventory value (sum of stock × price)
    prisma.product.aggregate({
      where: { isActive: true, deletedAt: null },
      _sum: { stock: true },
    }),
  ]);

  ApiResponse.success(res, {
    summary: {
      totalProducts,
      activeProducts,
      inactiveProducts: totalProducts - activeProducts,
      outOfStock,
      lowStock,
      totalCategories,
    },
    topSelling,
    topRated,
    recentlyAdded,
    totalStockUnits: stockValue._sum.stock || 0,
  }, 'Analytics fetched.');
};

// ═══════════════════════════════════════════════════════════
//   CATEGORIES (Admin CRUD)
// ═══════════════════════════════════════════════════════════

exports.listCategories = async (req, res) => {
  const { includeEmpty = false, tree = false } = req.query;

  const categories = await prisma.category.findMany({
    where: { deletedAt: null, parentId: null },
    include: {
      children: {
        where: { deletedAt: null },
        include: {
          children: { where: { deletedAt: null } },
          _count: { select: { products: { where: { isActive: true, deletedAt: null } } } },
        },
      },
      _count: { select: { products: { where: { isActive: true, deletedAt: null } } } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  ApiResponse.success(res, categories, 'Categories fetched.');
};

exports.createCategory = async (req, res) => {
  const data = createCategorySchema.parse(req.body);

  const { slugify } = require('../../utils/helpers');
  const slug = data.slug || slugify(data.name);

  const slugExists = await prisma.category.findFirst({ where: { slug } });
  if (slugExists) throw AppError.conflict(`Slug "${slug}" already in use.`);

  const category = await prisma.category.create({
    data: { ...data, slug },
  });

  // Attach image if uploaded
  if (req.file) {
    await prisma.category.update({
      where: { id: category.id },
      data: {
        image: req.file.path,
        imagePublicId: req.file.filename,
      },
    });
  }

  await cache.del(CK.categories());
  ApiResponse.created(res, category, 'Category created.');
};

exports.updateCategory = async (req, res) => {
  const { id } = req.params;
  const data = updateCategorySchema.parse(req.body);

  const category = await prisma.category.findFirst({ where: { id, deletedAt: null } });
  if (!category) throw AppError.notFound('Category');

  // Image replacement
  if (req.file) {
    if (category.imagePublicId) {
      await deleteFromCloudinary(category.imagePublicId).catch(() => {});
    }
    data.image = req.file.path;
    data.imagePublicId = req.file.filename;
  }

  const updated = await prisma.category.update({ where: { id }, data });

  await cache.del(CK.categories());
  await cache.del(CK.category(category.slug));
  ApiResponse.success(res, updated, 'Category updated.');
};

exports.deleteCategory = async (req, res) => {
  const { id } = req.params;

  const category = await prisma.category.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      _count: { select: { products: { where: { deletedAt: null } } } },
    },
  });
  if (!category) throw AppError.notFound('Category');

  if (category._count.products > 0) {
    throw AppError.badRequest(
      `Cannot delete category with ${category._count.products} product(s). Re-assign products first.`
    );
  }

  await prisma.category.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  await cache.del(CK.categories());
  ApiResponse.success(res, null, 'Category deleted.');
};
