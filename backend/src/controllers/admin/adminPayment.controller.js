/**
 * controllers/admin/adminPayment.controller.js  [ENTERPRISE EDITION]
 * =====================================================================
 * Admin UPI payment verification panel.
 *
 * GET  /admin/payments                    — Verification queue (FIFO)
 * GET  /admin/payments/analytics          — Revenue + verification stats
 * GET  /admin/payments/:id                — Full payment + screenshot detail
 * POST /admin/payments/:id/approve        — Approve payment → confirms order
 * POST /admin/payments/:id/reject         — Reject + notify customer
 * GET  /admin/payments/screenshots        — All screenshots (with filters)
 * POST /admin/payments/:id/flag           — Flag suspicious payment
 * GET  /admin/payments/utr/:utr           — Lookup payment by UTR
 * GET  /admin/payments/reference/:ref     — Lookup by reference code
 * GET  /admin/payments/suspicious         — Flagged / duplicate UTR alerts
 */

'use strict';

const { prisma }          = require('../../config/database');
const { withTransaction } = require('../../config/database');
const { cache }           = require('../../config/redis');
const { ApiResponse }     = require('../../utils/ApiResponse');
const AppError            = require('../../utils/AppError');
const logger              = require('../../utils/logger');

const {
  approvePayment,
  rejectPayment,
  paymentCacheKey,
} = require('../../services/payment.service');

// ─── Field sets ───────────────────────────────────────────────────────────────
const PAYMENT_QUEUE_INCLUDE = {
  order: {
    select: {
      id: true, orderNumber: true, total: true, status: true,
      paymentMethod: true, customerNotes: true,
    },
  },
  screenshots: {
    where:   { deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take:    1,
  },
};

const PAYMENT_DETAIL_INCLUDE = {
  order: {
    select: {
      id: true, orderNumber: true, total: true, status: true,
      paymentStatus: true, paymentMethod: true, customerNotes: true,
      subtotal: true, couponDiscount: true, shippingCharge: true, taxAmount: true,
      shippingAddress: true,
    },
  },
  screenshots: {
    where:   { deletedAt: null },
    orderBy: { createdAt: 'desc' },
  },
};

// ─── Pagination ────────────────────────────────────────────────────────────────
const getPagination = (query) => {
  const page  = Math.max(1, parseInt(query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

// ═══════════════════════════════════════════════════════════
//   VERIFICATION QUEUE
//   GET /admin/payments?status=SCREENSHOT_UPLOADED
// ═══════════════════════════════════════════════════════════

exports.getPaymentQueue = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const {
    status = 'SCREENSHOT_UPLOADED',
    method,
    from, to,
    q,
    sortBy  = 'updatedAt',
    sortDir = 'asc',   // Oldest first = FIFO
  } = req.query;

  const where = {
    ...(status && { status }),
    ...(method && { method }),
    ...((from || to) && {
      createdAt: {
        ...(from && { gte: new Date(from) }),
        ...(to   && { lte: new Date(to)   }),
      },
    }),
    ...(q && {
      OR: [
        { paymentReference:   { contains: q.toUpperCase() } },
        { upiTransactionId:   { contains: q.toUpperCase() } },
        { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
      ],
    }),
  };

  const allowedSort = ['updatedAt', 'createdAt', 'amount'];
  const orderBy = { [allowedSort.includes(sortBy) ? sortBy : 'updatedAt']: sortDir === 'desc' ? 'desc' : 'asc' };

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        ...PAYMENT_QUEUE_INCLUDE,
        // Load uploader info from screenshots
        screenshots: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            // Load uploader name
          },
        },
        order: {
          select: {
            ...PAYMENT_QUEUE_INCLUDE.order.select,
            user: { select: { id: true, name: true, email: true, phone: true } },
          },
        },
      },
      orderBy,
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);

  ApiResponse.paginated(res, payments, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  }, `${total} payment(s) in queue.`);
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT DETAIL
//   GET /admin/payments/:id
// ═══════════════════════════════════════════════════════════

exports.getPaymentDetail = async (req, res) => {
  const { id } = req.params;

  const payment = await prisma.payment.findFirst({
    where: { id },
    include: {
      ...PAYMENT_DETAIL_INCLUDE,
      order: {
        select: {
          ...PAYMENT_DETAIL_INCLUDE.order.select,
          user: { select: { id: true, name: true, email: true, phone: true, avatar: true } },
          items: {
            select: {
              productName: true, variantName: true, quantity: true, unitPrice: true, total: true, imageUrl: true,
            },
          },
        },
      },
    },
  });

  if (!payment) throw AppError.notFound('Payment');

  // Check for other payments with the same UTR (fraud signal)
  const utr = payment.upiTransactionId;
  let utrConflict = null;
  if (utr) {
    const conflictingScreenshots = await prisma.paymentScreenshot.findMany({
      where: {
        utrNumber: utr,
        paymentId: { not: payment.id },
        deletedAt: null,
      },
      select: {
        id: true, paymentId: true, status: true, uploadedBy: true, uploadedAt: true,
      },
      take: 5,
    });
    if (conflictingScreenshots.length > 0) {
      utrConflict = { isDuplicate: true, count: conflictingScreenshots.length, items: conflictingScreenshots };
    }
  }

  ApiResponse.success(res, { ...payment, utrConflict });
};

// ═══════════════════════════════════════════════════════════
//   APPROVE PAYMENT
//   POST /admin/payments/:id/approve
// ═══════════════════════════════════════════════════════════

exports.approvePayment = async (req, res) => {
  const { id }  = req.params;
  const { note, screenshotId } = req.body;
  const adminId = req.user.id;

  const payment = await prisma.payment.findFirst({
    where: { id },
    include: { screenshots: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } },
  });

  if (!payment) throw AppError.notFound('Payment');

  if (payment.status === 'VERIFIED') {
    throw AppError.badRequest('This payment has already been verified.', 'ALREADY_VERIFIED');
  }

  if (!['SCREENSHOT_UPLOADED'].includes(payment.status)) {
    throw AppError.badRequest(
      `Payment must have an uploaded screenshot to be approved. Current: ${payment.status}`,
      'SCREENSHOT_REQUIRED'
    );
  }

  // Select specific screenshot or latest
  const screenshot = screenshotId
    ? payment.screenshots.find((s) => s.id === screenshotId)
    : payment.screenshots.find((s) => s.status === 'PENDING_REVIEW') || payment.screenshots[0];

  if (!screenshot) {
    throw AppError.badRequest('No screenshot found to approve.');
  }

  const updatedOrder = await withTransaction(async (tx) => {
    return approvePayment(tx, payment, screenshot, adminId, note);
  });

  // Clear caches
  await Promise.all([
    cache.del(`order:${payment.orderId}`),
    cache.del(paymentCacheKey(id)),
    cache.del(paymentCacheKey(`status:${payment.orderId}`)),
    cache.delPattern(`orders:user:${updatedOrder.userId || '*'}:*`),
  ]);

  // Notify customer
  setImmediate(async () => {
    try {
      const notifService = require('../../services/notification.service');
      const order = await prisma.order.findUnique({
        where: { id: payment.orderId },
        select: { orderNumber: true, userId: true },
      });

      await notifService.createNotification({
        userId:  order.userId,
        type:    'PAYMENT_VERIFIED',
        title:   '✅ Payment Verified!',
        message: `Your payment for order #${order.orderNumber} has been verified. We're now preparing your order!`,
        data:    { orderId: payment.orderId },
      });
    } catch (_) {}
  });

  logger.apiEvent('ADMIN_PAYMENT_APPROVED', {
    adminId,
    paymentId:    id,
    orderId:      payment.orderId,
    screenshotId: screenshot.id,
    utr:          screenshot.utrNumber,
  });

  ApiResponse.success(res, null, `Payment approved. Order confirmed and customer notified.`);
};

// ═══════════════════════════════════════════════════════════
//   REJECT PAYMENT
//   POST /admin/payments/:id/reject
// ═══════════════════════════════════════════════════════════

exports.rejectPayment = async (req, res) => {
  const { id }  = req.params;
  const { reason, screenshotId, notifyCustomer = true } = req.body;
  const adminId = req.user.id;

  if (!reason || reason.trim().length < 5) {
    throw AppError.badRequest('Rejection reason is required (minimum 5 characters).');
  }

  const payment = await prisma.payment.findFirst({
    where: { id },
    include: { screenshots: { where: { deletedAt: null }, orderBy: { createdAt: 'desc' } } },
  });

  if (!payment) throw AppError.notFound('Payment');

  if (['VERIFIED', 'REJECTED'].includes(payment.status) && payment.status === 'VERIFIED') {
    throw AppError.badRequest('Cannot reject an already verified payment.', 'ALREADY_VERIFIED');
  }

  const screenshot = screenshotId
    ? payment.screenshots.find((s) => s.id === screenshotId)
    : payment.screenshots.find((s) => s.status === 'PENDING_REVIEW') || payment.screenshots[0];

  if (!screenshot) {
    throw AppError.badRequest('No screenshot found to reject.');
  }

  await withTransaction(async (tx) => {
    await rejectPayment(tx, payment, screenshot, adminId, reason);
  });

  // Clear caches
  await Promise.all([
    cache.del(`order:${payment.orderId}`),
    cache.del(paymentCacheKey(id)),
    cache.del(paymentCacheKey(`status:${payment.orderId}`)),
  ]);

  // Notify customer
  if (notifyCustomer) {
    setImmediate(async () => {
      try {
        const notifService = require('../../services/notification.service');
        const order = await prisma.order.findUnique({
          where: { id: payment.orderId },
          select: { orderNumber: true, userId: true },
        });

        await notifService.createNotification({
          userId:  order.userId,
          type:    'PAYMENT_REJECTED',
          title:   '❌ Payment Screenshot Rejected',
          message: `Your payment screenshot for order #${order.orderNumber} was rejected. Reason: ${reason}. Please upload a clear screenshot.`,
          data:    { orderId: payment.orderId, reason },
        });
      } catch (_) {}
    });
  }

  logger.apiEvent('ADMIN_PAYMENT_REJECTED', {
    adminId,
    paymentId:    id,
    orderId:      payment.orderId,
    screenshotId: screenshot.id,
    reason,
  });

  ApiResponse.success(res, null, 'Payment rejected. Customer can re-upload their screenshot.');
};

// ═══════════════════════════════════════════════════════════
//   FLAG SUSPICIOUS PAYMENT
//   POST /admin/payments/:id/flag
// ═══════════════════════════════════════════════════════════

exports.flagPayment = async (req, res) => {
  const { id }    = req.params;
  const { reason }= req.body;
  const adminId   = req.user.id;

  const payment = await prisma.payment.findFirst({ where: { id }, select: { id: true, orderId: true } });
  if (!payment) throw AppError.notFound('Payment');

  // Store flag note in payment admin notes
  await prisma.order.update({
    where: { id: payment.orderId },
    data: {
      adminNotes: `🚩 FLAGGED by admin ${adminId}: ${reason || 'Suspicious activity'}`,
    },
  });

  logger.securityEvent('PAYMENT_FLAGGED', { adminId, paymentId: id, reason });
  ApiResponse.success(res, null, 'Payment flagged for review.');
};

// ═══════════════════════════════════════════════════════════
//   LOOKUP BY UTR
//   GET /admin/payments/utr/:utr
// ═══════════════════════════════════════════════════════════

exports.lookupByUtr = async (req, res) => {
  const { utr } = req.params;
  const upper   = utr.toUpperCase().trim();

  const screenshots = await prisma.paymentScreenshot.findMany({
    where: { utrNumber: upper, deletedAt: null },
    include: {
      payment: {
        include: {
          order: { select: { orderNumber: true, total: true, status: true, userId: true } },
        },
      },
    },
  });

  ApiResponse.success(res, screenshots, `${screenshots.length} result(s) for UTR "${upper}".`);
};

// ═══════════════════════════════════════════════════════════
//   LOOKUP BY REFERENCE CODE
//   GET /admin/payments/reference/:ref
// ═══════════════════════════════════════════════════════════

exports.lookupByReference = async (req, res) => {
  const ref = req.params.ref.toUpperCase().trim();

  const payment = await prisma.payment.findFirst({
    where: { paymentReference: ref },
    include: {
      ...PAYMENT_DETAIL_INCLUDE,
      order: {
        select: {
          ...PAYMENT_DETAIL_INCLUDE.order.select,
          user: { select: { name: true, email: true, phone: true } },
        },
      },
    },
  });

  if (!payment) throw AppError.notFound(`Payment with reference "${ref}"`);
  ApiResponse.success(res, payment);
};

// ═══════════════════════════════════════════════════════════
//   SUSPICIOUS PAYMENTS
//   GET /admin/payments/suspicious
// ═══════════════════════════════════════════════════════════

exports.getSuspiciousPayments = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  // Find UTR numbers used more than once in ANY screenshot
  const duplicateUtrs = await prisma.$queryRaw`
    SELECT utr_number, COUNT(*) as count, ARRAY_AGG(payment_id) as payment_ids
    FROM payment_screenshots
    WHERE utr_number IS NOT NULL AND deleted_at IS NULL
    GROUP BY utr_number
    HAVING COUNT(*) > 1
    ORDER BY count DESC
    LIMIT 50
  `.catch(() => []);

  // Payments with large amount differences
  const amountMismatches = await prisma.paymentScreenshot.findMany({
    where: {
      status:   'PENDING_REVIEW',
      paidAmount: { not: null },
      deletedAt: null,
      payment: {
        order: {
          total: { gt: 0 },
        },
      },
    },
    include: {
      payment: {
        select: {
          id: true, amount: true, paymentReference: true,
          order: { select: { orderNumber: true, total: true } },
        },
      },
    },
    take: 20,
  }).then((items) =>
    items.filter((item) => {
      const declared = parseFloat(item.paidAmount);
      const expected = parseFloat(item.payment.amount);
      return Math.abs(declared - expected) > 1;
    })
  );

  // Recent rapid-upload users (more than 2 uploads in 10 min)
  const rapidUploaders = await prisma.$queryRaw`
    SELECT uploaded_by, COUNT(*) as upload_count, MIN(created_at) as first_at, MAX(created_at) as last_at
    FROM payment_screenshots
    WHERE created_at >= NOW() - INTERVAL '10 minutes'
      AND deleted_at IS NULL
    GROUP BY uploaded_by
    HAVING COUNT(*) > 2
  `.catch(() => []);

  ApiResponse.success(res, {
    duplicateUtrs,
    amountMismatches: amountMismatches.map((s) => ({
      screenshotId:  s.id,
      paymentId:     s.payment.id,
      orderNumber:   s.payment.order.orderNumber,
      expectedAmount: parseFloat(s.payment.amount),
      declaredAmount: parseFloat(s.paidAmount),
      difference:    Math.abs(parseFloat(s.paidAmount) - parseFloat(s.payment.amount)),
    })),
    rapidUploaders,
  }, 'Suspicious activity analysis.');
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT ANALYTICS
//   GET /admin/payments/analytics?period=30d
// ═══════════════════════════════════════════════════════════

exports.getPaymentAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const days  = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    statusBreakdown,
    revenueStats,
    methodBreakdown,
    avgVerificationTime,
    pendingCount,
    recentApprovals,
  ] = await Promise.all([
    // Status counts
    prisma.payment.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since } },
      _count: { id: true },
      _sum:   { amount: true },
    }),

    // Revenue from verified payments
    prisma.payment.aggregate({
      where: { status: 'VERIFIED', createdAt: { gte: since } },
      _sum:   { amount: true },
      _count: { id: true },
      _avg:   { amount: true },
    }),

    // By payment method
    prisma.payment.groupBy({
      by: ['method'],
      where: { createdAt: { gte: since } },
      _count: { id: true },
      _sum:   { amount: true },
    }),

    // Average time from screenshot upload to approval
    prisma.$queryRaw`
      SELECT AVG(EXTRACT(EPOCH FROM (ps.reviewed_at - ps.uploaded_at)) / 60)::numeric(10,2) as avg_minutes
      FROM payment_screenshots ps
      WHERE ps.status = 'APPROVED'
        AND ps.reviewed_at IS NOT NULL
        AND ps.uploaded_at >= ${since}
    `.catch(() => [{ avg_minutes: null }]),

    // Pending review count
    prisma.payment.count({ where: { status: 'SCREENSHOT_UPLOADED' } }),

    // Recent 5 approvals
    prisma.payment.findMany({
      where: { status: 'VERIFIED', verifiedAt: { not: null } },
      select: {
        id: true, paymentReference: true, amount: true, verifiedAt: true,
        upiTransactionId: true,
        order: { select: { orderNumber: true } },
      },
      orderBy: { verifiedAt: 'desc' },
      take: 5,
    }),
  ]);

  const byStatus = statusBreakdown.reduce((acc, s) => {
    acc[s.status] = { count: s._count.id, totalAmount: parseFloat(s._sum.amount || 0) };
    return acc;
  }, {});

  ApiResponse.success(res, {
    period,
    summary: {
      totalRevenue:       parseFloat(revenueStats._sum.amount || 0),
      verifiedPayments:   revenueStats._count.id,
      avgOrderValue:      parseFloat(revenueStats._avg.amount || 0),
      pendingVerification: pendingCount,
      avgVerificationMinutes: parseFloat(avgVerificationTime[0]?.avg_minutes || 0),
    },
    byStatus,
    byMethod: methodBreakdown.reduce((acc, m) => {
      acc[m.method] = { count: m._count.id, totalAmount: parseFloat(m._sum.amount || 0) };
      return acc;
    }, {}),
    recentApprovals,
  }, 'Payment analytics.');
};
