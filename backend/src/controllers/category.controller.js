/**
 * controllers/category.controller.js
 */
'use strict';

const { prisma } = require('../config/database');
const { cache, CACHE_KEYS } = require('../config/redis');
const { ApiResponse, parsePagination } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const { slugify } = require('../utils/helpers');
const { deleteFromCloudinary, extractPublicId } = require('../config/cloudinary');

exports.getAllCategories = async (req, res) => {
  const cacheKey = CACHE_KEYS.categories();
  const cached = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached);

  const categories = await prisma.category.findMany({
    where: { isActive: true, parentId: null },
    include: {
      children: { where: { isActive: true } },
      _count: { select: { products: { where: { isActive: true } } } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  await cache.set(cacheKey, categories, 1800);
  ApiResponse.success(res, categories);
};

exports.getCategoryBySlug = async (req, res) => {
  const category = await prisma.category.findFirst({
    where: { slug: req.params.slug, isActive: true },
    include: {
      children: { where: { isActive: true } },
      _count: { select: { products: { where: { isActive: true } } } },
    },
  });
  if (!category) throw AppError.notFound('Category');
  ApiResponse.success(res, category);
};

exports.getCategoryProducts = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const category = await prisma.category.findFirst({
    where: { slug: req.params.slug, isActive: true },
  });
  if (!category) throw AppError.notFound('Category');

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where: { categoryId: category.id, isActive: true },
      include: { images: { where: { isPrimary: true }, take: 1 } },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.product.count({ where: { categoryId: category.id, isActive: true } }),
  ]);

  ApiResponse.paginated(res, products, { page, limit, total });
};

exports.createCategory = async (req, res) => {
  const { name, description, parentId, icon, sortOrder } = req.body;
  const slug = slugify(name);

  const existing = await prisma.category.findUnique({ where: { slug } });
  if (existing) throw AppError.conflict(`Category with slug "${slug}" already exists.`);

  const category = await prisma.category.create({
    data: {
      name,
      slug,
      description,
      image: req.file?.path || null,
      imagePublicId: req.file?.filename || null,
      icon,
      parentId: parentId || null,
      sortOrder: sortOrder ? parseInt(sortOrder) : 0,
    },
  });

  await cache.del(CACHE_KEYS.categories());
  ApiResponse.created(res, category, 'Category created.');
};

exports.updateCategory = async (req, res) => {
  const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!existing) throw AppError.notFound('Category');

  // Delete old image if new one uploaded
  if (req.file && existing.imagePublicId) {
    await deleteFromCloudinary(existing.imagePublicId);
  }

  const { name, ...rest } = req.body;
  const updates = {
    ...rest,
    ...(name && { name, slug: slugify(name) }),
    ...(req.file && { image: req.file.path, imagePublicId: req.file.filename }),
  };

  const category = await prisma.category.update({
    where: { id: req.params.id },
    data: updates,
  });

  await cache.delPattern('categories:*');
  ApiResponse.success(res, category, 'Category updated.');
};

exports.deleteCategory = async (req, res) => {
  const category = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!category) throw AppError.notFound('Category');

  const productCount = await prisma.product.count({ where: { categoryId: req.params.id } });
  if (productCount > 0) {
    throw AppError.badRequest(`Cannot delete category with ${productCount} products. Reassign products first.`);
  }

  if (category.imagePublicId) await deleteFromCloudinary(category.imagePublicId);

  await prisma.category.delete({ where: { id: req.params.id } });
  await cache.delPattern('categories:*');
  ApiResponse.success(res, null, 'Category deleted.');
};
