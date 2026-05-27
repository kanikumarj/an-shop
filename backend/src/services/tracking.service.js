/**
 * services/tracking.service.js  [ENTERPRISE EDITION]
 * =====================================================
 * Core shipment tracking engine.
 *
 * RESPONSIBILITIES:
 *  - Tracking ID generation (format: TRK-YYYYMM-XXXXXX)
 *  - Shipment record lifecycle management
 *  - Tracking event (checkpoint) creation
 *  - Courier deep-link URL builder (Blue Dart, Delhivery, DTDC, Ekart, Xpressbees, India Post)
 *  - Customer-facing tracking data aggregation (privacy-safe)
 *  - Cache invalidation for tracking records
 *  - ETA estimation based on courier SLAs
 */

'use strict';

const crypto    = require('crypto');
const { prisma }= require('../config/database');
const { cache } = require('../config/redis');
const logger    = require('../utils/logger');
const AppError  = require('../utils/AppError');

// ─── Tracking ID Generator ─────────────────────────────────────────────────────
// Format: TRK-202605-A3F9B2
const generateTrackingId = () => {
  const now   = new Date();
  const ym    = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rand  = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `TRK-${ym}-${rand}`;
};
exports.generateTrackingId = generateTrackingId;

// ─── Courier Catalog ───────────────────────────────────────────────────────────
const COURIERS = {
  BLUEDART: {
    name:        'Blue Dart',
    trackingUrl: (id) => `https://www.bluedart.com/tracking?trackid=${id}`,
    slaDay:      { metro: 2, tier2: 3, tier3: 5 },
  },
  DELHIVERY: {
    name:        'Delhivery',
    trackingUrl: (id) => `https://www.delhivery.com/track/package/${id}`,
    slaDay:      { metro: 2, tier2: 3, tier3: 5 },
  },
  DTDC: {
    name:        'DTDC',
    trackingUrl: (id) => `https://www.dtdc.in/tracking/tracking_results_v2.asp?TType=T&Ttxt=${id}`,
    slaDay:      { metro: 3, tier2: 4, tier3: 7 },
  },
  EKART: {
    name:        'Ekart Logistics',
    trackingUrl: (id) => `https://ekartlogistics.com/track/${id}`,
    slaDay:      { metro: 2, tier2: 3, tier3: 5 },
  },
  XPRESSBEES: {
    name:        'Xpressbees',
    trackingUrl: (id) => `https://www.xpressbees.com/track?awb=${id}`,
    slaDay:      { metro: 2, tier2: 3, tier3: 6 },
  },
  INDIA_POST: {
    name:        'India Post',
    trackingUrl: (id) => `https://www.indiapost.gov.in/track-consignment?trackId=${id}`,
    slaDay:      { metro: 4, tier2: 6, tier3: 10 },
  },
  SHADOWFAX: {
    name:        'Shadowfax',
    trackingUrl: (id) => `https://track.shadowfax.in/?tracking_id=${id}`,
    slaDay:      { metro: 1, tier2: 2, tier3: 4 },
  },
  OTHER: {
    name:        'Courier Partner',
    trackingUrl: (id) => null,
    slaDay:      { metro: 5, tier2: 7, tier3: 10 },
  },
};
exports.COURIERS = COURIERS;

/**
 * Resolve courier info from name string (case-insensitive).
 */
const resolveCourier = (nameOrKey) => {
  if (!nameOrKey) return COURIERS.OTHER;
  const upper = nameOrKey.toUpperCase().replace(/[\s-]/g, '');
  const key   = Object.keys(COURIERS).find((k) =>
    k.replace(/[\s-]/g, '') === upper || COURIERS[k].name.toUpperCase().replace(/[\s-]/g, '') === upper
  );
  return COURIERS[key] || { ...COURIERS.OTHER, name: nameOrKey };
};
exports.resolveCourier = resolveCourier;

// ─── Tracking Event Emojis ─────────────────────────────────────────────────────
const CHECKPOINT_EMOJIS = {
  BOOKED:           '📋',
  PICKED_UP:        '🤝',
  IN_TRANSIT:       '🚌',
  REACHED_HUB:      '🏭',
  DISPATCHED:       '🚀',
  OUT_FOR_DELIVERY: '🏍️',
  DELIVERED:        '🏠',
  DELIVERY_FAILED:  '❌',
  RETURNED_TO_HUB:  '↩️',
  RETURNED:         '📦',
};
exports.CHECKPOINT_EMOJIS = CHECKPOINT_EMOJIS;

// ─── Shipment Status State Machine ────────────────────────────────────────────
const SHIPMENT_STATUS_ORDER = [
  'BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'REACHED_HUB', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED',
];

/**
 * Calculate the completion percentage for the tracking progress bar.
 */
const getTrackingProgress = (status) => {
  const idx  = SHIPMENT_STATUS_ORDER.indexOf(status);
  const last = SHIPMENT_STATUS_ORDER.length - 1;
  return idx < 0 ? 0 : Math.round((idx / last) * 100);
};
exports.getTrackingProgress = getTrackingProgress;

// ─── ETA Estimator ─────────────────────────────────────────────────────────────
const estimateETA = (courierNameOrKey, shippedAt, tier = 'tier2') => {
  const courier = resolveCourier(courierNameOrKey);
  const days    = courier.slaDay[tier] || courier.slaDay.tier2;
  const eta     = new Date(shippedAt);
  eta.setDate(eta.getDate() + days);
  return eta;
};
exports.estimateETA = estimateETA;

// ─── Cache Keys ────────────────────────────────────────────────────────────────
const trackingCacheKey  = (trackingId) => `tracking:id:${trackingId}`;
const shipmentCacheKey  = (orderId)    => `tracking:order:${orderId}`;

// ═══════════════════════════════════════════════════════════
//   CREATE SHIPMENT
// ═══════════════════════════════════════════════════════════

/**
 * Create or update a shipment record when an order is shipped.
 * Called from the admin ship-order flow.
 */
exports.createOrUpdateShipment = async (tx, {
  orderId, trackingNumber, courierName, courierUrl, estimatedDelivery, adminId,
}) => {
  const courier  = resolveCourier(courierName);
  const courierLink = courierUrl || (trackingNumber ? courier.trackingUrl(trackingNumber) : null);
  const eta      = estimatedDelivery
    ? new Date(estimatedDelivery)
    : estimateETA(courierName, new Date());

  const shipment = await tx.shipment.upsert({
    where:  { orderId },
    update: {
      trackingNumber,
      courierName: courier.name || courierName,
      courierUrl:  courierLink,
      status:      'IN_TRANSIT',
      estimatedDelivery: eta,
      updatedAt:   new Date(),
    },
    create: {
      orderId,
      trackingNumber: trackingNumber || generateTrackingId(),
      courierName:    courier.name || courierName,
      courierUrl:     courierLink,
      status:         'IN_TRANSIT',
      estimatedDelivery: eta,
      checkpoints: {
        create: {
          status:      'IN_TRANSIT',
          description: `Shipped via ${courier.name || courierName}`,
          location:    'Origin Facility',
          timestamp:   new Date(),
          addedBy:     adminId,
        },
      },
    },
  });

  // Clear caches
  await Promise.all([
    cache.del(shipmentCacheKey(orderId)),
    trackingNumber ? cache.del(trackingCacheKey(trackingNumber)) : Promise.resolve(),
  ]);

  return shipment;
};

// ═══════════════════════════════════════════════════════════
//   ADD TRACKING CHECKPOINT
// ═══════════════════════════════════════════════════════════

/**
 * Add a new tracking event (checkpoint) to a shipment.
 * Automatically updates the parent shipment status.
 */
exports.addCheckpoint = async ({
  orderId, shipmentId, status, description, location, timestamp, addedBy, autoUpdateOrder = true,
}) => {
  const shipment = await prisma.shipment.findFirst({
    where: {
      ...(shipmentId ? { id: shipmentId } : {}),
      ...(orderId    ? { orderId }         : {}),
    },
    select: { id: true, orderId: true },
  });

  if (!shipment) throw AppError.notFound('Shipment');

  // Create checkpoint
  const checkpoint = await prisma.trackingCheckpoint.create({
    data: {
      shipmentId: shipment.id,
      status,
      description: description || CHECKPOINT_EMOJIS[status] ? `${CHECKPOINT_EMOJIS[status]} ${status.replace(/_/g, ' ')}` : status,
      location:    location || null,
      timestamp:   timestamp ? new Date(timestamp) : new Date(),
      addedBy:     addedBy  || null,
    },
  });

  // Update shipment status
  await prisma.shipment.update({
    where: { id: shipment.id },
    data:  {
      status,
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
    },
  });

  // Update order status if delivery confirmed
  if (autoUpdateOrder && status === 'DELIVERED') {
    await prisma.order.update({
      where: { id: shipment.orderId },
      data:  { status: 'DELIVERED', deliveredAt: new Date() },
    });
  }
  if (autoUpdateOrder && status === 'OUT_FOR_DELIVERY') {
    await prisma.order.update({
      where: { id: shipment.orderId },
      data:  { status: 'OUT_FOR_DELIVERY' },
    });
  }

  // Clear caches
  await cache.del(shipmentCacheKey(shipment.orderId));

  logger.info('📍 Tracking checkpoint added:', { shipmentId: shipment.id, status, location });
  return checkpoint;
};

// ═══════════════════════════════════════════════════════════
//   GET TRACKING (customer-safe)
// ═══════════════════════════════════════════════════════════

/**
 * Fetch full tracking info for a given tracking number or orderId.
 * Returns privacy-safe data (no internal IDs exposed).
 */
exports.getTrackingInfo = async ({ trackingNumber, orderId, userId = null }) => {
  // Cache check
  const cacheKey = trackingNumber ? trackingCacheKey(trackingNumber) : shipmentCacheKey(orderId);
  const cached   = await cache.get(cacheKey);
  if (cached) return cached;

  const where = trackingNumber
    ? { trackingNumber }
    : { orderId };

  const shipment = await prisma.shipment.findFirst({
    where,
    include: {
      checkpoints: { orderBy: { timestamp: 'desc' } },
      order: {
        select: {
          id:           true,
          orderNumber:  true,
          status:       true,
          total:        true,
          estimatedDelivery: true,
          deliveredAt:  true,
          shippedAt:    true,
          userId:       true,
          shippingAddress: {
            select: { recipientName: true, city: true, state: true, pincode: true },
          },
          items: {
            take: 3,
            select: { productName: true, quantity: true, imageUrl: true },
          },
        },
      },
    },
  });

  if (!shipment) return null;

  // Privacy check — only owner can see their tracking
  if (userId && shipment.order.userId !== userId) {
    throw AppError.forbidden('Access denied to this shipment.');
  }

  const courier  = resolveCourier(shipment.courierName);
  const progress = getTrackingProgress(shipment.status);
  const isLate   = shipment.estimatedDelivery
    && new Date() > new Date(shipment.estimatedDelivery)
    && !['DELIVERED', 'RETURNED'].includes(shipment.status);

  const result = {
    trackingNumber: shipment.trackingNumber,
    courierId:      Object.keys(COURIERS).find((k) => COURIERS[k].name === shipment.courierName) || 'OTHER',
    courierName:    shipment.courierName,
    courierUrl:     shipment.courierUrl,
    status:         shipment.status,
    progress,
    isLate,
    estimatedDelivery: shipment.estimatedDelivery,
    deliveredAt:    shipment.deliveredAt,
    shippedAt:      shipment.order.shippedAt,
    order: {
      id:          shipment.order.id,
      orderNumber: shipment.order.orderNumber,
      status:      shipment.order.status,
      items:       shipment.order.items,
      total:       shipment.order.total,
      deliveryAddress: shipment.order.shippingAddress
        ? `${shipment.order.shippingAddress.city}, ${shipment.order.shippingAddress.state} - ${shipment.order.shippingAddress.pincode}`
        : null,
      recipientName: shipment.order.shippingAddress?.recipientName || null,
    },
    checkpoints: shipment.checkpoints.map((c) => ({
      status:      c.status,
      description: c.description,
      location:    c.location,
      timestamp:   c.timestamp,
      emoji:       CHECKPOINT_EMOJIS[c.status] || '📍',
    })),
    statusSummary: SHIPMENT_STATUS_ORDER.map((s, i) => ({
      step:      i + 1,
      status:    s,
      label:     s.replace(/_/g, ' '),
      emoji:     CHECKPOINT_EMOJIS[s] || '📍',
      completed: SHIPMENT_STATUS_ORDER.indexOf(shipment.status) >= i,
      current:   shipment.status === s,
    })),
  };

  // Cache for 5 minutes (tracking data changes frequently)
  await cache.set(cacheKey, result, 300);
  return result;
};

// ═══════════════════════════════════════════════════════════
//   BULK SHIPMENT STATUS (admin dashboard widget)
// ═══════════════════════════════════════════════════════════

exports.getShipmentStats = async (since) => {
  const sinceDate = since || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [statusBreakdown, lateDiveries, courierBreakdown] = await Promise.all([
    prisma.shipment.groupBy({
      by:    ['status'],
      where: { createdAt: { gte: sinceDate } },
      _count: { id: true },
    }),
    prisma.shipment.count({
      where: {
        estimatedDelivery: { lt: new Date() },
        status: { notIn: ['DELIVERED', 'RETURNED', 'DELIVERY_FAILED'] },
      },
    }),
    prisma.shipment.groupBy({
      by:    ['courierName'],
      where: { createdAt: { gte: sinceDate } },
      _count: { id: true },
    }),
  ]);

  return {
    byStatus:  statusBreakdown.reduce((acc, s) => { acc[s.status] = s._count.id; return acc; }, {}),
    lateCount: lateDiveries,
    byCourier: courierBreakdown.map((c) => ({ courier: c.courierName, count: c._count.id })),
  };
};
