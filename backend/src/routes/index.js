/**
 * routes/index.js
 * ================
 * Master API router — mounts all sub-routers under /api/v1.
 */

'use strict';

const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const productRoutes = require('./product.routes');
const categoryRoutes = require('./category.routes');
const cartRoutes = require('./cart.routes');
const orderRoutes = require('./order.routes');
const paymentRoutes = require('./payment.routes');
const reviewRoutes = require('./review.routes');
const wishlistRoutes = require('./wishlist.routes');
const adminRoutes = require('./admin.routes');
const notificationRoutes = require('./notification.routes');
const couponRoutes = require('./coupon.routes');
const uploadRoutes   = require('./upload.routes');
const trackingRoutes = require('./tracking.routes');

// ─── Mount Routes ──────────────────────────────────────────────────────────────
router.use('/auth',          authRoutes);
router.use('/users',         userRoutes);
router.use('/products',      productRoutes);
router.use('/categories',    categoryRoutes);
router.use('/cart',          cartRoutes);
router.use('/orders',        orderRoutes);
router.use('/payments',      paymentRoutes);
router.use('/tracking',      trackingRoutes);
router.use('/reviews',       reviewRoutes);
router.use('/wishlist',      wishlistRoutes);
router.use('/admin',         adminRoutes);
router.use('/notifications', notificationRoutes);
router.use('/coupons',       couponRoutes);
router.use('/upload',        uploadRoutes);

module.exports = router;
