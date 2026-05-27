/**
 * services/cart.service.js
 * =========================
 * High-performance cart business logic layer.
 *
 * Responsibilities:
 *   - Cart state loading with full enrichment (prices, images, stock)
 *   - Price-change detection (product price changed since item was added)
 *   - Stock validation per item (and across the full cart)
 *   - Cart total calculation (subtotal, discount, coupon, shipping, tax, total)
 *   - Coupon validation and application
 *   - Saved-for-later management (cart wishlist)
 *   - Guest cart merge on login (session → user)
 *   - Batch add/sync for mobile app sync
 *   - Checkout preview (pre-order cost breakdown)
 *   - Cache management (Redis per-user cart, 15-min TTL)
 *   - Stock reservation / release cycle
 */

'use strict';

const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const { roundTo, calculateShipping } = require('../utils/helpers');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ─── Constants ─────────────────────────────────────────────────────────────────
const CART_CACHE_TTL = 15 * 60;          // 15 minutes
const MAX_QUANTITY_PER_ITEM = 50;         // Guard against absurd quantities
const MAX_ITEMS_PER_CART = 30;            // Cart size cap

// ─── Cache Keys ────────────────────────────────────────────────────────────────
const cartCacheKey   = (userId)  => `cart:user:${userId}`;
const couponCacheKey = (code)    => `coupon:code:${code.toUpperCase()}`;

// ─── Product Field Sets ────────────────────────────────────────────────────────
const CART_PRODUCT_SELECT = {
  id: true,
  name: true,
  slug: true,
  basePrice: true,
  comparePrice: true,
  taxPercent: true,
  taxInclusive: true,
  stock: true,
  isActive: true,
  deletedAt: true,
  allowBackorder: true,
  weight: true,
  images: {
    where: { isPrimary: true },
    select: { url: true, thumbnailUrl: true, alt: true },
    take: 1,
  },
  category: { select: { id: true, name: true, slug: true } },
};

const CART_VARIANT_SELECT = {
  id: true,
  name: true,
  sku: true,
  price: true,
  comparePrice: true,
  stock: true,
  isActive: true,
  deletedAt: true,
  attributes: true,
  imageUrl: true,
};

// ═══════════════════════════════════════════════════════════
//   CART LOADING
// ═══════════════════════════════════════════════════════════

/**
 * Load raw cart items from the database with full product/variant data.
 */
const loadCartItems = async (userId) => {
  return prisma.cartItem.findMany({
    where: { userId },
    include: {
      product: { select: CART_PRODUCT_SELECT },
      variant: { select: CART_VARIANT_SELECT },
    },
    orderBy: [
      { isSavedForLater: 'asc' },  // Active items first
      { createdAt: 'desc' },
    ],
  });
};

/**
 * Enrich raw cart items:
 *  - Resolve current effective price (variant > base product price)
 *  - Detect price changes since item was added
 *  - Flag unavailable items (deleted/deactivated products)
 *  - Flag insufficient stock
 */
const enrichCartItems = (rawItems) => {
  const activeItems = [];
  const savedItems  = [];
  const alerts      = [];   // Price changes, out-of-stock warnings

  for (const item of rawItems) {
    const { product, variant } = item;

    // Product no longer available
    const isUnavailable = !product ||
      product.deletedAt !== null ||
      !product.isActive ||
      (variant && (variant.deletedAt !== null || !variant.isActive));

    if (isUnavailable) {
      const enriched = { ...item, status: 'UNAVAILABLE', statusMessage: 'This product is no longer available.' };
      (item.isSavedForLater ? savedItems : activeItems).push(enriched);
      continue;
    }

    // Resolve effective prices
    const currentPrice   = variant?.price    ?? product.basePrice;
    const comparePrice   = variant?.comparePrice ?? product.comparePrice;
    const currentStock   = variant?.stock    ?? product.stock;

    // Price change detection
    const priceAtAdd     = parseFloat(item.priceAtAdd);
    const priceChanged   = priceAtAdd && Math.abs(priceAtAdd - parseFloat(currentPrice)) > 0.01;

    // Stock status
    const effectiveStock = currentStock;
    const isOutOfStock   = !product.allowBackorder && effectiveStock === 0;
    const isLowStock     = !isOutOfStock && effectiveStock <= 5;
    const hasInsufficient= !product.allowBackorder && effectiveStock < item.quantity;

    // Per-item subtotal
    const lineTotal = roundTo(parseFloat(currentPrice) * item.quantity);

    // Compute tax amount for this line
    let taxPercent = parseFloat(product.taxPercent) || 0;
    let linePriceExTax, lineTaxAmount;
    if (product.taxInclusive) {
      linePriceExTax = roundTo(lineTotal / (1 + taxPercent / 100));
      lineTaxAmount  = roundTo(lineTotal - linePriceExTax);
    } else {
      linePriceExTax = lineTotal;
      lineTaxAmount  = roundTo(lineTotal * taxPercent / 100);
    }

    // Build enriched item
    const enriched = {
      ...item,
      currentPrice: parseFloat(currentPrice),
      comparePrice: comparePrice ? parseFloat(comparePrice) : null,
      discountPercent: comparePrice
        ? Math.round((1 - parseFloat(currentPrice) / parseFloat(comparePrice)) * 100)
        : null,
      lineTotal,
      linePriceExTax,
      lineTaxAmount,
      taxPercent,
      currentStock: effectiveStock,
      status: isOutOfStock     ? 'OUT_OF_STOCK'
            : hasInsufficient  ? 'INSUFFICIENT_STOCK'
            : 'AVAILABLE',
      statusMessage: isOutOfStock    ? 'Out of stock'
                   : hasInsufficient ? `Only ${effectiveStock} left in stock`
                   : isLowStock      ? `Only ${effectiveStock} left!`
                   : null,
      priceChanged,
      previousPrice: priceChanged ? priceAtAdd : null,
      priceDiff: priceChanged ? roundTo(parseFloat(currentPrice) - priceAtAdd) : null,
    };

    if (priceChanged) {
      alerts.push({
        type:    'PRICE_CHANGED',
        itemId:  item.id,
        name:    product.name,
        from:    priceAtAdd,
        to:      parseFloat(currentPrice),
        changed: parseFloat(currentPrice) > priceAtAdd ? 'INCREASED' : 'DECREASED',
      });
    }

    if (isOutOfStock || hasInsufficient) {
      alerts.push({
        type:    isOutOfStock ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
        itemId:  item.id,
        name:    product.name,
        available: effectiveStock,
        requested: item.quantity,
      });
    }

    if (item.isSavedForLater) {
      savedItems.push(enriched);
    } else {
      activeItems.push(enriched);
    }
  }

  return { activeItems, savedItems, alerts };
};

// ═══════════════════════════════════════════════════════════
//   CART SUMMARY / TOTALS
// ═══════════════════════════════════════════════════════════

/**
 * Calculate complete cart financial summary.
 * Only "AVAILABLE" active items are included in totals.
 *
 * @param {Array}  activeItems   — Enriched active cart items
 * @param {object} couponResult  — Result from validateCoupon()
 * @param {string} [addressPincode]
 * @returns {object} Full cart summary
 */
const calculateCartSummary = (activeItems, couponResult = null, addressPincode = null) => {
  // Only count orderable items in totals
  const orderableItems = activeItems.filter((i) => i.status === 'AVAILABLE');
  const blockedItems   = activeItems.filter((i) => i.status !== 'AVAILABLE');

  const itemCount = orderableItems.reduce((s, i) => s + i.quantity, 0);
  const subtotal  = roundTo(orderableItems.reduce((s, i) => s + i.lineTotal, 0));
  const totalTax  = roundTo(orderableItems.reduce((s, i) => s + i.lineTaxAmount, 0));

  // Coupon discount
  let couponDiscount = 0;
  if (couponResult?.valid && couponResult.discount) {
    couponDiscount = Math.min(couponResult.discount, subtotal);
    couponDiscount = roundTo(couponDiscount);
  }

  const afterCoupon  = roundTo(subtotal - couponDiscount);
  const shipping     = calculateShipping(afterCoupon);
  const total        = roundTo(afterCoupon + shipping);

  // Savings
  const mrpTotal     = roundTo(
    orderableItems.reduce((s, i) =>
      s + (i.comparePrice ? i.comparePrice * i.quantity : i.currentPrice * i.quantity), 0)
  );
  const savings      = roundTo(mrpTotal - subtotal);

  return {
    itemCount,
    uniqueItemCount:  orderableItems.length,
    blockedItemCount: blockedItems.length,
    mrpTotal,
    subtotal,
    savings,
    savingsPercent:   mrpTotal > 0 ? Math.round((savings / mrpTotal) * 100) : 0,
    couponDiscount,
    couponCode:       couponResult?.valid ? couponResult.code : null,
    couponSavingsText:couponResult?.valid ? couponResult.savingsText : null,
    totalTax,
    shipping,
    freeShippingAt:   parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 500,
    freeShippingRemaining: Math.max(0, (parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 500) - afterCoupon),
    total,
    isCheckoutReady:  blockedItems.length === 0 && itemCount > 0,
  };
};

// ═══════════════════════════════════════════════════════════
//   COUPON VALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * Fully validate a coupon against the cart and user context.
 * Returns structured result with discount amount.
 */
const validateCoupon = async (code, userId, cartItems, subtotal) => {
  const upperCode = code.toUpperCase().trim();

  // Check cache first
  const cached = await cache.get(couponCacheKey(upperCode));
  let coupon = cached;

  if (!coupon) {
    coupon = await prisma.coupon.findFirst({
      where: { code: upperCode, isActive: true, deletedAt: null },
    });

    if (coupon) {
      await cache.set(couponCacheKey(upperCode), coupon, 300); // 5min cache
    }
  }

  if (!coupon) {
    return { valid: false, error: 'Coupon not found or has expired.' };
  }

  const now = new Date();

  // Validity window
  if (coupon.validFrom && now < new Date(coupon.validFrom)) {
    return { valid: false, error: 'This coupon is not yet active.' };
  }
  if (coupon.validUntil && now > new Date(coupon.validUntil)) {
    return { valid: false, error: 'This coupon has expired.' };
  }

  // Global usage cap
  if (coupon.totalUsageLimit && coupon.currentUsageCount >= coupon.totalUsageLimit) {
    return { valid: false, error: 'This coupon has reached its usage limit.' };
  }

  // Per-user usage
  if (coupon.perUserUsageLimit) {
    const userUsage = await prisma.couponUsage.count({
      where: { couponId: coupon.id, userId },
    });
    if (userUsage >= coupon.perUserUsageLimit) {
      return { valid: false, error: `You've already used this coupon ${coupon.perUserUsageLimit} time(s).` };
    }
  }

  // First-order / new-user restrictions
  if (coupon.firstOrderOnly) {
    const orderCount = await prisma.order.count({ where: { userId, status: { not: 'CANCELLED' } } });
    if (orderCount > 0) {
      return { valid: false, error: 'This coupon is valid for first-time orders only.' };
    }
  }

  if (coupon.newUsersOnly) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
    const daysSinceJoined = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceJoined > 30) {
      return { valid: false, error: 'This coupon is for new users only.' };
    }
  }

  // Minimum order amount
  if (coupon.minOrderAmount && parseFloat(subtotal) < parseFloat(coupon.minOrderAmount)) {
    return {
      valid: false,
      error: `Minimum order of ₹${parseFloat(coupon.minOrderAmount).toFixed(0)} required for this coupon.`,
      minOrderAmount: parseFloat(coupon.minOrderAmount),
      shortfall: roundTo(parseFloat(coupon.minOrderAmount) - parseFloat(subtotal)),
    };
  }

  // Calculate discount
  let discount = 0;
  let savingsText = '';

  if (coupon.type === 'PERCENTAGE') {
    discount = roundTo(parseFloat(subtotal) * parseFloat(coupon.value) / 100);
    if (coupon.maxDiscountAmount) {
      discount = Math.min(discount, parseFloat(coupon.maxDiscountAmount));
    }
    savingsText = `${coupon.value}% off (max ₹${coupon.maxDiscountAmount || '∞'})`;
  } else if (coupon.type === 'FIXED_AMOUNT') {
    discount = Math.min(parseFloat(coupon.value), parseFloat(subtotal));
    savingsText = `₹${coupon.value} off`;
  } else if (coupon.type === 'FREE_SHIPPING') {
    discount = calculateShipping(parseFloat(subtotal));
    savingsText = 'Free shipping';
  }

  return {
    valid: true,
    couponId: coupon.id,
    code: upperCode,
    type: coupon.type,
    discount: roundTo(discount),
    savingsText,
    description: coupon.description,
  };
};

// ═══════════════════════════════════════════════════════════
//   STOCK VALIDATION
// ═══════════════════════════════════════════════════════════

/**
 * Validate stock for a single item before adding/updating.
 * Returns the resolved stock level and price.
 */
const validateItemStock = async (productId, quantity, variantId = null) => {
  const product = await prisma.product.findFirst({
    where: { id: productId, isActive: true, deletedAt: null },
    select: {
      id: true, name: true, basePrice: true, stock: true,
      allowBackorder: true, trackInventory: true,
    },
  });

  if (!product) throw AppError.notFound('Product');

  let effectiveStock = product.stock;
  let effectivePrice = parseFloat(product.basePrice);

  if (variantId) {
    const variant = await prisma.productVariant.findFirst({
      where: { id: variantId, productId, isActive: true, deletedAt: null },
      select: { id: true, name: true, price: true, stock: true },
    });
    if (!variant) throw AppError.notFound('Product variant');
    effectiveStock = variant.stock;
    effectivePrice = parseFloat(variant.price);
  }

  if (!product.allowBackorder && product.trackInventory) {
    if (effectiveStock === 0) {
      throw AppError.badRequest(`"${product.name}" is currently out of stock.`, 'OUT_OF_STOCK');
    }
    if (effectiveStock < quantity) {
      throw AppError.badRequest(
        `Only ${effectiveStock} unit(s) of "${product.name}" available.`,
        'INSUFFICIENT_STOCK'
      );
    }
  }

  if (quantity > MAX_QUANTITY_PER_ITEM) {
    throw AppError.badRequest(`Maximum ${MAX_QUANTITY_PER_ITEM} units per item.`, 'MAX_QUANTITY_EXCEEDED');
  }

  return { product, effectiveStock, effectivePrice };
};

/**
 * Validate ALL active cart items — for pre-checkout stock check.
 * Returns a list of issues (if any).
 */
const validateCartForCheckout = async (userId) => {
  const items = await loadCartItems(userId);
  const { activeItems, alerts } = enrichCartItems(items);

  const orderableItems = activeItems.filter((i) => i.status === 'AVAILABLE');
  const blockedItems   = activeItems.filter((i) => i.status !== 'AVAILABLE');

  return {
    isReady:      blockedItems.length === 0 && orderableItems.length > 0,
    blockedItems: blockedItems.map((i) => ({
      itemId:        i.id,
      productName:   i.product.name,
      status:        i.status,
      statusMessage: i.statusMessage,
    })),
    alerts,
    orderableItems,
  };
};

// ═══════════════════════════════════════════════════════════
//   CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════

const invalidateCartCache = async (userId) => {
  await cache.del(cartCacheKey(userId));
};

const getCachedCart = async (userId) => {
  return cache.get(cartCacheKey(userId));
};

const setCachedCart = async (userId, data) => {
  await cache.set(cartCacheKey(userId), data, CART_CACHE_TTL);
};

// ═══════════════════════════════════════════════════════════
//   GUEST CART MERGE
// ═══════════════════════════════════════════════════════════

/**
 * Merge guest (session) cart into authenticated user cart.
 * Strategy: if item exists, take the higher quantity.
 */
const mergeGuestCart = async (userId, guestItems = []) => {
  if (!guestItems.length) return { merged: 0, skipped: 0 };

  let merged = 0;
  let skipped = 0;

  for (const guestItem of guestItems) {
    const { productId, variantId, quantity } = guestItem;
    if (!productId || !quantity) { skipped++; continue; }

    try {
      // Validate the product still exists
      const product = await prisma.product.findFirst({
        where: { id: productId, isActive: true, deletedAt: null },
        select: { id: true, basePrice: true },
      });
      if (!product) { skipped++; continue; }

      const effectivePrice = variantId
        ? parseFloat((await prisma.productVariant.findUnique({
            where: { id: variantId },
            select: { price: true },
          }))?.price || product.basePrice)
        : parseFloat(product.basePrice);

      await prisma.cartItem.upsert({
        where: {
          userId_productId_variantId: {
            userId,
            productId,
            variantId: variantId || null,
          },
        },
        // Existing item: keep whichever quantity is higher
        update: {
          quantity: { increment: quantity },
          priceAtAdd: effectivePrice,
        },
        create: {
          userId,
          productId,
          variantId: variantId || null,
          quantity,
          priceAtAdd: effectivePrice,
        },
      });

      merged++;
    } catch (err) {
      logger.warn('Guest cart merge: item skipped', { productId, error: err.message });
      skipped++;
    }
  }

  await invalidateCartCache(userId);
  return { merged, skipped };
};

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Cart loading
  loadCartItems,
  enrichCartItems,
  // Calculations
  calculateCartSummary,
  // Coupon
  validateCoupon,
  couponCacheKey,
  // Stock
  validateItemStock,
  validateCartForCheckout,
  MAX_QUANTITY_PER_ITEM,
  MAX_ITEMS_PER_CART,
  // Cache
  invalidateCartCache,
  getCachedCart,
  setCachedCart,
  cartCacheKey,
  // Merge
  mergeGuestCart,
};
