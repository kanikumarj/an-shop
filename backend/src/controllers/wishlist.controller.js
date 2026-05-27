/**
 * controllers/wishlist.controller.js
 */
'use strict';

const { prisma } = require('../config/database');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');

exports.getWishlist = async (req, res) => {
  const items = await prisma.wishlistItem.findMany({
    where: { userId: req.user.id },
    include: {
      product: {
        select: {
          id: true, name: true, slug: true, price: true, comparePrice: true,
          stock: true, avgRating: true,
          images: { where: { isPrimary: true }, take: 1 },
          category: { select: { name: true, slug: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  ApiResponse.success(res, items, 'Wishlist fetched.');
};

exports.addToWishlist = async (req, res) => {
  const product = await prisma.product.findFirst({
    where: { id: req.params.productId, isActive: true },
  });
  if (!product) throw AppError.notFound('Product');

  const existing = await prisma.wishlistItem.findFirst({
    where: { userId: req.user.id, productId: req.params.productId },
  });
  if (existing) throw AppError.conflict('Product already in wishlist.');

  const item = await prisma.wishlistItem.create({
    data: { userId: req.user.id, productId: req.params.productId },
  });
  ApiResponse.created(res, item, 'Added to wishlist. ❤️');
};

exports.removeFromWishlist = async (req, res) => {
  await prisma.wishlistItem.deleteMany({
    where: { userId: req.user.id, productId: req.params.productId },
  });
  ApiResponse.success(res, null, 'Removed from wishlist.');
};

exports.clearWishlist = async (req, res) => {
  await prisma.wishlistItem.deleteMany({ where: { userId: req.user.id } });
  ApiResponse.success(res, null, 'Wishlist cleared.');
};

exports.moveToCart = async (req, res) => {
  const item = await prisma.wishlistItem.findFirst({
    where: { userId: req.user.id, productId: req.params.productId },
    include: { product: true },
  });
  if (!item) throw AppError.notFound('Wishlist item');
  if (item.product.stock < 1) throw AppError.badRequest('Product is out of stock.');

  await prisma.cartItem.upsert({
    where: {
      userId_productId_variantId: { userId: req.user.id, productId: req.params.productId, variantId: null },
    },
    update: { quantity: { increment: 1 } },
    create: { userId: req.user.id, productId: req.params.productId, variantId: null, quantity: 1 },
  });

  await prisma.wishlistItem.deleteMany({
    where: { userId: req.user.id, productId: req.params.productId },
  });

  ApiResponse.success(res, null, 'Moved to cart! 🛒');
};
