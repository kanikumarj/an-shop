/**
 * controllers/cart.controller.js  [ENTERPRISE EDITION]
 * ======================================================
 * High-performance cart management with:
 *   - Redis caching (15-min TTL, smart invalidation)
 *   - Price-change detection
 *   - Per-item stock validation
 *   - Full cart checkout readiness check
 *   - Coupon validation & application
 *   - Saved-for-later (cart wishlist)
 *   - Guest cart merge on login
 *   - Batch add for mobile sync
 *   - Checkout preview (cost breakdown without placing order)
 *
 * Routes served:
 *   GET    /cart                   — Full cart with summary
 *   GET    /cart/count             — Lightweight: item count only
 *   GET    /cart/validate          — Pre-checkout stock + price check
 *   GET    /cart/checkout-preview  — Full cost breakdown before order
 *   POST   /cart                   — Add item
 *   POST   /cart/batch             — Add multiple items at once
 *   POST   /cart/sync              — Guest cart merge on login
 *   PUT    /cart/:itemId           — Update quantity
 *   DELETE /cart/:itemId           — Remove single item
 *   DELETE /cart                   — Clear entire cart
 *
 *   POST   /cart/coupon            — Apply coupon
 *   DELETE /cart/coupon            — Remove coupon
 *
 *   POST   /cart/:itemId/save      — Move item to saved-for-later
 *   POST   /cart/:itemId/unsave    — Move saved item back to cart
 *   GET    /cart/saved             — Get saved-for-later list
 */

'use strict';

const { prisma } = require('../config/database');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const {
  loadCartItems,
  enrichCartItems,
  calculateCartSummary,
  validateCoupon,
  validateItemStock,
  validateCartForCheckout,
  invalidateCartCache,
  getCachedCart,
  setCachedCart,
  mergeGuestCart,
  MAX_ITEMS_PER_CART,
  MAX_QUANTITY_PER_ITEM,
} = require('../services/cart.service');

// ─── Build full cart response ─────────────────────────────────────────────────
const buildCartResponse = async (userId, couponResult = null) => {
  const rawItems = await loadCartItems(userId);
  const { activeItems, savedItems, alerts } = enrichCartItems(rawItems);
  const summary = calculateCartSummary(activeItems, couponResult);

  return { activeItems, savedItems, summary, alerts };
};

// ═══════════════════════════════════════════════════════════
//   GET CART
// ═══════════════════════════════════════════════════════════

exports.getCart = async (req, res) => {
  const userId = req.user.id;

  // Try cache first — but only if no coupon (coupon state not stored in cache)
  const cached = await getCachedCart(userId);
  if (cached) {
    return res.json({
      success: true,
      message: 'Cart fetched.',
      data: cached,
      cached: true,
    });
  }

  const cartData = await buildCartResponse(userId);

  // Cache if no blocking items and no alerts (clean cart)
  if (cartData.alerts.length === 0) {
    await setCachedCart(userId, cartData);
  }

  ApiResponse.success(res, cartData, 'Cart fetched.');
};

// ═══════════════════════════════════════════════════════════
//   GET CART COUNT (lightweight — for badge)
// ═══════════════════════════════════════════════════════════

exports.getCartCount = async (req, res) => {
  const count = await prisma.cartItem.aggregate({
    where: { userId: req.user.id, isSavedForLater: false },
    _sum: { quantity: true },
    _count: { id: true },
  });

  ApiResponse.success(res, {
    totalQuantity:  count._sum.quantity || 0,
    uniqueProducts: count._count.id || 0,
  }, 'Cart count.');
};

// ═══════════════════════════════════════════════════════════
//   ADD TO CART
// ═══════════════════════════════════════════════════════════

exports.addToCart = async (req, res) => {
  const { productId, variantId = null, quantity = 1, notes } = req.body;
  const userId = req.user.id;

  // Validate stock before touching the cart
  const { product, effectivePrice } = await validateItemStock(productId, quantity, variantId);

  // Check cart size cap
  const existingCount = await prisma.cartItem.count({
    where: { userId, isSavedForLater: false },
  });

  // Check if item already exists (so we count correctly)
  const existingItem = await prisma.cartItem.findFirst({
    where: { userId, productId, variantId: variantId || null, isSavedForLater: false },
  });

  if (!existingItem && existingCount >= MAX_ITEMS_PER_CART) {
    throw AppError.badRequest(
      `Cart is full (max ${MAX_ITEMS_PER_CART} unique items). Remove an item to continue.`,
      'CART_FULL'
    );
  }

  // If updating existing item, validate combined quantity
  if (existingItem) {
    const newTotal = existingItem.quantity + quantity;
    if (newTotal > MAX_QUANTITY_PER_ITEM) {
      throw AppError.badRequest(
        `Maximum ${MAX_QUANTITY_PER_ITEM} units per item. You already have ${existingItem.quantity} in cart.`,
        'MAX_QUANTITY_EXCEEDED'
      );
    }

    // Re-validate stock against combined quantity
    await validateItemStock(productId, newTotal, variantId);
  }

  const existing = await prisma.cartItem.findFirst({
    where: {
      userId,
      productId,
      variantId: variantId || null,
    },
  });

  let cartItem;
  if (existing) {
    cartItem = await prisma.cartItem.update({
      where: { id: existing.id },
      data: {
        quantity:   { increment: quantity },
        priceAtAdd: effectivePrice,
        isSavedForLater: false,
        notes: notes ?? undefined,
      },
      include: {
        product: {
          select: {
            id: true, name: true, slug: true, basePrice: true,
            images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
          },
        },
        variant: { select: { id: true, name: true, price: true, attributes: true } },
      },
    });
  } else {
    cartItem = await prisma.cartItem.create({
      data: {
        userId,
        productId,
        variantId: variantId || null,
        quantity,
        priceAtAdd:  effectivePrice,
        notes:       notes || null,
        isSavedForLater: false,
      },
      include: {
        product: {
          select: {
            id: true, name: true, slug: true, basePrice: true,
            images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
          },
        },
        variant: { select: { id: true, name: true, price: true, attributes: true } },
      },
    });
  }

  await invalidateCartCache(userId);

  logger.info('🛒 Item added to cart', {
    userId,
    productId,
    variantId,
    quantity,
    price: effectivePrice,
  });

  ApiResponse.success(res, {
    item: cartItem,
    addedPrice: effectivePrice,
  }, `"${product.name}" added to cart.`, 201);
};

// ═══════════════════════════════════════════════════════════
//   BATCH ADD (mobile sync / wishlist → cart)
// ═══════════════════════════════════════════════════════════

exports.batchAdd = async (req, res) => {
  const { items } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(items) || items.length === 0) {
    throw AppError.badRequest('items must be a non-empty array.');
  }
  if (items.length > 20) {
    throw AppError.badRequest('Maximum 20 items per batch.');
  }

  const results = { added: [], failed: [] };

  for (const item of items) {
    const { productId, variantId = null, quantity = 1 } = item;
    try {
      const { effectivePrice } = await validateItemStock(productId, quantity, variantId);

      const existingBatchItem = await prisma.cartItem.findFirst({
        where: {
          userId,
          productId,
          variantId: variantId || null,
        },
      });

      if (existingBatchItem) {
        await prisma.cartItem.update({
          where: { id: existingBatchItem.id },
          data: { quantity: { increment: quantity }, priceAtAdd: effectivePrice },
        });
      } else {
        await prisma.cartItem.create({
          data: { userId, productId, variantId: variantId || null, quantity, priceAtAdd: effectivePrice },
        });
      }

      results.added.push({ productId, variantId, quantity });
    } catch (err) {
      results.failed.push({ productId, variantId, quantity, error: err.message });
    }
  }

  await invalidateCartCache(userId);

  ApiResponse.success(res, results,
    `${results.added.length} item(s) added, ${results.failed.length} skipped.`,
    results.failed.length === 0 ? 200 : 207
  );
};

// ═══════════════════════════════════════════════════════════
//   UPDATE CART ITEM QUANTITY
// ═══════════════════════════════════════════════════════════

exports.updateCartItem = async (req, res) => {
  const { itemId } = req.params;
  const { quantity } = req.body;
  const userId = req.user.id;

  // Fetch item (verify ownership)
  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, userId },
    include: {
      product: { select: { id: true, name: true, stock: true, allowBackorder: true, trackInventory: true } },
      variant: { select: { id: true, stock: true } },
    },
  });

  if (!item) throw AppError.notFound('Cart item');

  // Re-validate stock with new quantity
  await validateItemStock(item.productId, quantity, item.variantId);

  const updated = await prisma.cartItem.update({
    where: { id: itemId },
    data: { quantity },
    include: {
      product: {
        select: {
          id: true, name: true, basePrice: true,
          images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
        },
      },
      variant: { select: { id: true, name: true, price: true } },
    },
  });

  await invalidateCartCache(userId);
  ApiResponse.success(res, updated, 'Cart updated.');
};

// ═══════════════════════════════════════════════════════════
//   REMOVE ITEM
// ═══════════════════════════════════════════════════════════

exports.removeFromCart = async (req, res) => {
  const { itemId } = req.params;
  const userId = req.user.id;

  const deleted = await prisma.cartItem.deleteMany({
    where: { id: itemId, userId },
  });

  if (deleted.count === 0) throw AppError.notFound('Cart item');

  await invalidateCartCache(userId);
  ApiResponse.success(res, null, 'Item removed from cart.');
};

// ═══════════════════════════════════════════════════════════
//   CLEAR CART
// ═══════════════════════════════════════════════════════════

exports.clearCart = async (req, res) => {
  const userId = req.user.id;
  const { includeSaved = false } = req.query;

  await prisma.cartItem.deleteMany({
    where: {
      userId,
      ...(includeSaved === 'true' ? {} : { isSavedForLater: false }),
    },
  });

  await invalidateCartCache(userId);
  ApiResponse.success(res, null, 'Cart cleared.');
};

// ═══════════════════════════════════════════════════════════
//   APPLY COUPON
// ═══════════════════════════════════════════════════════════

exports.applyCoupon = async (req, res) => {
  const { code } = req.body;
  const userId = req.user.id;

  // Load cart to get subtotal
  const rawItems = await loadCartItems(userId);
  const { activeItems } = enrichCartItems(rawItems);
  const orderableItems = activeItems.filter((i) => i.status === 'AVAILABLE');

  if (orderableItems.length === 0) {
    throw AppError.badRequest('Your cart is empty or has no orderable items.');
  }

  const subtotal = orderableItems.reduce((s, i) => s + i.lineTotal, 0);
  const result = await validateCoupon(code, userId, orderableItems, subtotal);

  if (!result.valid) {
    throw AppError.badRequest(result.error, 'COUPON_INVALID', {
      minOrderAmount: result.minOrderAmount,
      shortfall: result.shortfall,
    });
  }

  // Store applied coupon in user's session (Redis)
  await require('../config/redis').cache.set(
    `cart:coupon:${userId}`,
    { code: result.code, couponId: result.couponId, discount: result.discount },
    15 * 60
  );

  // Return updated summary with coupon applied
  const summary = calculateCartSummary(activeItems, result);

  ApiResponse.success(res, {
    coupon: {
      code:        result.code,
      type:        result.type,
      discount:    result.discount,
      savingsText: result.savingsText,
      description: result.description,
    },
    summary,
  }, `Coupon "${result.code}" applied! You save ₹${result.discount.toFixed(2)}.`);
};

// ═══════════════════════════════════════════════════════════
//   REMOVE COUPON
// ═══════════════════════════════════════════════════════════

exports.removeCoupon = async (req, res) => {
  await require('../config/redis').cache.del(`cart:coupon:${req.user.id}`);
  await invalidateCartCache(req.user.id);
  ApiResponse.success(res, null, 'Coupon removed.');
};

// ═══════════════════════════════════════════════════════════
//   SAVE FOR LATER
// ═══════════════════════════════════════════════════════════

exports.saveForLater = async (req, res) => {
  const { itemId } = req.params;
  const userId = req.user.id;

  const item = await prisma.cartItem.findFirst({ where: { id: itemId, userId } });
  if (!item) throw AppError.notFound('Cart item');
  if (item.isSavedForLater) throw AppError.badRequest('Item is already saved for later.');

  await prisma.cartItem.update({
    where: { id: itemId },
    data: { isSavedForLater: true },
  });

  await invalidateCartCache(userId);
  ApiResponse.success(res, null, 'Item saved for later.');
};

// ═══════════════════════════════════════════════════════════
//   MOVE SAVED ITEM BACK TO CART
// ═══════════════════════════════════════════════════════════

exports.moveToCart = async (req, res) => {
  const { itemId } = req.params;
  const userId = req.user.id;

  const item = await prisma.cartItem.findFirst({
    where: { id: itemId, userId, isSavedForLater: true },
    include: { product: true, variant: true },
  });
  if (!item) throw AppError.notFound('Saved item');

  // Validate stock before moving back to active cart
  await validateItemStock(item.productId, item.quantity, item.variantId);

  const updated = await prisma.cartItem.update({
    where: { id: itemId },
    data: { isSavedForLater: false },
    include: {
      product: { select: { id: true, name: true, basePrice: true, images: { where: { isPrimary: true }, take: 1 } } },
      variant: { select: { id: true, name: true, price: true } },
    },
  });

  await invalidateCartCache(userId);
  ApiResponse.success(res, updated, 'Item moved back to cart.');
};

// ═══════════════════════════════════════════════════════════
//   GET SAVED FOR LATER
// ═══════════════════════════════════════════════════════════

exports.getSavedItems = async (req, res) => {
  const savedItems = await prisma.cartItem.findMany({
    where: { userId: req.user.id, isSavedForLater: true },
    include: {
      product: {
        select: {
          id: true, name: true, slug: true, basePrice: true, comparePrice: true,
          stock: true, isActive: true,
          images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
        },
      },
      variant: { select: { id: true, name: true, price: true, stock: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  ApiResponse.success(res, savedItems, `${savedItems.length} saved item(s).`);
};

// ═══════════════════════════════════════════════════════════
//   VALIDATE CART (pre-checkout)
// ═══════════════════════════════════════════════════════════

exports.validateCart = async (req, res) => {
  const { isReady, blockedItems, alerts, orderableItems } = await validateCartForCheckout(req.user.id);

  ApiResponse.success(res, {
    isReady,
    blockedItems,
    orderableCount: orderableItems.length,
    alerts,
  }, isReady ? 'Cart is ready for checkout.' : 'Cart has issues. Please review.');
};

// ═══════════════════════════════════════════════════════════
//   CHECKOUT PREVIEW (cost breakdown — no order placed)
// ═══════════════════════════════════════════════════════════

exports.checkoutPreview = async (req, res) => {
  const userId = req.user.id;
  const { couponCode, addressId } = req.query;

  // Load + enrich cart
  const rawItems = await loadCartItems(userId);
  const { activeItems, savedItems, alerts } = enrichCartItems(rawItems);
  const orderableItems = activeItems.filter((i) => i.status === 'AVAILABLE');
  const blockedItems   = activeItems.filter((i) => i.status !== 'AVAILABLE');

  if (orderableItems.length === 0) {
    throw AppError.badRequest(
      blockedItems.length > 0
        ? 'All cart items are unavailable or out of stock.'
        : 'Your cart is empty.'
    );
  }

  // Load address if provided
  let address = null;
  if (addressId) {
    address = await prisma.address.findFirst({
      where: { id: addressId, userId },
      select: { id: true, fullName: true, line1: true, line2: true, city: true, state: true, pincode: true },
    });
  }

  // Validate coupon if provided
  let couponResult = null;
  if (couponCode) {
    const subtotal = orderableItems.reduce((s, i) => s + i.lineTotal, 0);
    couponResult = await validateCoupon(couponCode, userId, orderableItems, subtotal);
    // Don't throw on invalid — just show without coupon
  }

  const summary = calculateCartSummary(orderableItems, couponResult, address?.pincode);

  ApiResponse.success(res, {
    orderableItems,
    blockedItems,
    savedItemCount: savedItems.length,
    alerts,
    coupon: couponResult?.valid ? {
      code:     couponResult.code,
      discount: couponResult.discount,
      savings:  couponResult.savingsText,
    } : null,
    couponError: couponResult && !couponResult.valid ? couponResult.error : null,
    address,
    summary,
    estimatedDelivery: '3-5 business days',
  }, 'Checkout preview ready.');
};

// ═══════════════════════════════════════════════════════════
//   GUEST CART SYNC (merge on login)
// ═══════════════════════════════════════════════════════════

exports.syncCart = async (req, res) => {
  const { items } = req.body;
  const userId = req.user.id;

  if (!Array.isArray(items) || items.length === 0) {
    return ApiResponse.success(res, { merged: 0, skipped: 0 }, 'Nothing to sync.');
  }

  const result = await mergeGuestCart(userId, items);

  logger.info('🔄 Guest cart merged', { userId, ...result });
  ApiResponse.success(res, result,
    `Cart synced: ${result.merged} item(s) added, ${result.skipped} skipped.`
  );
};

// ═══════════════════════════════════════════════════════════
//   UPDATE ITEM NOTES
// ═══════════════════════════════════════════════════════════

exports.updateItemNotes = async (req, res) => {
  const { itemId } = req.params;
  const { notes } = req.body;
  const userId = req.user.id;

  const item = await prisma.cartItem.findFirst({ where: { id: itemId, userId } });
  if (!item) throw AppError.notFound('Cart item');

  const updated = await prisma.cartItem.update({
    where: { id: itemId },
    data: { notes: notes?.trim() || null },
  });

  await invalidateCartCache(userId);
  ApiResponse.success(res, updated, 'Item notes updated.');
};
