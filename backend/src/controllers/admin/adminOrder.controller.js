/**
 * controllers/admin/adminOrder.controller.js  [ENTERPRISE EDITION]
 * ==================================================================
 * Admin order management — full control over the order lifecycle.
 *
 * GET    /admin/orders                    — All orders (filterable)
 * GET    /admin/orders/:id                — Full order detail
 * PATCH  /admin/orders/:id/status         — Update order status
 * PATCH  /admin/orders/:id/payment        — Verify / reject payment screenshot
 * PATCH  /admin/orders/:id/ship           — Add tracking info + mark shipped
 * PATCH  /admin/orders/:id/deliver        — Mark as delivered
 * PATCH  /admin/orders/:id/cancel         — Force cancel any order
 * PATCH  /admin/orders/:id/refund         — Process refund
 * PATCH  /admin/orders/:id/notes          — Add internal admin notes
 * GET    /admin/orders/analytics          — Order dashboard stats
 * GET    /admin/orders/pending-payment    — UPI screenshot review queue
 * GET    /admin/orders/low-stock-alerts   — Items triggering stock alerts
 */

'use strict';

const { prisma }         = require('../../config/database');
const { withTransaction }= require('../../config/database');
const { cache }          = require('../../config/redis');
const { ApiResponse }    = require('../../utils/ApiResponse');
const AppError           = require('../../utils/AppError');
const logger             = require('../../utils/logger');

const {
  validateStatusTransition,
  restoreStockForOrder,
  invalidateOrderCache,
  buildInvoiceData,
  renderInvoiceHtml,
} = require('../../services/order.service');

// ─── Full admin order detail ───────────────────────────────────────────────────
const ADMIN_ORDER_INCLUDE = {
  user: {
    select: {
      id: true, name: true, email: true, phone: true,
      avatar: true, createdAt: true,
      _count: { select: { orders: true } },
    },
  },
  items: {
    select: {
      id: true, productId: true, variantId: true,
      productName: true, variantName: true, productSku: true,
      imageUrl: true, unitPrice: true, comparePrice: true,
      taxPercent: true, quantity: true, subtotal: true,
      discountAmount: true, total: true, returnedQuantity: true, refundedAmount: true,
      product: { select: { slug: true, stock: true } },
    },
  },
  address: true,
  payments: {
    orderBy: { createdAt: 'desc' },
    include: { screenshots: { orderBy: { createdAt: 'desc' } } },
  },
  statusHistory: { orderBy: { createdAt: 'asc' } },
  tracking: true,
  coupon: { select: { id: true, code: true, type: true, value: true } },
};

// ─── Pagination helper ─────────────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
};

// ═══════════════════════════════════════════════════════════
//   LIST ALL ORDERS (admin view)
// ═══════════════════════════════════════════════════════════

exports.listOrders = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const {
    status, paymentStatus, paymentMethod,
    userId, from, to, q,
    sortBy = 'createdAt', sortDir = 'desc',
  } = req.query;

  const where = {
    deletedAt: null,
    ...(status        && { status }),
    ...(paymentStatus && { paymentStatus }),
    ...(paymentMethod && { paymentMethod }),
    ...(userId        && { userId }),
    ...((from || to) && {
      createdAt: {
        ...(from && { gte: new Date(from) }),
        ...(to   && { lte: new Date(to)   }),
      },
    }),
    ...(q && {
      OR: [
        { orderNumber:  { contains: q, mode: 'insensitive' } },
        { user: { name:  { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q, mode: 'insensitive' } } },
      ],
    }),
  };

  const allowedSort = ['createdAt', 'total', 'status', 'updatedAt'];
  const orderBy = { [allowedSort.includes(sortBy) ? sortBy : 'createdAt']: sortDir === 'asc' ? 'asc' : 'desc' };

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        items: {
          take: 2,
          select: { productName: true, quantity: true, unitPrice: true, imageUrl: true },
        },
        _count: { select: { items: true } },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);

  ApiResponse.paginated(res, orders, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  }, `${total} order(s) found.`);
};

// ═══════════════════════════════════════════════════════════
//   GET ONE ORDER (full admin detail)
// ═══════════════════════════════════════════════════════════

exports.getOrder = async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id },
    include: ADMIN_ORDER_INCLUDE,
  });

  if (!order) throw AppError.notFound('Order');
  ApiResponse.success(res, order);
};

// ═══════════════════════════════════════════════════════════
//   UPDATE ORDER STATUS
// ═══════════════════════════════════════════════════════════

exports.updateOrderStatus = async (req, res) => {
  const { status, note, force = false } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id },
    select: { id: true, status: true, orderNumber: true, userId: true },
  });

  if (!order) throw AppError.notFound('Order');

  // Validate transition (admin can force override)
  validateStatusTransition(order.status, status, true);

  // Build extra data fields for specific transitions
  const extraData = {};
  if (status === 'CONFIRMED')   extraData.placedAt   = new Date();
  if (status === 'DELIVERED')   extraData.deliveredAt= new Date();
  if (status === 'SHIPPED')     extraData.shippedAt  = new Date();

  const updated = await prisma.order.update({
    where: { id },
    data: {
      status,
      ...extraData,
      statusHistory: {
        create: {
          fromStatus: order.status,
          toStatus:   status,
          note:       note || `Status updated to ${status}`,
          changedBy:  req.user.id,
        },
      },
    },
    include: { statusHistory: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  await invalidateOrderCache(order.userId, id);

  // Notify customer (non-blocking)
  const statusMessages = {
    CONFIRMED:       `Your order #${order.orderNumber} is confirmed! We're preparing it for you.`,
    PROCESSING:      `Your order #${order.orderNumber} is being prepared by our kitchen.`,
    PACKED:          `Your order #${order.orderNumber} is packed and ready to ship!`,
    SHIPPED:         `Your order #${order.orderNumber} has been shipped! Track it in the app.`,
    OUT_FOR_DELIVERY:`Your order #${order.orderNumber} is out for delivery today!`,
    DELIVERED:       `Your order #${order.orderNumber} has been delivered! Enjoy your snacks 🎉`,
    CANCELLED:       `Your order #${order.orderNumber} has been cancelled.`,
  };

  if (statusMessages[status]) {
    setImmediate(async () => {
      try {
        const notifService = require('../../services/notification.service');
        await notifService.createNotification({
          userId:  order.userId,
          type:    `ORDER_${status}`,
          title:   `Order ${status.replace('_', ' ')}`,
          message: statusMessages[status],
          data:    { orderId: id, orderNumber: order.orderNumber },
        });
      } catch (_) {}
    });
  }

  logger.apiEvent('ADMIN_ORDER_STATUS_UPDATED', {
    adminId: req.user.id,
    orderId: id,
    from:    order.status,
    to:      status,
    force,
  });

  ApiResponse.success(res, updated, `Order status updated to "${status}".`);
};

// ═══════════════════════════════════════════════════════════
//   VERIFY / REJECT PAYMENT SCREENSHOT
// ═══════════════════════════════════════════════════════════

exports.verifyPayment = async (req, res) => {
  const { action, note, rejectionReason } = req.body; // action: "APPROVE" | "REJECT"
  const { id } = req.params;

  if (!['APPROVE', 'REJECT'].includes(action)) {
    throw AppError.badRequest('action must be "APPROVE" or "REJECT".');
  }

  const order = await prisma.order.findFirst({
    where: { id },
    select: {
      id: true, status: true, orderNumber: true, userId: true,
      paymentStatus: true,
    },
  });

  if (!order) throw AppError.notFound('Order');

  if (!['PENDING', 'SCREENSHOT_UPLOADED', 'PAYMENT_PENDING'].includes(order.status)) {
    throw AppError.badRequest(
      `Payment verification applies to orders awaiting payment. Current status: ${order.status}.`
    );
  }

  const isApproved = action === 'APPROVE';
  const newStatus  = isApproved ? 'PROCESSING' : 'PAYMENT_REJECTED'; // APPROVE → jump straight to Preparing
  const newPaymentStatus = isApproved ? 'VERIFIED' : 'REJECTED';

  await prisma.order.update({
    where: { id },
    data: {
      status:        newStatus,
      paymentStatus: newPaymentStatus,
      paidAt:        isApproved ? new Date() : null,
      statusHistory: {
        create: isApproved
          ? [
              {
                fromStatus: order.status,
                toStatus:   'PAYMENT_VERIFIED',
                note:       note || 'Payment verified by admin',
                changedBy:  req.user.id,
              },
              {
                fromStatus: 'PAYMENT_VERIFIED',
                toStatus:   'PROCESSING',
                note:       'Order automatically moved to Preparing after payment verification',
                changedBy:  req.user.id,
              },
            ]
          : [
              {
                fromStatus: order.status,
                toStatus:   'PAYMENT_REJECTED',
                note:       rejectionReason || 'Payment screenshot rejected',
                changedBy:  req.user.id,
              },
            ],
      },
    },
  });

  // Update the payment record
  await prisma.payment.updateMany({
    where: { orderId: id, status: 'SCREENSHOT_UPLOADED' },
    data: {
      status:  isApproved ? 'VERIFIED' : 'REJECTED',
      verifiedAt: isApproved ? new Date() : null,
      verifiedBy:  req.user.id,
      rejectionReason: isApproved ? null : rejectionReason,
    },
  });

  // Update screenshot status
  await prisma.paymentScreenshot.updateMany({
    where: { orderId: id, status: 'PENDING_REVIEW' },
    data: {
      status:     isApproved ? 'APPROVED' : 'REJECTED',
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
      rejectionReason: isApproved ? null : rejectionReason,
    },
  });

  await invalidateOrderCache(order.userId, id);

  // Notify customer
  setImmediate(async () => {
    try {
      const notifService = require('../../services/notification.service');
      await notifService.createNotification({
        userId:  order.userId,
        type:    isApproved ? 'PAYMENT_VERIFIED' : 'PAYMENT_REJECTED',
        title:   isApproved ? '✅ Payment Verified!' : '❌ Payment Rejected',
        message: isApproved
          ? `Payment for order #${order.orderNumber} verified! We'll confirm your order shortly.`
          : `Payment for order #${order.orderNumber} was rejected. Reason: ${rejectionReason || 'Unclear screenshot'}. Please re-upload.`,
        data: { orderId: id },
      });
    } catch (_) {}
  });

  logger.apiEvent('ADMIN_PAYMENT_VERIFIED', {
    adminId: req.user.id,
    orderId: id,
    action,
    rejectionReason,
  });

  ApiResponse.success(res, null, isApproved
    ? `Payment verified. Order will now be confirmed.`
    : `Payment rejected. Customer notified to re-upload.`
  );
};

// ═══════════════════════════════════════════════════════════
//   SHIP ORDER (add tracking info)
// ═══════════════════════════════════════════════════════════

exports.shipOrder = async (req, res) => {
  const { trackingNumber, courierName, courierUrl, estimatedDelivery, note } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id },
    select: { id: true, status: true, orderNumber: true, userId: true },
  });

  if (!order) throw AppError.notFound('Order');

  if (!['CONFIRMED', 'PROCESSING', 'PACKED'].includes(order.status)) {
    throw AppError.badRequest(`Order must be CONFIRMED, PROCESSING, or PACKED to ship. Current: ${order.status}.`);
  }

  await withTransaction(async (tx) => {
    // Update order
    await tx.order.update({
      where: { id },
      data: {
        status:           'SHIPPED',
        trackingNumber,
        courierName,
        estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
        shippedAt:        new Date(),
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus:   'SHIPPED',
            note:       note || `Shipped via ${courierName}. Tracking: ${trackingNumber}`,
            changedBy:  req.user.id,
          },
        },
      },
    });

    // Create or update shipment record
    await tx.shipment.upsert({
      where:  { orderId: id },
      update: {
        trackingNumber,
        courierName,
        courierUrl:       courierUrl || null,
        status:           'IN_TRANSIT',
        estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
      },
      create: {
        orderId:          id,
        trackingNumber,
        courierName,
        courierUrl:       courierUrl || null,
        status:           'IN_TRANSIT',
        estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
      },
    });
  });

  await invalidateOrderCache(order.userId, id);

  logger.apiEvent('ADMIN_ORDER_SHIPPED', {
    adminId:       req.user.id,
    orderId:       id,
    trackingNumber,
    courierName,
  });

  ApiResponse.success(res, null, `Order #${order.orderNumber} shipped via ${courierName}. Tracking: ${trackingNumber}.`);
};

// ═══════════════════════════════════════════════════════════
//   MARK DELIVERED
// ═══════════════════════════════════════════════════════════

exports.markDelivered = async (req, res) => {
  const { note } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id },
    select: { id: true, status: true, orderNumber: true, userId: true },
  });

  if (!order) throw AppError.notFound('Order');

  if (!['SHIPPED', 'OUT_FOR_DELIVERY'].includes(order.status)) {
    throw AppError.badRequest(`Order must be SHIPPED or OUT_FOR_DELIVERY. Current: ${order.status}.`);
  }

  await prisma.order.update({
    where: { id },
    data: {
      status:      'DELIVERED',
      deliveredAt: new Date(),
      statusHistory: {
        create: {
          fromStatus: order.status,
          toStatus:   'DELIVERED',
          note:       note || 'Delivered to customer',
          changedBy:  req.user.id,
        },
      },
    },
  });

  await prisma.shipment.updateMany({
    where: { orderId: id },
    data: { status: 'DELIVERED', deliveredAt: new Date() },
  });

  await invalidateOrderCache(order.userId, id);
  ApiResponse.success(res, null, `Order #${order.orderNumber} marked as delivered.`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN CANCEL (any status)
// ═══════════════════════════════════════════════════════════

exports.adminCancelOrder = async (req, res) => {
  const { reason, restoreStock: shouldRestoreStock = true } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id },
    include: { items: true },
  });

  if (!order) throw AppError.notFound('Order');

  if (order.status === 'CANCELLED') {
    throw AppError.badRequest('Order is already cancelled.');
  }

  await withTransaction(async (tx) => {
    await tx.order.update({
      where: { id },
      data: {
        status:             'CANCELLED',
        cancellationReason: reason || 'Cancelled by admin',
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus:   'CANCELLED',
            note:       reason || 'Cancelled by admin',
            changedBy:  req.user.id,
          },
        },
      },
    });

    if (shouldRestoreStock) {
      await restoreStockForOrder(tx, order.items);
    }
  });

  await invalidateOrderCache(order.userId, id);

  logger.apiEvent('ADMIN_ORDER_CANCELLED', {
    adminId: req.user.id,
    orderId: id,
    reason,
    restoreStock: shouldRestoreStock,
  });

  ApiResponse.success(res, null, `Order #${order.orderNumber} cancelled by admin.`);
};

// ═══════════════════════════════════════════════════════════
//   PROCESS REFUND
// ═══════════════════════════════════════════════════════════

exports.processRefund = async (req, res) => {
  const { amount, note, transactionRef } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({
    where: { id },
    select: {
      id: true, status: true, orderNumber: true, userId: true,
      total: true, paymentStatus: true,
    },
  });

  if (!order) throw AppError.notFound('Order');

  const refundAmount = amount ?? parseFloat(order.total);

  await prisma.order.update({
    where: { id },
    data: {
      status:        'REFUNDED',
      paymentStatus: 'REFUNDED',
      adminNotes:    `Refund of ₹${refundAmount} processed. Ref: ${transactionRef || 'N/A'}. ${note || ''}`,
      statusHistory: {
        create: {
          fromStatus: order.status,
          toStatus:   'REFUNDED',
          note:       `Refund ₹${refundAmount} processed. Ref: ${transactionRef || 'N/A'}. ${note || ''}`,
          changedBy:  req.user.id,
        },
      },
    },
  });

  await invalidateOrderCache(order.userId, id);

  logger.apiEvent('ADMIN_REFUND_PROCESSED', {
    adminId: req.user.id,
    orderId: id,
    amount:  refundAmount,
    transactionRef,
  });

  ApiResponse.success(res, null, `Refund of ₹${refundAmount.toFixed(2)} processed for order #${order.orderNumber}.`);
};

// ═══════════════════════════════════════════════════════════
//   ADD ADMIN NOTES
// ═══════════════════════════════════════════════════════════

exports.addAdminNotes = async (req, res) => {
  const { notes } = req.body;
  const { id } = req.params;

  const order = await prisma.order.findFirst({ where: { id }, select: { id: true } });
  if (!order) throw AppError.notFound('Order');

  await prisma.order.update({
    where: { id },
    data: { adminNotes: notes },
  });

  ApiResponse.success(res, null, 'Admin notes updated.');
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT SCREENSHOT QUEUE
// ═══════════════════════════════════════════════════════════

exports.getPendingPayments = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where: {
        status: 'SCREENSHOT_UPLOADED',
        deletedAt: null,
      },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        payments: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { screenshots: { take: 1 } },
        },
        _count: { select: { items: true } },
      },
      orderBy: { updatedAt: 'asc' }, // Oldest first = FIFO queue
      skip,
      take: limit,
    }),
    prisma.order.count({ where: { status: 'SCREENSHOT_UPLOADED', deletedAt: null } }),
  ]);

  ApiResponse.paginated(res, orders, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
  }, `${total} order(s) awaiting payment verification.`);
};

// ═══════════════════════════════════════════════════════════
//   ANALYTICS DASHBOARD
// ═══════════════════════════════════════════════════════════

exports.getOrderAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;

  const periodDays = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period] || 30;
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const [
    statusBreakdown,
    revenueStats,
    dailyOrders,
    topProducts,
    pendingPayments,
    recentOrders,
  ] = await Promise.all([
    // Status counts
    prisma.order.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since }, deletedAt: null },
      _count: { id: true },
    }),

    // Revenue aggregates
    prisma.order.aggregate({
      where: {
        status: { in: ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'] },
        createdAt: { gte: since },
        deletedAt: null,
      },
      _sum: { total: true, subtotal: true, couponDiscount: true, shippingCharge: true, taxAmount: true },
      _count: { id: true },
      _avg: { total: true },
    }),

    // Daily order volume (last 7 days)
    prisma.$queryRaw`
      SELECT DATE(created_at)::text as date, COUNT(*)::int as orders, SUM(total)::numeric as revenue
      FROM orders
      WHERE created_at >= ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)}
        AND deleted_at IS NULL
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `.catch(() => []),

    // Top products by revenue
    prisma.orderItem.groupBy({
      by: ['productId', 'productName'],
      where: { order: { createdAt: { gte: since }, deletedAt: null } },
      _sum: { total: true, quantity: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),

    // Pending payment count
    prisma.order.count({ where: { status: 'SCREENSHOT_UPLOADED', deletedAt: null } }),

    // Recent orders
    prisma.order.findMany({
      where: { deletedAt: null },
      include: {
        user: { select: { name: true, email: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);

  const statusMap = statusBreakdown.reduce((acc, s) => {
    acc[s.status] = s._count.id;
    return acc;
  }, {});

  ApiResponse.success(res, {
    period,
    summary: {
      totalOrders:      revenueStats._count.id,
      totalRevenue:     parseFloat(revenueStats._sum.total    || 0),
      totalSubtotal:    parseFloat(revenueStats._sum.subtotal || 0),
      totalCouponSaved: parseFloat(revenueStats._sum.couponDiscount || 0),
      totalShipping:    parseFloat(revenueStats._sum.shippingCharge || 0),
      totalTax:         parseFloat(revenueStats._sum.taxAmount || 0),
      avgOrderValue:    parseFloat(revenueStats._avg.total    || 0),
      pendingPayments,
    },
    statusBreakdown: statusMap,
    dailyOrders,
    topProducts: topProducts.map((p) => ({
      productId:   p.productId,
      productName: p.productName,
      totalRevenue: parseFloat(p._sum.total || 0),
      totalQtySold: p._sum.quantity,
    })),
    recentOrders,
  }, 'Order analytics.');
};

// ═══════════════════════════════════════════════════════════
//   ADMIN INVOICE
// ═══════════════════════════════════════════════════════════

exports.adminDownloadInvoice = async (req, res) => {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id },
    include: {
      items: true,
      address: true,
      user: { select: { name: true, email: true, phone: true } },
    },
  });

  if (!order) throw AppError.notFound('Order');

  const invoiceData = buildInvoiceData(order, order.user);
  const html = renderInvoiceHtml(invoiceData);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="Invoice-${order.orderNumber}.html"`);
  res.send(html);
};
