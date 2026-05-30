/**
 * controllers/tracking.controller.js  [ENTERPRISE EDITION]
 * ==========================================================
 * Customer and admin shipment tracking APIs.
 *
 * CUSTOMER ROUTES:
 *   GET /tracking/:trackingNumber       — Public tracking (no auth needed)
 *   GET /tracking/order/:orderId        — Track by order ID (auth required)
 *   GET /tracking/couriers              — List supported couriers
 *
 * ADMIN ROUTES:
 *   GET    /admin/tracking              — All shipments (filterable)
 *   GET    /admin/tracking/stats        — Shipment performance stats
 *   GET    /admin/tracking/late         — Overdue shipments
 *   GET    /admin/tracking/:shipmentId  — Full shipment detail
 *   POST   /admin/tracking/:shipmentId/checkpoint — Add tracking event
 *   PATCH  /admin/tracking/:shipmentId/status     — Update shipment status
 *   POST   /admin/orders/:orderId/ship  — Ship an order (new route entry)
 */

'use strict';

const { prisma }    = require('../config/database');
const { cache }     = require('../config/redis');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError      = require('../utils/AppError');
const logger        = require('../utils/logger');

const {
  getTrackingInfo,
  addCheckpoint,
  createOrUpdateShipment,
  getShipmentStats,
  generateTrackingId,
  COURIERS,
  CHECKPOINT_EMOJIS,
  getTrackingProgress,
  resolveCourier,
} = require('../services/tracking.service');

// ─── Pagination ────────────────────────────────────────────────────────────────
const getPagination = (q) => {
  const page  = Math.max(1, parseInt(q.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

// ═══════════════════════════════════════════════════════════
//   PUBLIC: TRACK BY TRACKING NUMBER
//   GET /tracking/:trackingNumber
// ═══════════════════════════════════════════════════════════

exports.trackByNumber = async (req, res) => {
  const { trackingNumber } = req.params;
  if (!trackingNumber?.trim()) throw AppError.badRequest('Tracking number is required.');

  const data = await getTrackingInfo({ trackingNumber: trackingNumber.toUpperCase().trim() });
  if (!data) throw AppError.notFound(`No shipment found for tracking number "${trackingNumber}".`);

  ApiResponse.success(res, data, 'Tracking info retrieved.');
};

// ═══════════════════════════════════════════════════════════
//   AUTH: TRACK MY ORDER
//   GET /tracking/order/:orderId
// ═══════════════════════════════════════════════════════════

exports.trackMyOrder = async (req, res) => {
  const { orderId } = req.params;
  const userId      = req.user.id;

  // Verify order belongs to user
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId, deletedAt: null },
    select: { id: true, orderNumber: true, status: true, shippedAt: true },
  });

  if (!order) throw AppError.notFound('Order');

  // If not yet shipped, return order status only
  if (!['SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(order.status)) {
    return ApiResponse.success(res, {
      orderNumber:    order.orderNumber,
      status:         order.status,
      tracking:       null,
      message:        'Your order has not been shipped yet.',
    });
  }

  const data = await getTrackingInfo({ orderId, userId });
  if (!data) {
    return ApiResponse.success(res, {
      orderNumber: order.orderNumber,
      status:      order.status,
      tracking:    null,
      message:     'Tracking details will be available once the order is shipped.',
    });
  }

  ApiResponse.success(res, data, 'Order tracking info retrieved.');
};

// ═══════════════════════════════════════════════════════════
//   PUBLIC: LIST SUPPORTED COURIERS
//   GET /tracking/couriers
// ═══════════════════════════════════════════════════════════

exports.listCouriers = (req, res) => {
  const couriers = Object.entries(COURIERS).map(([key, c]) => ({
    key,
    name:  c.name,
    sla:   c.slaDay,
    hasTrackingLink: !!(c.trackingUrl && c.trackingUrl('SAMPLE') !== null),
  }));
  ApiResponse.success(res, couriers, `${couriers.length} supported couriers.`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: LIST ALL SHIPMENTS
//   GET /admin/tracking
// ═══════════════════════════════════════════════════════════

exports.adminListShipments = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const { status, courierName, from, to, q, late } = req.query;

  const where = {
    ...(status      && { status }),
    ...(courierName && { courierName: { contains: courierName, mode: 'insensitive' } }),
    ...((from || to) && {
      createdAt: {
        ...(from && { gte: new Date(from) }),
        ...(to   && { lte: new Date(to)   }),
      },
    }),
    ...(late === 'true' && {
      estimatedDelivery: { lt: new Date() },
      status: { notIn: ['DELIVERED', 'RETURNED', 'DELIVERY_FAILED'] },
    }),
    ...(q && {
      OR: [
        { trackingNumber: { contains: q.toUpperCase() } },
        { order: { orderNumber: { contains: q, mode: 'insensitive' } } },
        { order: { user: { name: { contains: q, mode: 'insensitive' } } } },
      ],
    }),
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      include: {
        order: {
          select: {
            id: true, orderNumber: true, status: true, total: true,
            user: { select: { name: true, phone: true } },
            shippingAddress: { select: { city: true, state: true, pincode: true } },
          },
        },
        checkpoints: { orderBy: { timestamp: 'desc' }, take: 1 },
        _count: { select: { checkpoints: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.shipment.count({ where }),
  ]);

  ApiResponse.paginated(res, shipments.map((s) => ({
    ...s,
    progress: getTrackingProgress(s.status),
    isLate:   s.estimatedDelivery && new Date() > new Date(s.estimatedDelivery) && !['DELIVERED', 'RETURNED'].includes(s.status),
  })), {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
    hasNext: page * limit < total,
    hasPrev: page > 1,
  }, `${total} shipment(s) found.`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: SHIPMENT DETAIL
//   GET /admin/tracking/:shipmentId
// ═══════════════════════════════════════════════════════════

exports.adminGetShipment = async (req, res) => {
  const shipment = await prisma.shipment.findUnique({
    where: { id: req.params.shipmentId },
    include: {
      checkpoints: { orderBy: { timestamp: 'asc' } },
      order: {
        include: {
          user:  { select: { id: true, name: true, email: true, phone: true } },
          items: { select: { productName: true, quantity: true, unitPrice: true, imageUrl: true } },
          shippingAddress: true,
        },
      },
    },
  });

  if (!shipment) throw AppError.notFound('Shipment');

  const courier = resolveCourier(shipment.courierName);

  ApiResponse.success(res, {
    ...shipment,
    courierInfo: {
      name:       courier.name,
      sla:        courier.slaDay,
      trackingUrl: shipment.trackingNumber ? courier.trackingUrl(shipment.trackingNumber) : null,
    },
    progress:    getTrackingProgress(shipment.status),
    isLate:      shipment.estimatedDelivery && new Date() > new Date(shipment.estimatedDelivery) && !['DELIVERED', 'RETURNED'].includes(shipment.status),
  });
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: ADD CHECKPOINT
//   POST /admin/tracking/:shipmentId/checkpoint
// ═══════════════════════════════════════════════════════════

exports.adminAddCheckpoint = async (req, res) => {
  const { shipmentId }  = req.params;
  const { status, description, location, timestamp, autoUpdateOrder = true } = req.body;

  const validStatuses = Object.keys(CHECKPOINT_EMOJIS);
  if (!validStatuses.includes(status)) {
    throw AppError.badRequest(
      `Invalid checkpoint status. Allowed: ${validStatuses.join(', ')}`,
      'INVALID_CHECKPOINT_STATUS'
    );
  }

  const checkpoint = await addCheckpoint({
    shipmentId,
    status,
    description,
    location,
    timestamp,
    addedBy: req.user.id,
    autoUpdateOrder,
  });

  // Clear tracking cache
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: { orderId: true, trackingNumber: true },
  });

  if (shipment) {
    await Promise.all([
      cache.del(`tracking:order:${shipment.orderId}`),
      shipment.trackingNumber ? cache.del(`tracking:id:${shipment.trackingNumber}`) : Promise.resolve(),
    ]);
  }

  logger.apiEvent('ADMIN_TRACKING_CHECKPOINT_ADDED', {
    adminId:    req.user.id,
    shipmentId,
    status,
    location,
  });

  ApiResponse.success(res, checkpoint, `Checkpoint "${status}" added to shipment.`, 201);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: UPDATE SHIPMENT STATUS
//   PATCH /admin/tracking/:shipmentId/status
// ═══════════════════════════════════════════════════════════

exports.adminUpdateShipmentStatus = async (req, res) => {
  const { shipmentId }  = req.params;
  const { status, description, location } = req.body;

  const validStatuses = Object.keys(CHECKPOINT_EMOJIS);
  if (!validStatuses.includes(status)) {
    throw AppError.badRequest(`Invalid status. Allowed: ${validStatuses.join(', ')}`);
  }

  // Delegates to addCheckpoint which also updates the shipment + order
  const checkpoint = await addCheckpoint({
    shipmentId,
    status,
    description: description || `Status updated to ${status.replace(/_/g, ' ')}`,
    location,
    addedBy: req.user.id,
    autoUpdateOrder: true,
  });

  logger.apiEvent('ADMIN_SHIPMENT_STATUS_UPDATED', {
    adminId: req.user.id,
    shipmentId,
    status,
  });

  ApiResponse.success(res, checkpoint, `Shipment status updated to "${status}".`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: SHIPMENT PERFORMANCE STATS
//   GET /admin/tracking/stats
// ═══════════════════════════════════════════════════════════

exports.adminShipmentStats = async (req, res) => {
  const { period = '30d' } = req.query;
  const days  = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [stats, avgDeliveryTime, todayDeliveries] = await Promise.all([
    getShipmentStats(since),

    // Average delivery time in days (shipped → delivered)
    prisma.$queryRaw`
      SELECT AVG(
        EXTRACT(EPOCH FROM (delivered_at - created_at)) / 86400
      )::numeric(6,2) as avg_days
      FROM shipments
      WHERE status = 'DELIVERED'
        AND delivered_at IS NOT NULL
        AND created_at >= ${since}
    `.catch(() => [{ avg_days: null }]),

    // Deliveries completed today
    prisma.shipment.count({
      where: {
        status:      'DELIVERED',
        deliveredAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);

  ApiResponse.success(res, {
    period,
    byStatus:         stats.byStatus,
    byCourier:        stats.byCourier,
    lateShipments:    stats.lateCount,
    avgDeliveryDays:  parseFloat(avgDeliveryTime[0]?.avg_days || 0),
    deliveredToday:   todayDeliveries,
  }, 'Shipment performance stats.');
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: LATE / OVERDUE SHIPMENTS
//   GET /admin/tracking/late
// ═══════════════════════════════════════════════════════════

exports.adminLateShipments = async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);

  const where = {
    estimatedDelivery: { lt: new Date() },
    status:            { notIn: ['DELIVERED', 'RETURNED', 'DELIVERY_FAILED'] },
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      include: {
        order: {
          select: {
            orderNumber: true, total: true,
            user: { select: { name: true, phone: true } },
          },
        },
        checkpoints: { orderBy: { timestamp: 'desc' }, take: 1 },
      },
      orderBy: { estimatedDelivery: 'asc' }, // Most overdue first
      skip,
      take: limit,
    }),
    prisma.shipment.count({ where }),
  ]);

  const enriched = shipments.map((s) => ({
    ...s,
    daysLate: Math.ceil((new Date() - new Date(s.estimatedDelivery)) / (1000 * 60 * 60 * 24)),
    progress: getTrackingProgress(s.status),
  }));

  ApiResponse.paginated(res, enriched, {
    page, limit, total,
    totalPages: Math.ceil(total / limit),
  }, `${total} overdue shipment(s).`);
};

// ═══════════════════════════════════════════════════════════
//   ADMIN: ASSIGN TRACKING TO ORDER
//   POST /admin/orders/:orderId/ship
// ═══════════════════════════════════════════════════════════

exports.adminShipOrder = async (req, res) => {
  const orderId = req.params.orderId || req.params.id;
  const {
    trackingNumber, courierName, courierUrl, estimatedDelivery,
    note, addPickupCheckpoint = true,
  } = req.body;

  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, status: true, orderNumber: true, userId: true },
  });

  if (!order) throw AppError.notFound('Order');

  const allowed = ['CONFIRMED', 'PROCESSING', 'PACKED'];
  if (!allowed.includes(order.status)) {
    throw AppError.badRequest(
      `Order must be in ${allowed.join('/')} to ship. Current: ${order.status}.`,
      'INVALID_ORDER_STATUS'
    );
  }

  const courier  = resolveCourier(courierName);
  const trackNum = trackingNumber || generateTrackingId();

  const [, shipment] = await prisma.$transaction([
    // Update order
    prisma.order.update({
      where: { id: orderId },
      data: {
        status:           'SHIPPED',
        trackingNumber:   trackNum,
        courierName:      courier.name || courierName,
        estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
        shippedAt:        new Date(),
        statusHistory: {
          create: {
            fromStatus: order.status,
            toStatus:   'SHIPPED',
            note:       note || `Shipped via ${courier.name}. Tracking: ${trackNum}`,
            changedBy:  req.user.id,
          },
        },
      },
    }),

    // Create shipment record
    prisma.shipment.upsert({
      where:  { orderId },
      update: { trackingNumber: trackNum, courierName: courier.name || courierName, courierUrl: courierUrl || courier.trackingUrl(trackNum), status: 'IN_TRANSIT', estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null },
      create: {
        orderId,
        trackingNumber:    trackNum,
        courierName:       courier.name || courierName,
        courierUrl:        courierUrl || courier.trackingUrl(trackNum),
        status:            'IN_TRANSIT',
        estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null,
        checkpoints: addPickupCheckpoint ? {
          create: {
            status:      'IN_TRANSIT',
            description: `Order dispatched via ${courier.name || courierName}`,
            location:    'Origin Facility',
            timestamp:   new Date(),
            addedBy:     req.user.id,
          },
        } : undefined,
      },
    }),
  ]);

  // Notify customer (non-blocking)
  setImmediate(async () => {
    try {
      const wa = require('../services/whatsapp.service');
      const notifService = require('../services/notification.service');
      const user = await prisma.user.findUnique({ where: { id: order.userId }, select: { phone: true, name: true } });

      await Promise.all([
        wa.notify.orderShipped(user, { ...order, trackingNumber: trackNum, courierName: courier.name, tracking: { courierUrl: shipment.courierUrl } }),
        notifService.createNotification({
          userId:  order.userId,
          type:    'ORDER_SHIPPED',
          title:   '🚚 Your order is on its way!',
          message: `Order #${order.orderNumber} shipped via ${courier.name}. Tracking: ${trackNum}`,
          data:    { orderId, trackingNumber: trackNum },
        }),
      ]);
    } catch (_) {}
  });

  logger.apiEvent('ADMIN_ORDER_SHIPPED', {
    adminId:       req.user.id,
    orderId,
    trackingNumber: trackNum,
    courierName:   courier.name,
  });

  ApiResponse.success(res, {
    trackingNumber: trackNum,
    courierName:    courier.name,
    courierUrl:     shipment.courierUrl,
    estimatedDelivery,
    shipmentId:     shipment.id,
  }, `Order #${order.orderNumber} shipped! Tracking: ${trackNum}`);
};
