/**
 * controllers/order.controller.js  [ENTERPRISE EDITION]
 * ========================================================
 * Customer-facing order management.
 *
 * POST   /orders                   — Place order from cart
 * GET    /orders                   — My order history (paginated)
 * GET    /orders/:id               — Order detail
 * GET    /orders/:id/track         — Tracking timeline
 * GET    /orders/:id/invoice       — Download invoice HTML
 * PATCH  /orders/:id/cancel        — Cancel order
 * POST   /orders/:id/return        — Request return
 * POST   /orders/:id/refund        — Request refund
 */

'use strict';

const { prisma }         = require('../config/database');
const { withTransaction }= require('../config/database');
const { cache, CACHE_KEYS } = require('../config/redis');
const { ApiResponse }    = require('../utils/ApiResponse');
const AppError           = require('../utils/AppError');
const logger             = require('../utils/logger');

const {
  generateOrderNumber,
  calculateOrderTotals,
  createAddressSnapshot,
  deductStockForOrder,
  restoreStockForOrder,
  recordCouponUsage,
  invalidateOrderCache,
  buildInvoiceData,
  renderInvoiceHtml,
  CUSTOMER_CANCELLABLE,
} = require('../services/order.service');

const { validateCoupon } = require('../services/cart.service');

// ─── Field sets ───────────────────────────────────────────────────────────────
const ORDER_LIST_INCLUDE = {
  items: {
    take: 3,
    select: {
      id: true, productName: true, variantName: true,
      quantity: true, unitPrice: true, total: true, imageUrl: true,
    },
  },
  _count: { select: { items: true } },
};

const ORDER_DETAIL_INCLUDE = {
  items: {
    select: {
      id: true, productId: true, variantId: true,
      productName: true, variantName: true, productSku: true,
      imageUrl: true, unitPrice: true, comparePrice: true,
      taxPercent: true, quantity: true, subtotal: true,
      discountAmount: true, total: true,
      product: { select: { slug: true } },
    },
  },
  address: true,
  payments: {
    orderBy: { createdAt: 'desc' },
    take: 5,
  },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  tracking: true,
  coupon: { select: { code: true, type: true } },
};

// ─── Pagination helper ─────────────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(50,  Math.max(1, parseInt(query.limit) || 10));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ═══════════════════════════════════════════════════════════
//   CREATE ORDER
// ═══════════════════════════════════════════════════════════

exports.createOrder = async (req, res) => {
  const { addressId, paymentMethod, couponCode, customerNotes } = req.body;
  const userId = req.user.id;

  const order = await withTransaction(async (tx) => {

    // ── 1. Load cart items (active only) ───────────────────────
    const cartItems = await tx.cartItem.findMany({
      where: { userId, isSavedForLater: false },
      include: {
        product: {
          select: {
            id: true, name: true, slug: true, sku: true, basePrice: true,
            comparePrice: true, taxPercent: true, taxInclusive: true,
            isActive: true, deletedAt: true, stock: true, allowBackorder: true,
            images: { where: { isPrimary: true }, select: { url: true }, take: 1 },
          },
        },
        variant: {
          select: {
            id: true, name: true, sku: true, price: true,
            comparePrice: true, stock: true, isActive: true, deletedAt: true,
          },
        },
      },
    });

    if (cartItems.length === 0) {
      throw AppError.badRequest('Your cart is empty.');
    }

    // ── 2. Validate all products are still available ───────────
    for (const item of cartItems) {
      if (!item.product.isActive || item.product.deletedAt) {
        throw AppError.badRequest(`"${item.product.name}" is no longer available. Please remove it from your cart.`);
      }
      if (item.variant && (!item.variant.isActive || item.variant.deletedAt)) {
        throw AppError.badRequest(`A selected variant of "${item.product.name}" is unavailable. Please update your cart.`);
      }
    }

    // ── 3. Validate and load address ───────────────────────────
    let address = null;
    if (addressId) {
      address = await tx.address.findFirst({
        where: { id: addressId, userId, deletedAt: null },
      });
      if (!address) {
        throw AppError.badRequest('Invalid delivery address. Please select a valid address.');
      }
    } else if (paymentMethod !== 'CASH_ON_DELIVERY') {
      // Address optional only for COD
      const defaultAddress = await tx.address.findFirst({
        where: { userId, isDefault: true, deletedAt: null },
      });
      if (!defaultAddress) {
        throw AppError.badRequest('Please add a delivery address to your account.');
      }
      address = defaultAddress;
    }

    // ── 4. Validate coupon ─────────────────────────────────────
    let couponResult = null;
    if (couponCode) {
      const rawSubtotal = cartItems.reduce((s, item) => {
        const price = parseFloat(item.variant?.price ?? item.product.basePrice);
        return s + price * item.quantity;
      }, 0);

      couponResult = await validateCoupon(couponCode, userId, cartItems, rawSubtotal);
      if (!couponResult.valid) {
        throw AppError.badRequest(couponResult.error || 'Invalid coupon code.', 'COUPON_INVALID');
      }
    }

    // ── 5. Calculate totals ────────────────────────────────────
    const totals = calculateOrderTotals(cartItems, couponResult);

    // ── 6. Generate unique order number ───────────────────────
    const orderNumber = await generateOrderNumber();

    // ── 7. Deduct stock (throws on insufficient stock) ────────
    await deductStockForOrder(tx, cartItems);

    // ── 8. Create order ────────────────────────────────────────
    const newOrder = await tx.order.create({
      data: {
        orderNumber,
        userId,
        addressId:      address?.id || null,
        shippingAddress: createAddressSnapshot(address),
        status:          'PENDING',
        paymentStatus:   'PENDING',
        paymentMethod:   paymentMethod || 'UPI',
        subtotal:        totals.subtotal,
        discountAmount:  totals.discountAmount,
        couponDiscount:  totals.couponDiscount,
        couponId:        totals.couponId,
        couponCode:      totals.couponCode,
        shippingCharge:  totals.shippingCharge,
        taxAmount:       totals.taxAmount,
        total:           totals.total,
        customerNotes:   customerNotes || null,
        placedAt:        new Date(),
        items: {
          create: totals.orderItems,
        },
        statusHistory: {
          create: {
            toStatus: 'PENDING',
            note:     'Order placed successfully',
            changedBy: userId,
          },
        },
      },
      include: {
        items: true,
        address: true,
      },
    });

    // ── 9. Record coupon usage ─────────────────────────────────
    if (totals.couponId) {
      await recordCouponUsage(tx, totals.couponId, userId, newOrder.id);
    }

    // ── 10. Clear cart ─────────────────────────────────────────
    await tx.cartItem.deleteMany({
      where: { userId, isSavedForLater: false },
    });

    return newOrder;
  });

  // ── 11. Post-order actions (non-blocking) ─────────────────────
  setImmediate(async () => {
    try {
      await cache.del(CACHE_KEYS.userCart(userId));
      await invalidateOrderCache(userId);

      // Remove applied coupon from session
      await cache.del(`cart:coupon:${userId}`);

      // Notifications (if services exist)
      try {
        const notifService = require('../services/notification.service');
        await notifService.createNotification({
          userId,
          type:    'ORDER_PLACED',
          title:   'Order Placed! 🎉',
          message: `Your order #${order.orderNumber} has been placed. We'll verify your payment and confirm shortly.`,
          data:    { orderId: order.id, orderNumber: order.orderNumber },
        });
      } catch (_) {}

    } catch (err) {
      logger.warn('⚠️ Post-order cache/notification failed:', { error: err.message });
    }
  });

  logger.apiEvent('ORDER_CREATED', {
    userId,
    orderId:     order.id,
    orderNumber: order.orderNumber,
    total:       order.total,
    paymentMethod: order.paymentMethod,
  });

  ApiResponse.created(res, order,
    `Order #${order.orderNumber} placed successfully! 🎉 Total: ₹${parseFloat(order.total).toFixed(2)}`
  );
};

// ═══════════════════════════════════════════════════════════
//   GET MY ORDERS (history)
// ═══════════════════════════════════════════════════════════

exports.getMyOrders = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { status, paymentStatus, from, to } = req.query;
  const userId = req.user.id;

  const where = {
    userId,
    deletedAt: null,
    ...(status        && { status }),
    ...(paymentStatus && { paymentStatus }),
    ...((from || to) && {
      createdAt: {
        ...(from && { gte: new Date(from) }),
        ...(to   && { lte: new Date(to)   }),
      },
    }),
  };

  const cacheKey = `orders:user:${userId}:page:${page}:${status||'all'}`;
  const cached = await cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, ...cached, cached: true });
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: ORDER_LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  const pagination = {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  };

  const response = { data: orders, pagination };
  await cache.set(cacheKey, response, 120); // 2min

  ApiResponse.paginated(res, orders, pagination, `${total} order(s) found.`);
};

// ═══════════════════════════════════════════════════════════
//   GET ORDER BY ID (full detail)
// ═══════════════════════════════════════════════════════════

exports.getOrderById = async (req, res) => {
  const { id } = req.params;
  const userId = req.user.id;

  const cacheKey = `order:${id}`;
  const cached = await cache.get(cacheKey);
  if (cached && cached.userId === userId) {
    return ApiResponse.success(res, cached);
  }

  const order = await prisma.order.findFirst({
    where: { id, userId, deletedAt: null },
    include: ORDER_DETAIL_INCLUDE,
  });

  if (!order) throw AppError.notFound('Order');

  await cache.set(cacheKey, order, 300); // 5min
  ApiResponse.success(res, order);
};

// ═══════════════════════════════════════════════════════════
//   TRACK ORDER
// ═══════════════════════════════════════════════════════════

exports.trackOrder = async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user.id, deletedAt: null },
    select: {
      id: true, orderNumber: true, status: true,
      paymentStatus: true, paymentMethod: true,
      trackingNumber: true, courierName: true,
      estimatedDelivery: true, deliveredAt: true,
      placedAt: true, shippedAt: true, paidAt: true,
      statusHistory: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, fromStatus: true, toStatus: true,
          note: true, createdAt: true,
        },
      },
      tracking: {
        select: {
          id: true, trackingNumber: true, courierName: true,
          trackingUrl: true, status: true, estimatedDelivery: true,
          events: { orderBy: { occurredAt: 'desc' } },
        },
      },
    },
  });

  if (!order) throw AppError.notFound('Order');

  // Build a timeline with well-defined steps
  const STEPS = [
    { status: 'PENDING',           label: 'Order Placed',        icon: '📦' },
    { status: 'PAYMENT_PENDING',   label: 'Awaiting Payment',    icon: '💳' },
    { status: 'SCREENSHOT_UPLOADED',label:'Payment Submitted',   icon: '🖼️' },
    { status: 'PAYMENT_VERIFIED',  label: 'Payment Verified',    icon: '✅' },
    { status: 'CONFIRMED',         label: 'Order Confirmed',      icon: '🎉' },
    { status: 'PROCESSING',        label: 'Preparing',           icon: '👩‍🍳' },
    { status: 'PACKED',            label: 'Packed',              icon: '📫' },
    { status: 'SHIPPED',           label: 'Shipped',             icon: '🚚' },
    { status: 'OUT_FOR_DELIVERY',  label: 'Out for Delivery',    icon: '🏍️' },
    { status: 'DELIVERED',         label: 'Delivered',           icon: '🏠' },
  ];

  const completedStatuses = new Set(order.statusHistory.map((h) => h.toStatus));
  const timeline = STEPS.map((step) => {
    const historyEntry = order.statusHistory.find((h) => h.toStatus === step.status);
    return {
      ...step,
      completed: completedStatuses.has(step.status),
      current: order.status === step.status,
      timestamp: historyEntry?.createdAt || null,
      note: historyEntry?.note || null,
    };
  });

  const tracking = order.tracking ? {
    id: order.tracking.id,
    trackingNumber: order.tracking.trackingNumber,
    courierName: order.tracking.courierName,
    courierUrl: order.tracking.trackingUrl, // map trackingUrl to courierUrl
    status: order.tracking.status,
    estimatedDelivery: order.tracking.estimatedDelivery,
    events: order.tracking.events
  } : null;

  ApiResponse.success(res, { ...order, tracking, timeline }, 'Order tracking info.');
};

// ═══════════════════════════════════════════════════════════
//   CANCEL ORDER
// ═══════════════════════════════════════════════════════════

exports.cancelOrder = async (req, res) => {
  const { reason } = req.body;
  const { id } = req.params;
  const userId = req.user.id;

  const order = await prisma.order.findFirst({
    where: { id, userId, deletedAt: null },
    include: { items: true },
  });

  if (!order) throw AppError.notFound('Order');

  if (!CUSTOMER_CANCELLABLE.includes(order.status)) {
    throw AppError.badRequest(
      `Cannot cancel an order in "${order.status}" status. Contact support for help.`,
      'CANNOT_CANCEL'
    );
  }

  await withTransaction(async (tx) => {
    // Update order
    await tx.order.update({
      where: { id },
      data: {
        status:             'CANCELLED',
        cancellationReason: reason || 'Cancelled by customer',
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus:   'CANCELLED',
            note:       reason || 'Cancelled by customer',
            changedBy:  userId,
          },
        },
      },
    });

    // Restore stock
    await restoreStockForOrder(tx, order.items);

    // Restore coupon usage if coupon was applied
    if (order.couponId) {
      await tx.coupon.update({
        where: { id: order.couponId },
        data: { currentUsageCount: { decrement: 1 } },
      });
      await tx.couponUsage.deleteMany({
        where: { couponId: order.couponId, orderId: id },
      });
    }
  });

  await invalidateOrderCache(userId, id);

  // Notify (non-blocking)
  setImmediate(async () => {
    try {
      const notifService = require('../services/notification.service');
      await notifService.createNotification({
        userId,
        type:    'ORDER_CANCELLED',
        title:   'Order Cancelled',
        message: `Your order #${order.orderNumber} has been cancelled. If you paid, a refund will be processed.`,
        data:    { orderId: id },
      });
    } catch (_) {}
  });

  logger.apiEvent('ORDER_CANCELLED', { userId, orderId: id, orderNumber: order.orderNumber, reason });
  ApiResponse.success(res, null, `Order #${order.orderNumber} cancelled successfully.`);
};

// ═══════════════════════════════════════════════════════════
//   REQUEST RETURN
// ═══════════════════════════════════════════════════════════

exports.requestReturn = async (req, res) => {
  const { reason, itemIds } = req.body;
  const { id } = req.params;
  const userId = req.user.id;

  const order = await prisma.order.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true, status: true, orderNumber: true, deliveredAt: true },
  });

  if (!order) throw AppError.notFound('Order');

  if (order.status !== 'DELIVERED') {
    throw AppError.badRequest('Only delivered orders can be returned.', 'CANNOT_RETURN');
  }

  // Check return window (7 days)
  const returnWindowDays = parseInt(process.env.RETURN_WINDOW_DAYS) || 7;
  if (order.deliveredAt) {
    const daysSinceDelivery = (Date.now() - new Date(order.deliveredAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceDelivery > returnWindowDays) {
      throw AppError.badRequest(
        `Return window of ${returnWindowDays} days has expired. Delivered on ${new Date(order.deliveredAt).toLocaleDateString('en-IN')}.`,
        'RETURN_WINDOW_EXPIRED'
      );
    }
  }

  await prisma.order.update({
    where: { id },
    data: {
      status: 'RETURNED',
      statusHistory: {
        create: {
          fromStatus: 'DELIVERED',
          toStatus:   'RETURNED',
          note:       reason || 'Return requested by customer',
          changedBy:  userId,
        },
      },
    },
  });

  await invalidateOrderCache(userId, id);
  ApiResponse.success(res, null, `Return requested for order #${order.orderNumber}. Our team will reach out within 24 hours.`);
};

// ═══════════════════════════════════════════════════════════
//   REQUEST REFUND
// ═══════════════════════════════════════════════════════════

exports.requestRefund = async (req, res) => {
  const { reason, bankAccount } = req.body;
  const { id } = req.params;
  const userId = req.user.id;

  const order = await prisma.order.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true, status: true, orderNumber: true, total: true, paymentStatus: true },
  });

  if (!order) throw AppError.notFound('Order');

  const refundableStatuses = ['DELIVERED', 'RETURNED', 'CANCELLED'];
  if (!refundableStatuses.includes(order.status)) {
    throw AppError.badRequest('This order is not eligible for a refund.', 'NOT_REFUNDABLE');
  }

  if (order.paymentStatus === 'REFUNDED') {
    throw AppError.badRequest('A refund has already been processed for this order.', 'ALREADY_REFUNDED');
  }

  await prisma.order.update({
    where: { id },
    data: {
      status:        'REFUND_REQUESTED',
      paymentStatus: 'REFUND_PENDING',
      adminNotes:    `Refund requested. Reason: ${reason || 'Not specified'}. Bank: ${bankAccount || 'Not provided'}`,
      statusHistory: {
        create: {
          fromStatus: order.status,
          toStatus:   'REFUND_REQUESTED',
          note:       `Refund requested: ${reason || 'No reason provided'}`,
          changedBy:  userId,
        },
      },
    },
  });

  await invalidateOrderCache(userId, id);
  ApiResponse.success(res, null, `Refund of ₹${parseFloat(order.total).toFixed(2)} requested for order #${order.orderNumber}. Allow 5-7 business days.`);
};

// ═══════════════════════════════════════════════════════════
//   INVOICE DOWNLOAD
// ═══════════════════════════════════════════════════════════

exports.downloadInvoice = async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, userId: req.user.id, deletedAt: null },
    include: {
      items: true,
      address: true,
      user: { select: { name: true, email: true, phone: true } },
    },
  });

  if (!order) throw AppError.notFound('Order');

  // Only allow invoice for confirmed/paid orders
  const invoiceAllowedStatuses = [
    'PAYMENT_VERIFIED', 'CONFIRMED', 'PROCESSING',
    'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED',
  ];

  if (!invoiceAllowedStatuses.includes(order.status)) {
    throw AppError.badRequest(
      'Invoice is only available after payment is verified.',
      'INVOICE_NOT_AVAILABLE'
    );
  }

  const invoiceData = buildInvoiceData(order, order.user);
  const html = renderInvoiceHtml(invoiceData);

  // Return as HTML for browser print, or set Content-Disposition for download
  const download = req.query.download === 'true';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (download) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Invoice-${order.orderNumber}.html"`
    );
  }

  res.send(html);
};

// ═══════════════════════════════════════════════════════════
//   ORDER SUMMARY (dashboard widget)
// ═══════════════════════════════════════════════════════════

exports.getOrderSummary = async (req, res) => {
  const userId = req.user.id;

  const [stats, recentOrders] = await Promise.all([
    prisma.order.groupBy({
      by: ['status'],
      where: { userId, deletedAt: null },
      _count: { id: true },
    }),
    prisma.order.findMany({
      where: { userId, deletedAt: null },
      include: ORDER_LIST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 3,
    }),
  ]);

  const statusMap = stats.reduce((acc, s) => {
    acc[s.status] = s._count.id;
    return acc;
  }, {});

  ApiResponse.success(res, {
    counts: {
      total:      Object.values(statusMap).reduce((a, b) => a + b, 0),
      pending:    statusMap['PENDING'] || 0,
      confirmed:  statusMap['CONFIRMED'] || 0,
      shipped:    statusMap['SHIPPED'] || 0,
      delivered:  statusMap['DELIVERED'] || 0,
      cancelled:  statusMap['CANCELLED'] || 0,
    },
    recentOrders,
  }, 'Order summary.');
};
