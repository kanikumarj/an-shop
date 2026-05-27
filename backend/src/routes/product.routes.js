/**
 * routes/product.routes.js  [ENTERPRISE EDITION]
 * ================================================
 * Public product browsing routes.
 * All responses are cached in Redis.
 */

'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const productController = require('../controllers/product.controller');
const { optionalAuth } = require('../middleware/auth');

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const browseLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,       // 1 minute
  max: 120,
  message: { success: false, message: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many search requests. Slow down.' },
});

// ─── Public Collection Routes ─────────────────────────────────────────────────

// GET /products?page=1&limit=20&sort=newest&category=namkeens&minPrice=50&maxPrice=500&inStock=true&featured=true&onSale=true&tags=spicy,crunchy&rating=4
router.get('/',           browseLimiter, optionalAuth, productController.getAllProducts);

// GET /products/search?q=chakli&sort=-rating&page=1
router.get('/search',     searchLimiter, productController.searchProducts);

// GET /products/featured
router.get('/featured',   browseLimiter, productController.getFeaturedProducts);

// GET /products/bestsellers
router.get('/bestsellers', browseLimiter, productController.getBestsellers);

// GET /products/new-arrivals
router.get('/new-arrivals', browseLimiter, productController.getNewArrivals);

// GET /products/on-sale
router.get('/on-sale',    browseLimiter, productController.getOnSale);

// GET /products/stats
router.get('/stats',      browseLimiter, productController.getProductStats);

// ─── Single Product Routes ─────────────────────────────────────────────────────

// GET /products/slug/:slug  — SEO-friendly URL
router.get('/slug/:slug', browseLimiter, optionalAuth, productController.getProductBySlug);

// GET /products/:id
router.get('/:id',        browseLimiter, optionalAuth, productController.getProductById);

// GET /products/:id/related
router.get('/:id/related', browseLimiter, productController.getRelatedProducts);

// GET /products/:id/reviews?page=1&sort=helpful
router.get('/:id/reviews', browseLimiter, productController.getProductReviews);

// GET /products/:id/variants
router.get('/:id/variants', browseLimiter, productController.getProductVariants);

module.exports = router;
