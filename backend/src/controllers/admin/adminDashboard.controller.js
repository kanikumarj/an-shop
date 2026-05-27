/**
 * controllers/admin/adminDashboard.controller.js  [ENTERPRISE EDITION]
 * ======================================================================
 * Complete admin analytics and dashboard backend.
 *
 * GET /admin/dashboard              — KPI summary (cached 5min)
 * GET /admin/analytics/revenue      — Revenue: daily/weekly/monthly/yearly
 * GET /admin/analytics/orders       — Order funnel + status breakdown
 * GET /admin/analytics/products     — Top sellers, low stock, category mix
 * GET /admin/analytics/customers    — Customer LTV, new vs. returning, top spenders
 * GET /admin/analytics/shipments    — Delivery performance, courier breakdown
 * GET /admin/analytics/payments     — Payment method mix, approval rate
 * GET /admin/analytics/overview     — Full combined snapshot (dashboard page)
 */

'use strict';

const { prisma }    = require('../../config/database');
const { cache }     = require('../../config/redis');
const { ApiResponse } = require('../../utils/ApiResponse');
const { getShipmentStats } = require('../../services/tracking.service');
const logger        = require('../../utils/logger');

// ─── Period helper ─────────────────────────────────────────────────────────────
const getSince = (period) => {
  const daysMap = { '7d': 7, '30d': 30, '90d': 90, '365d': 365, '1y': 365 };
  const days = daysMap[period] || 30;
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000), days };
};

const startOfDay   = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const startOfMonth = () => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; };
const startOfYear  = () => { const d = new Date(); d.setMonth(0,1); d.setHours(0,0,0,0); return d; };

// ─── Revenue status set ───────────────────────────────────────────────────────
const REVENUE_STATUSES = ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];

// ═══════════════════════════════════════════════════════════
//   KPI DASHBOARD — Hero numbers
//   GET /admin/dashboard
// ═══════════════════════════════════════════════════════════

exports.getDashboardStats = async (req, res) => {
  const cacheKey = 'admin:dashboard:v2';
  const cached   = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Dashboard stats (cached).');

  const today      = startOfDay();
  const thisMonth  = startOfMonth();
  const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
  const lastMonthEnd   = new Date(new Date().getFullYear(), new Date().getMonth(), 0);

  const [
    // Orders
    totalOrders, todayOrders, monthOrders, pendingOrders,
    // Revenue
    totalRevenue, todayRevenue, monthRevenue, lastMonthRevenue,
    // Customers
    totalCustomers, newToday, newThisMonth,
    // Products
    totalProducts, lowStock, outOfStock,
    // Payments
    pendingPayments, verifiedToday,
    // Shipments
    activeShipments, deliveredToday,
    // Recent orders
    recentOrders,
  ] = await Promise.all([
    prisma.order.count({ where: { deletedAt: null } }),
    prisma.order.count({ where: { createdAt: { gte: today }, deletedAt: null } }),
    prisma.order.count({ where: { createdAt: { gte: thisMonth }, deletedAt: null } }),
    prisma.order.count({ where: { status: { in: ['PENDING', 'PAYMENT_PENDING', 'SCREENSHOT_UPLOADED'] }, deletedAt: null } }),

    prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES }, deletedAt: null }, _sum: { total: true } }),
    prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: today }, deletedAt: null }, _sum: { total: true } }),
    prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: thisMonth }, deletedAt: null }, _sum: { total: true } }),
    prisma.order.aggregate({ where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: lastMonthStart, lte: lastMonthEnd }, deletedAt: null }, _sum: { total: true } }),

    prisma.user.count({ where: { role: 'CUSTOMER', deletedAt: null } }),
    prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: today } } }),
    prisma.user.count({ where: { role: 'CUSTOMER', createdAt: { gte: thisMonth } } }),

    prisma.product.count({ where: { isActive: true, deletedAt: null } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, stock: { gt: 0, lte: parseInt(process.env.LOW_STOCK_THRESHOLD) || 10 } } }),
    prisma.product.count({ where: { isActive: true, deletedAt: null, stock: 0 } }),

    prisma.payment.count({ where: { status: 'SCREENSHOT_UPLOADED' } }),
    prisma.payment.count({ where: { status: 'VERIFIED', verifiedAt: { gte: today } } }),

    prisma.shipment.count({ where: { status: { in: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'REACHED_HUB'] } } }),
    prisma.shipment.count({ where: { status: 'DELIVERED', deliveredAt: { gte: today } } }),

    prisma.order.findMany({
      where: { deletedAt: null },
      include: {
        user:  { select: { name: true, avatar: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  const currentMonthRev = parseFloat(monthRevenue._sum.total || 0);
  const lastMonthRev    = parseFloat(lastMonthRevenue._sum.total || 0);
  const revenueGrowth   = lastMonthRev > 0
    ? (((currentMonthRev - lastMonthRev) / lastMonthRev) * 100).toFixed(1)
    : null;

  const stats = {
    generatedAt: new Date().toISOString(),
    orders: {
      total:    totalOrders,
      today:    todayOrders,
      month:    monthOrders,
      pending:  pendingOrders,
    },
    revenue: {
      allTime:      parseFloat(totalRevenue._sum.total    || 0),
      today:        parseFloat(todayRevenue._sum.total    || 0),
      thisMonth:    currentMonthRev,
      lastMonth:    lastMonthRev,
      growthPercent: revenueGrowth ? parseFloat(revenueGrowth) : null,
    },
    customers: {
      total:      totalCustomers,
      newToday:   newToday,
      newThisMonth: newThisMonth,
    },
    products: {
      total:      totalProducts,
      lowStock:   lowStock,
      outOfStock: outOfStock,
    },
    payments: {
      pendingVerification: pendingPayments,
      verifiedToday,
    },
    shipments: {
      active:        activeShipments,
      deliveredToday,
    },
    recentOrders,
  };

  await cache.set(cacheKey, stats, 300); // 5 min cache
  ApiResponse.success(res, stats, 'Dashboard KPIs retrieved.');
};

// ═══════════════════════════════════════════════════════════
//   REVENUE ANALYTICS
//   GET /admin/analytics/revenue?period=30d&groupBy=day
// ═══════════════════════════════════════════════════════════

exports.getRevenueAnalytics = async (req, res) => {
  const { period = '30d', groupBy = 'day' } = req.query;
  const { since } = getSince(period);

  const cacheKey = `admin:analytics:revenue:${period}:${groupBy}`;
  const cached   = await cache.get(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Revenue analytics (cached).');

  const [todaySummary, periodSummary, dailySeries, monthlySeries, paymentMix] = await Promise.all([
    // Today vs yesterday
    prisma.order.aggregate({
      where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: startOfDay() }, deletedAt: null },
      _sum:  { total: true, couponDiscount: true, shippingCharge: true, taxAmount: true },
      _count: { id: true },
      _avg:  { total: true },
    }),

    // Period summary
    prisma.order.aggregate({
      where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: since }, deletedAt: null },
      _sum:  { total: true, subtotal: true, couponDiscount: true, shippingCharge: true, taxAmount: true },
      _count: { id: true },
      _avg:  { total: true },
      _max:  { total: true },
      _min:  { total: true },
    }),

    // Daily revenue series (for chart)
    prisma.$queryRaw`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Kolkata')::text  AS date,
        COUNT(*)::int                                        AS orders,
        COALESCE(SUM(total), 0)::numeric(12,2)              AS revenue,
        COALESCE(AVG(total), 0)::numeric(10,2)              AS avg_order_value
      FROM orders
      WHERE status = ANY(ARRAY['CONFIRMED','PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED'])
        AND created_at >= ${since}
        AND deleted_at IS NULL
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
      ORDER BY date ASC
    `.catch(() => []),

    // Monthly revenue series (for trend chart)
    prisma.$queryRaw`
      SELECT
        TO_CHAR(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
        COUNT(*)::int                                               AS orders,
        COALESCE(SUM(total), 0)::numeric(12,2)                     AS revenue
      FROM orders
      WHERE status = ANY(ARRAY['CONFIRMED','PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED'])
        AND created_at >= ${new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)}
        AND deleted_at IS NULL
      GROUP BY TO_CHAR(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')
      ORDER BY month ASC
    `.catch(() => []),

    // Revenue by payment method
    prisma.order.groupBy({
      by: ['paymentMethod'],
      where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: since }, deletedAt: null },
      _sum:  { total: true },
      _count: { id: true },
    }),
  ]);

  const result = {
    period,
    today: {
      revenue:   parseFloat(todaySummary._sum.total          || 0),
      orders:    todaySummary._count.id,
      avgOrder:  parseFloat(todaySummary._avg.total          || 0),
      coupons:   parseFloat(todaySummary._sum.couponDiscount || 0),
      tax:       parseFloat(todaySummary._sum.taxAmount      || 0),
      shipping:  parseFloat(todaySummary._sum.shippingCharge || 0),
    },
    period: {
      revenue:   parseFloat(periodSummary._sum.total          || 0),
      subtotal:  parseFloat(periodSummary._sum.subtotal        || 0),
      orders:    periodSummary._count.id,
      avgOrder:  parseFloat(periodSummary._avg.total           || 0),
      maxOrder:  parseFloat(periodSummary._max.total           || 0),
      minOrder:  parseFloat(periodSummary._min.total           || 0),
      coupons:   parseFloat(periodSummary._sum.couponDiscount  || 0),
      tax:       parseFloat(periodSummary._sum.taxAmount       || 0),
      shipping:  parseFloat(periodSummary._sum.shippingCharge  || 0),
    },
    daily:   dailySeries.map((d) => ({ ...d, revenue: parseFloat(d.revenue), avg_order_value: parseFloat(d.avg_order_value) })),
    monthly: monthlySeries.map((m) => ({ ...m, revenue: parseFloat(m.revenue) })),
    byPaymentMethod: paymentMix.map((m) => ({
      method:  m.paymentMethod,
      revenue: parseFloat(m._sum.total || 0),
      orders:  m._count.id,
    })),
  };

  await cache.set(cacheKey, result, 600); // 10 min cache
  ApiResponse.success(res, result, 'Revenue analytics.');
};

// ═══════════════════════════════════════════════════════════
//   PRODUCT ANALYTICS
//   GET /admin/analytics/products?period=30d
// ═══════════════════════════════════════════════════════════

exports.getProductAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  const [
    topSellers, lowStockProducts, outOfStockProducts,
    categoryBreakdown, recentlyAdded, mostReviewed,
  ] = await Promise.all([
    // Top selling products by revenue + qty
    prisma.orderItem.groupBy({
      by:    ['productId', 'productName'],
      where: { order: { createdAt: { gte: since }, status: { in: REVENUE_STATUSES }, deletedAt: null } },
      _sum:  { total: true, quantity: true },
      _count: { id: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 10,
    }),

    // Low stock (not zero)
    prisma.product.findMany({
      where: { isActive: true, deletedAt: null, stock: { gt: 0, lte: parseInt(process.env.LOW_STOCK_THRESHOLD) || 10 } },
      select: { id: true, name: true, sku: true, stock: true, price: true, imageUrls: true, category: { select: { name: true } } },
      orderBy: { stock: 'asc' },
      take: 20,
    }),

    // Out of stock
    prisma.product.findMany({
      where: { isActive: true, deletedAt: null, stock: 0 },
      select: { id: true, name: true, sku: true, stock: true, price: true, category: { select: { name: true } } },
      orderBy: { soldCount: 'desc' },
      take: 20,
    }),

    // Category revenue breakdown
    prisma.$queryRaw`
      SELECT c.name AS category, COUNT(DISTINCT p.id)::int AS products,
             COALESCE(SUM(oi.total), 0)::numeric(12,2) AS revenue,
             COALESCE(SUM(oi.quantity), 0)::int AS units_sold
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.deleted_at IS NULL
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.created_at >= ${since} AND o.deleted_at IS NULL
        AND o.status = ANY(ARRAY['CONFIRMED','PROCESSING','PACKED','SHIPPED','OUT_FOR_DELIVERY','DELIVERED'])
      WHERE c.deleted_at IS NULL
      GROUP BY c.id, c.name
      ORDER BY revenue DESC
    `.catch(() => []),

    // Recently added products
    prisma.product.findMany({
      where:   { isActive: true, deletedAt: null },
      select:  { id: true, name: true, price: true, stock: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),

    // Most reviewed
    prisma.product.findMany({
      where:   { isActive: true, deletedAt: null, avgRating: { gt: 0 } },
      select:  { id: true, name: true, avgRating: true, reviewCount: true, price: true },
      orderBy: { reviewCount: 'desc' },
      take: 5,
    }),
  ]);

  ApiResponse.success(res, {
    period,
    topSellers: topSellers.map((p) => ({
      productId:   p.productId,
      productName: p.productName,
      revenue:     parseFloat(p._sum.total    || 0),
      unitsSold:   p._sum.quantity,
      orderCount:  p._count.id,
    })),
    lowStock:        lowStockProducts,
    outOfStock:      outOfStockProducts,
    categoryBreakdown: categoryBreakdown.map((c) => ({
      ...c, revenue: parseFloat(c.revenue),
    })),
    recentlyAdded,
    mostReviewed,
  }, 'Product analytics.');
};

// ═══════════════════════════════════════════════════════════
//   CUSTOMER ANALYTICS
//   GET /admin/analytics/customers?period=30d
// ═══════════════════════════════════════════════════════════

exports.getCustomerAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  const [
    totalCustomers, newCustomers, returningCount,
    topSpenders, recentSignups, customerGrowth,
  ] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER', deletedAt: null } }),

    prisma.user.count({
      where: { role: 'CUSTOMER', createdAt: { gte: since }, deletedAt: null },
    }),

    // Customers with > 1 order
    prisma.user.count({
      where: {
        role:    'CUSTOMER',
        deletedAt: null,
        orders: { some: { status: { in: REVENUE_STATUSES } } },
        _count:  undefined,
      },
    }).catch(() => 0),

    // Top 10 spenders (LTV)
    prisma.user.findMany({
      where: { role: 'CUSTOMER', deletedAt: null },
      select: {
        id:        true,
        name:      true,
        email:     true,
        phone:     true,
        createdAt: true,
        _count:    { select: { orders: true } },
        orders: {
          where: { status: { in: REVENUE_STATUSES } },
          select: { total: true },
        },
      },
      take: 100, // Fetch more to compute LTV client-side
    }).then((users) =>
      users
        .map((u) => ({
          id:          u.id,
          name:        u.name,
          email:       u.email,
          phone:       u.phone,
          joinedAt:    u.createdAt,
          totalOrders: u._count.orders,
          ltv:         u.orders.reduce((s, o) => s + parseFloat(o.total), 0),
        }))
        .sort((a, b) => b.ltv - a.ltv)
        .slice(0, 10)
    ),

    // Recent signups
    prisma.user.findMany({
      where:   { role: 'CUSTOMER', deletedAt: null },
      select:  { id: true, name: true, email: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),

    // Daily new signups (for chart)
    prisma.$queryRaw`
      SELECT DATE(created_at AT TIME ZONE 'Asia/Kolkata')::text AS date,
             COUNT(*)::int AS new_customers
      FROM users
      WHERE role = 'CUSTOMER'
        AND created_at >= ${since}
        AND deleted_at IS NULL
      GROUP BY DATE(created_at AT TIME ZONE 'Asia/Kolkata')
      ORDER BY date ASC
    `.catch(() => []),
  ]);

  ApiResponse.success(res, {
    period,
    summary: {
      total:     totalCustomers,
      new:       newCustomers,
      returning: returningCount,
      churnRate: totalCustomers > 0 ? parseFloat(((totalCustomers - returningCount) / totalCustomers * 100).toFixed(1)) : 0,
    },
    topSpenders,
    recentSignups,
    growthByDay: customerGrowth,
  }, 'Customer analytics.');
};

// ═══════════════════════════════════════════════════════════
//   ORDER FUNNEL ANALYTICS
//   GET /admin/analytics/orders?period=30d
// ═══════════════════════════════════════════════════════════

exports.getOrderAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  const [statusBreakdown, conversionFunnel, hourlySales, orderSizeDistrib] = await Promise.all([
    // Status counts
    prisma.order.groupBy({
      by:    ['status'],
      where: { createdAt: { gte: since }, deletedAt: null },
      _count: { id: true },
      _sum:  { total: true },
    }),

    // Conversion funnel: placed → paid → delivered
    prisma.$queryRaw`
      SELECT
        COUNT(*)                                                         AS total_placed,
        COUNT(*) FILTER (WHERE payment_status IN ('VERIFIED','PAID'))    AS total_paid,
        COUNT(*) FILTER (WHERE status = 'DELIVERED')                     AS total_delivered,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')                     AS total_cancelled
      FROM orders
      WHERE created_at >= ${since} AND deleted_at IS NULL
    `.catch(() => [{ total_placed: 0, total_paid: 0, total_delivered: 0, total_cancelled: 0 }]),

    // Hourly order distribution (peak hours)
    prisma.$queryRaw`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata')::int AS hour,
        COUNT(*)::int AS orders
      FROM orders
      WHERE created_at >= ${since} AND deleted_at IS NULL
      GROUP BY hour
      ORDER BY hour ASC
    `.catch(() => []),

    // Order value distribution (buckets)
    prisma.$queryRaw`
      SELECT
        CASE
          WHEN total < 200  THEN 'Under ₹200'
          WHEN total < 500  THEN '₹200–₹500'
          WHEN total < 1000 THEN '₹500–₹1000'
          ELSE 'Above ₹1000'
        END AS bucket,
        COUNT(*)::int AS count
      FROM orders
      WHERE created_at >= ${since} AND deleted_at IS NULL
      GROUP BY bucket
      ORDER BY MIN(total) ASC
    `.catch(() => []),
  ]);

  const byStatus = statusBreakdown.reduce((acc, s) => {
    acc[s.status] = { count: s._count.id, revenue: parseFloat(s._sum.total || 0) };
    return acc;
  }, {});

  const f = conversionFunnel[0] || {};

  ApiResponse.success(res, {
    period,
    byStatus,
    funnel: {
      placed:    parseInt(f.total_placed    || 0),
      paid:      parseInt(f.total_paid      || 0),
      delivered: parseInt(f.total_delivered || 0),
      cancelled: parseInt(f.total_cancelled || 0),
      paymentRate:  f.total_placed > 0 ? ((f.total_paid / f.total_placed) * 100).toFixed(1) : 0,
      deliveryRate: f.total_paid   > 0 ? ((f.total_delivered / f.total_paid) * 100).toFixed(1) : 0,
    },
    peakHours:    hourlySales,
    sizeDistrib:  orderSizeDistrib,
  }, 'Order analytics.');
};

// ═══════════════════════════════════════════════════════════
//   PAYMENT ANALYTICS
//   GET /admin/analytics/payments?period=30d
// ═══════════════════════════════════════════════════════════

exports.getPaymentAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  const [statusBreakdown, methodBreakdown, pendingQueue, avgVerificationTime] = await Promise.all([
    prisma.payment.groupBy({
      by:    ['status'],
      where: { createdAt: { gte: since } },
      _count: { id: true },
      _sum:  { amount: true },
    }),

    prisma.payment.groupBy({
      by:    ['method'],
      where: { createdAt: { gte: since } },
      _count: { id: true },
      _sum:  { amount: true },
    }),

    prisma.payment.count({ where: { status: 'SCREENSHOT_UPLOADED' } }),

    prisma.$queryRaw`
      SELECT AVG(
        EXTRACT(EPOCH FROM (ps.reviewed_at - ps.uploaded_at)) / 60
      )::numeric(8,2) AS avg_minutes
      FROM payment_screenshots ps
      WHERE ps.status = 'APPROVED' AND ps.reviewed_at IS NOT NULL
        AND ps.uploaded_at >= ${since}
    `.catch(() => [{ avg_minutes: null }]),
  ]);

  ApiResponse.success(res, {
    period,
    pendingQueue,
    avgVerificationMinutes: parseFloat(avgVerificationTime[0]?.avg_minutes || 0),
    byStatus:  statusBreakdown.reduce((acc, s) => {
      acc[s.status] = { count: s._count.id, revenue: parseFloat(s._sum.amount || 0) };
      return acc;
    }, {}),
    byMethod:  methodBreakdown.map((m) => ({
      method:  m.method,
      count:   m._count.id,
      revenue: parseFloat(m._sum.amount || 0),
    })),
  }, 'Payment analytics.');
};

// ═══════════════════════════════════════════════════════════
//   SHIPMENT ANALYTICS
//   GET /admin/analytics/shipments?period=30d
// ═══════════════════════════════════════════════════════════

exports.getShipmentAnalytics = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  const [stats, avgDeliveryTime, lateCount] = await Promise.all([
    getShipmentStats(since),

    prisma.$queryRaw`
      SELECT AVG(
        EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400
      )::numeric(6,2) AS avg_days
      FROM shipments
      WHERE status = 'DELIVERED' AND delivered_at IS NOT NULL
        AND created_at >= ${since}
    `.catch(() => [{ avg_days: null }]),

    prisma.shipment.count({
      where: {
        estimatedDelivery: { lt: new Date() },
        status: { notIn: ['DELIVERED', 'RETURNED', 'DELIVERY_FAILED'] },
      },
    }),
  ]);

  ApiResponse.success(res, {
    period,
    byStatus:        stats.byStatus,
    byCourier:       stats.byCourier,
    avgDeliveryDays: parseFloat(avgDeliveryTime[0]?.avg_days || 0),
    lateShipments:   lateCount,
  }, 'Shipment analytics.');
};

// ═══════════════════════════════════════════════════════════
//   FULL OVERVIEW SNAPSHOT
//   GET /admin/analytics/overview — Single endpoint for entire dashboard page
// ═══════════════════════════════════════════════════════════

exports.getAnalyticsOverview = async (req, res) => {
  const { period = '30d' } = req.query;
  const { since }          = getSince(period);

  // Lightweight combined snapshot — avoids 7 separate API calls from frontend
  const [revenue, orders, topProducts, lowStock, pendingPayments, shipStats] = await Promise.all([
    prisma.order.aggregate({
      where: { status: { in: REVENUE_STATUSES }, createdAt: { gte: since }, deletedAt: null },
      _sum:  { total: true },
      _count: { id: true },
      _avg:  { total: true },
    }),

    prisma.order.groupBy({
      by:    ['status'],
      where: { createdAt: { gte: since }, deletedAt: null },
      _count: { id: true },
    }),

    prisma.orderItem.groupBy({
      by:    ['productId', 'productName'],
      where: { order: { createdAt: { gte: since }, status: { in: REVENUE_STATUSES }, deletedAt: null } },
      _sum:  { total: true, quantity: true },
      orderBy: { _sum: { total: 'desc' } },
      take: 5,
    }),

    prisma.product.count({
      where: { isActive: true, deletedAt: null, stock: { lte: parseInt(process.env.LOW_STOCK_THRESHOLD) || 10 } },
    }),

    prisma.payment.count({ where: { status: 'SCREENSHOT_UPLOADED' } }),

    getShipmentStats(since),
  ]);

  ApiResponse.success(res, {
    period,
    revenue: {
      total:    parseFloat(revenue._sum.total || 0),
      orders:   revenue._count.id,
      avgOrder: parseFloat(revenue._avg.total || 0),
    },
    ordersByStatus: orders.reduce((acc, o) => { acc[o.status] = o._count.id; return acc; }, {}),
    topProducts:    topProducts.map((p) => ({
      productId: p.productId, productName: p.productName,
      revenue:   parseFloat(p._sum.total || 0), units: p._sum.quantity,
    })),
    alerts: {
      lowStockCount:    lowStock,
      pendingPayments,
      lateShipments:   shipStats.lateCount,
    },
    shipmentsByStatus: shipStats.byStatus,
  }, 'Analytics overview.');
};
