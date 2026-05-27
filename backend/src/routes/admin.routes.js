/**
 * routes/admin.routes.js  [ENTERPRISE EDITION]
 * ===============================================
 * Master admin router — mounts all admin sub-routers.
 * All routes require: protect + ADMIN/SUPERADMIN role.
 *
 * ── Dashboard ─────────────────────────────────────────────
 * GET  /admin/dashboard                 — KPI summary
 * GET  /admin/analytics/overview        — Full snapshot
 * GET  /admin/analytics/revenue         — Revenue trends
 * GET  /admin/analytics/orders          — Order funnel
 * GET  /admin/analytics/products        — Inventory analytics
 * GET  /admin/analytics/customers       — LTV + growth
 * GET  /admin/analytics/shipments       — Delivery performance
 * GET  /admin/analytics/payments        — Payment analytics
 *
 * ── Orders ────────────────────────────────────────────────
 * GET    /admin/orders                  — All orders
 * GET    /admin/orders/:id              — Order detail
 * PATCH  /admin/orders/:id/status       — Status update
 * PATCH  /admin/orders/:id/payment      — Verify payment
 * POST   /admin/orders/:id/ship         — Ship order (new tracking)
 * PATCH  /admin/orders/:id/deliver      — Mark delivered
 * PATCH  /admin/orders/:id/cancel       — Cancel order
 * PATCH  /admin/orders/:id/refund       — Process refund
 * PATCH  /admin/orders/:id/notes        — Admin notes
 * GET    /admin/orders/pending-payment  — Screenshot queue
 * GET    /admin/orders/:id/invoice      — Invoice HTML
 *
 * ── Tracking ──────────────────────────────────────────────
 * GET    /admin/tracking                — All shipments
 * GET    /admin/tracking/stats          — Performance stats
 * GET    /admin/tracking/late           — Overdue shipments
 * GET    /admin/tracking/:shipmentId    — Shipment detail
 * POST   /admin/tracking/:shipmentId/checkpoint  — Add event
 * PATCH  /admin/tracking/:shipmentId/status      — Update status
 *
 * ── Products ──────────────────────────────────────────────
 *   → /admin/products/* (adminProduct.routes.js)
 *
 * ── Payments ──────────────────────────────────────────────
 *   → /admin/payments/* (adminPayment.routes.js)
 *
 * ── Users ─────────────────────────────────────────────────
 * GET    /admin/users                   — All users
 * GET    /admin/users/:id               — User detail
 * PATCH  /admin/users/:id/status        — Block/unblock
 * PATCH  /admin/users/:id/role          — Change role (SUPERADMIN)
 *
 * ── Coupons / Settings / Categories ───────────────────────
 *   → via inline routes below
 */

'use strict';

const { Router }   = require('express');
const rateLimit    = require('express-rate-limit');

const { protect, adminOnly, restrictTo } = require('../middleware/auth');
const { validate }  = require('../middleware/validate');
const { z }         = require('zod');

// ─── Controllers ───────────────────────────────────────────────────────────────
const dashboard = require('../controllers/admin/adminDashboard.controller');
const orders    = require('../controllers/admin/adminOrder.controller');
const payments  = require('../controllers/admin/adminPayment.controller');
const tracking  = require('../controllers/tracking.controller');
const users     = require('../controllers/admin/adminUser.controller');
const settings  = require('../controllers/admin/adminSettings.controller');
const coupons   = require('../controllers/admin/adminCoupon.controller');

// ─── Sub-routers ───────────────────────────────────────────────────────────────
const adminProductRoutes  = require('./admin/adminProduct.routes');
const adminPaymentRoutes  = require('./admin/adminPayment.routes');
const adminCategoryRoutes = require('./admin/adminCategory.routes');
const adminOrderRoutes    = require('./admin/adminOrder.routes');

const router = Router();

// ─── Admin rate limiter ────────────────────────────────────────────────────────
const adminLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { success: false, message: 'Admin rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

const writeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many write requests.' },
});

// All admin routes require auth + admin role
router.use(protect, adminOnly, adminLimiter);

// ─────────────────────────────────────────────────────────────────────────────
//   DASHBOARD & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/dashboard',                  dashboard.getDashboardStats);
router.get('/analytics/overview',         dashboard.getAnalyticsOverview);
router.get('/analytics/revenue',          dashboard.getRevenueAnalytics);
router.get('/analytics/orders',           dashboard.getOrderAnalytics);
router.get('/analytics/products',         dashboard.getProductAnalytics);
router.get('/analytics/customers',        dashboard.getCustomerAnalytics);
router.get('/analytics/shipments',        dashboard.getShipmentAnalytics);
router.get('/analytics/payments',         dashboard.getPaymentAnalytics);

// ─────────────────────────────────────────────────────────────────────────────
//   ORDER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Special routes BEFORE /:id to avoid conflicts
router.get('/orders/pending-payment',     orders.getPendingPayments);
router.get('/orders/analytics',           orders.getOrderAnalytics);

router.get('/orders',                     orders.listOrders);
router.get('/orders/:id',                 orders.getOrder);
router.get('/orders/:id/invoice',         orders.adminDownloadInvoice);

router.patch('/orders/:id/status',
  validate(z.object({
    status: z.string({ required_error: 'status is required.' }),
    note:   z.string().max(500).optional(),
    force:  z.boolean().optional().default(false),
  })),
  orders.updateOrderStatus
);

// Ship an order → creates shipment record + generates tracking
router.post('/orders/:id/ship',
  validate(z.object({
    trackingNumber:    z.string().max(100).optional(),
    courierName:       z.string({ required_error: 'courierName is required.' }).min(2).max(100),
    courierUrl:        z.string().url().optional().nullable(),
    estimatedDelivery: z.string().datetime().optional().nullable(),
    note:              z.string().max(500).optional(),
    addPickupCheckpoint: z.boolean().optional().default(true),
  })),
  tracking.adminShipOrder
);

router.patch('/orders/:id/payment',
  validate(z.object({
    action:          z.enum(['APPROVE', 'REJECT']),
    note:            z.string().max(500).optional(),
    rejectionReason: z.string().max(500).optional(),
  })),
  orders.verifyPayment
);

router.patch('/orders/:id/deliver',
  validate(z.object({ note: z.string().max(500).optional() })),
  orders.markDelivered
);

router.patch('/orders/:id/cancel',
  validate(z.object({
    reason:       z.string().min(3).max(500).optional(),
    restoreStock: z.boolean().optional().default(true),
  })),
  orders.adminCancelOrder
);

router.patch('/orders/:id/refund',
  validate(z.object({
    amount:         z.coerce.number().positive().optional(),
    note:           z.string().max(500).optional(),
    transactionRef: z.string().max(100).optional(),
  })),
  orders.processRefund
);

router.patch('/orders/:id/notes',
  validate(z.object({ notes: z.string().max(2000) })),
  orders.addAdminNotes
);

// ─────────────────────────────────────────────────────────────────────────────
//   SHIPMENT TRACKING
// ─────────────────────────────────────────────────────────────────────────────

// Stats and filters BEFORE /:shipmentId
router.get('/tracking/stats',  tracking.adminShipmentStats);
router.get('/tracking/late',   tracking.adminLateShipments);
router.get('/tracking',        tracking.adminListShipments);

router.get('/tracking/:shipmentId', tracking.adminGetShipment);

router.post('/tracking/:shipmentId/checkpoint',
  validate(z.object({
    status:          z.enum(['BOOKED','PICKED_UP','IN_TRANSIT','REACHED_HUB','DISPATCHED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RETURNED_TO_HUB','RETURNED']),
    description:     z.string().max(500).optional(),
    location:        z.string().max(200).optional(),
    timestamp:       z.string().datetime().optional(),
    autoUpdateOrder: z.boolean().optional().default(true),
  })),
  tracking.adminAddCheckpoint
);

router.patch('/tracking/:shipmentId/status',
  validate(z.object({
    status:      z.enum(['BOOKED','PICKED_UP','IN_TRANSIT','REACHED_HUB','DISPATCHED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RETURNED_TO_HUB','RETURNED']),
    description: z.string().max(500).optional(),
    location:    z.string().max(200).optional(),
  })),
  tracking.adminUpdateShipmentStatus
);

// ─────────────────────────────────────────────────────────────────────────────
//   USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

router.get('/users',                    users.getAllUsers);
router.get('/users/:id',                users.getUserDetail);
router.patch('/users/:id/status',       users.toggleUserStatus);
router.patch('/users/:id/role',
  restrictTo('SUPERADMIN'),
  users.changeUserRole
);

// ─────────────────────────────────────────────────────────────────────────────
//   COUPONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/coupons',     coupons.getAllCoupons);
router.post('/coupons',    coupons.createCoupon);
router.put('/coupons/:id', coupons.updateCoupon);
router.delete('/coupons/:id', coupons.deleteCoupon);

// ─────────────────────────────────────────────────────────────────────────────
//   SETTINGS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/settings',                 settings.getSettings);
router.put('/settings', restrictTo('SUPERADMIN'), settings.updateSettings);

// ─────────────────────────────────────────────────────────────────────────────
//   SUB-ROUTER MOUNTS
// ─────────────────────────────────────────────────────────────────────────────

router.use('/products',   adminProductRoutes);
router.use('/payments',   adminPaymentRoutes);
router.use('/categories', adminCategoryRoutes);

module.exports = router;
