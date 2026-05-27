/**
 * routes/cart.routes.js  [ENTERPRISE EDITION]
 * =============================================
 * Complete cart routing:
 *   - Smart rate limiting per route sensitivity
 *   - Zod validation on all mutation routes
 *   - JWT authentication on all routes
 */

'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const cartController = require('../controllers/cart.controller');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  addToCartSchema,
  updateCartSchema,
  batchAddSchema,
  applyCouponSchema,
  syncCartSchema,
  updateNotesSchema,
} = require('../validations/cart.validation');

const router = Router();

// All cart routes require authentication
router.use(protect);

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const cartReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many cart requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const cartWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { success: false, message: 'Too many cart modifications.' },
});

const couponLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many coupon attempts. Try again in 5 minutes.' },
});

// ─────────────────────────────────────────────────────────────────────────────
//   READ ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /cart              — Full cart with enriched items, summary, alerts
router.get('/',
  cartReadLimiter,
  cartController.getCart
);

// GET /cart/count        — Lightweight: total quantity + unique product count
router.get('/count',
  cartReadLimiter,
  cartController.getCartCount
);

// GET /cart/validate     — Pre-checkout: stock + availability check
router.get('/validate',
  cartReadLimiter,
  cartController.validateCart
);

// GET /cart/checkout-preview  — Full cost breakdown with optional coupon & address
// Query: ?couponCode=SAVE10&addressId=uuid
router.get('/checkout-preview',
  cartReadLimiter,
  cartController.checkoutPreview
);

// GET /cart/saved        — Saved-for-later items
router.get('/saved',
  cartReadLimiter,
  cartController.getSavedItems
);

// ─────────────────────────────────────────────────────────────────────────────
//   CART MUTATIONS
// ─────────────────────────────────────────────────────────────────────────────

// POST /cart             — Add single item
router.post('/',
  cartWriteLimiter,
  validate(addToCartSchema),
  cartController.addToCart
);

// POST /cart/batch       — Add multiple items at once
router.post('/batch',
  cartWriteLimiter,
  validate(batchAddSchema),
  cartController.batchAdd
);

// POST /cart/sync        — Merge guest cart after login
router.post('/sync',
  cartWriteLimiter,
  validate(syncCartSchema),
  cartController.syncCart
);

// PUT /cart/:itemId      — Update quantity
router.put('/:itemId',
  cartWriteLimiter,
  validate(updateCartSchema),
  cartController.updateCartItem
);

// PATCH /cart/:itemId/notes  — Update item special instructions
router.patch('/:itemId/notes',
  cartWriteLimiter,
  validate(updateNotesSchema),
  cartController.updateItemNotes
);

// DELETE /cart/:itemId   — Remove single item
router.delete('/:itemId',
  cartWriteLimiter,
  cartController.removeFromCart
);

// DELETE /cart           — Clear entire cart (?includeSaved=true to also clear saved)
router.delete('/',
  cartWriteLimiter,
  cartController.clearCart
);

// ─────────────────────────────────────────────────────────────────────────────
//   COUPON ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// POST /cart/coupon      — Apply a coupon code
router.post('/coupon',
  couponLimiter,
  validate(applyCouponSchema),
  cartController.applyCoupon
);

// DELETE /cart/coupon    — Remove applied coupon
router.delete('/coupon',
  couponLimiter,
  cartController.removeCoupon
);

// ─────────────────────────────────────────────────────────────────────────────
//   SAVED FOR LATER
// ─────────────────────────────────────────────────────────────────────────────

// POST /cart/:itemId/save    — Move item from cart to saved-for-later
router.post('/:itemId/save',
  cartWriteLimiter,
  cartController.saveForLater
);

// POST /cart/:itemId/unsave  — Move item back from saved-for-later to cart
router.post('/:itemId/unsave',
  cartWriteLimiter,
  cartController.moveToCart
);

module.exports = router;
