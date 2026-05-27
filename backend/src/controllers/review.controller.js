/**
 * controllers/review.controller.js
 */
'use strict';

const { prisma } = require('../config/database');
const { ApiResponse, parsePagination } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const { cache } = require('../config/redis');

exports.getProductReviews = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { rating } = req.query;

  const where = {
    productId: req.params.productId,
    isApproved: true,
    ...(rating && { rating: parseInt(rating) }),
  };

  const [reviews, total, stats] = await Promise.all([
    prisma.review.findMany({
      where,
      include: { user: { select: { name: true, avatar: true } } },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
    }),
    prisma.review.count({ where }),
    prisma.review.groupBy({
      by: ['rating'],
      where: { productId: req.params.productId, isApproved: true },
      _count: true,
    }),
  ]);

  const ratingDistribution = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  stats.forEach((s) => { ratingDistribution[s.rating] = s._count; });

  ApiResponse.paginated(res, reviews, { page, limit, total }, 'Reviews fetched.', { stats: { ratingDistribution } });
};

exports.createReview = async (req, res) => {
  const { rating, title, comment, images } = req.body;

  // Check if user has ordered this product
  const hasPurchased = await prisma.orderItem.findFirst({
    where: {
      productId: req.params.productId,
      order: { userId: req.user.id, paymentStatus: 'PAID' },
    },
  });

  const existing = await prisma.review.findUnique({
    where: { userId_productId: { userId: req.user.id, productId: req.params.productId } },
  });
  if (existing) throw AppError.conflict('You have already reviewed this product.');

  const review = await prisma.review.create({
    data: {
      userId: req.user.id,
      productId: req.params.productId,
      rating: parseInt(rating),
      title,
      comment,
      images: images || [],
      isVerified: !!hasPurchased,
    },
    include: { user: { select: { name: true, avatar: true } } },
  });

  // Update product rating cache
  const aggResult = await prisma.review.aggregate({
    where: { productId: req.params.productId, isApproved: true },
    _avg: { rating: true },
    _count: { rating: true },
  });

  await prisma.product.update({
    where: { id: req.params.productId },
    data: {
      avgRating: aggResult._avg.rating || 0,
      reviewCount: aggResult._count.rating,
    },
  });

  await cache.delPattern(`product:*`);

  ApiResponse.created(res, review, 'Review submitted successfully!');
};

exports.updateReview = async (req, res) => {
  const review = await prisma.review.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!review) throw AppError.notFound('Review');

  const updated = await prisma.review.update({
    where: { id: req.params.id },
    data: req.body,
  });

  ApiResponse.success(res, updated, 'Review updated.');
};

exports.deleteReview = async (req, res) => {
  const review = await prisma.review.findFirst({
    where: {
      id: req.params.id,
      ...(req.user.role !== 'ADMIN' && { userId: req.user.id }),
    },
  });
  if (!review) throw AppError.notFound('Review');

  await prisma.review.delete({ where: { id: req.params.id } });
  ApiResponse.success(res, null, 'Review deleted.');
};

exports.markHelpful = async (req, res) => {
  await prisma.review.update({
    where: { id: req.params.id },
    data: { helpfulCount: { increment: 1 } },
  });
  ApiResponse.success(res, null, 'Marked as helpful.');
};
