/**
 * services/order.service.js
 * ==========================
 * Order management business logic — separated from HTTP controllers.
 *
 * Responsibilities:
 *   - Sequential order number generation (ORD-2026-000001)
 *   - Order total calculation (subtotal, coupon, shipping, tax)
 *   - Status transition validation (state machine)
 *   - Stock deduction / restoration (atomic, transactional)
 *   - Address snapshot (preserve at order time)
 *   - Coupon usage recording
 *   - Invoice generation (plain-text HTML for PDF)
 *   - Cache invalidation
 */

'use strict';

const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const { roundTo } = require('../utils/helpers');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ═══════════════════════════════════════════════════════════
//   ORDER NUMBER GENERATOR — ORD-2026-000001
// ═══════════════════════════════════════════════════════════

/**
 * Generate a sequential, human-readable order number.
 * Format: ORD-YYYY-NNNNNN (zero-padded 6 digits, resets per year)
 *
 * Uses DB count to determine sequence — concurrency-safe because
 * the DB unique constraint on orderNumber will reject duplicates.
 */
const generateOrderNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;

  // Count orders for this year to determine next sequence number
  const count = await prisma.order.count({
    where: {
      orderNumber: { startsWith: prefix },
    },
  });

  const sequence = String(count + 1).padStart(6, '0');
  return `${prefix}${sequence}`;
};

// ═══════════════════════════════════════════════════════════
//   ORDER STATUS STATE MACHINE
// ═══════════════════════════════════════════════════════════

/**
 * Valid status transitions.
 * Each key is the CURRENT status; value is an array of ALLOWED next statuses.
 * Admin can override; customers have more restrictions.
 */
const STATUS_TRANSITIONS = {
  DRAFT:               ['PENDING', 'CANCELLED'],
  PENDING:             ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING:     ['SCREENSHOT_UPLOADED', 'CANCELLED'],
  SCREENSHOT_UPLOADED: ['PAYMENT_VERIFIED', 'PAYMENT_REJECTED'],
  PAYMENT_REJECTED:    ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_VERIFIED:    ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:           ['PROCESSING', 'CANCELLED'],
  PROCESSING:          ['PACKED', 'CANCELLED'],
  PACKED:              ['SHIPPED', 'CANCELLED'],
  SHIPPED:             ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY:    ['DELIVERED', 'RETURNED'],
  DELIVERED:           ['REFUND_REQUESTED', 'RETURNED'],
  CANCELLED:           ['PENDING'],         // Admin can re-open
  REFUND_REQUESTED:    ['REFUNDED', 'CANCELLED'],
  REFUNDED:            [],
  RETURNED:            ['REFUNDED'],
};

/** Statuses customers are allowed to cancel from */
const CUSTOMER_CANCELLABLE = ['PENDING', 'PAYMENT_PENDING', 'CONFIRMED'];

/** Statuses that are terminal (no further changes allowed for customer) */
const TERMINAL_STATUSES = ['DELIVERED', 'REFUNDED', 'RETURNED', 'CANCELLED'];

/**
 * Validate a status transition.
 * @param {string} from  — Current status
 * @param {string} to    — Desired next status
 * @param {boolean} isAdmin — Admins can make some restricted transitions
 */
const validateStatusTransition = (from, to, isAdmin = false) => {
  const allowed = STATUS_TRANSITIONS[from] || [];

  if (!allowed.includes(to)) {
    if (isAdmin && from !== to) {
      // Admins can force any transition (with a warning logged)
      logger.warn('⚠️ Admin forced non-standard status transition', { from, to });
      return; // Allow with warning
    }
    throw AppError.badRequest(
      `Cannot transition order from "${from}" to "${to}".`,
      'INVALID_STATUS_TRANSITION'
    );
  }
};

// ═══════════════════════════════════════════════════════════
//   ORDER TOTALS CALCULATOR
// ═══════════════════════════════════════════════════════════

/**
 * Calculate full order financials from cart items + coupon + address.
 * @param {Array} cartItems     — Enriched cart items (with price, variant, product)
 * @param {object|null} coupon  — Validated coupon object (or null)
 * @returns {object} Complete financial breakdown
 */
const calculateOrderTotals = (cartItems, coupon = null) => {
  let subtotal = 0;
  let totalTax = 0;
  const orderItems = [];

  for (const item of cartItems) {
    const { product, variant, quantity } = item;

    const unitPrice    = parseFloat(variant?.price ?? product.basePrice);
    const comparePrice = parseFloat(variant?.comparePrice ?? product.comparePrice ?? 0) || null;
    const taxPercent   = parseFloat(product.taxPercent) || 0;

    const lineSubtotal  = roundTo(unitPrice * quantity);
    const lineTaxAmount = product.taxInclusive
      ? roundTo(lineSubtotal - lineSubtotal / (1 + taxPercent / 100))
      : roundTo(lineSubtotal * taxPercent / 100);

    subtotal += lineSubtotal;
    totalTax += lineTaxAmount;

    orderItems.push({
      productId:    product.id,
      variantId:    variant?.id || null,
      productName:  product.name,
      variantName:  variant?.name || null,
      productSku:   variant?.sku || product.sku || '',
      imageUrl:     product.images?.[0]?.url || null,
      unitPrice,
      comparePrice,
      taxPercent,
      quantity,
      subtotal:     lineSubtotal,
      discountAmount: 0,
      total:        lineSubtotal,
    });
  }

  subtotal = roundTo(subtotal);

  // Apply coupon discount
  let couponDiscount = 0;
  let couponId       = null;
  let couponCode     = null;

  if (coupon?.valid) {
    couponDiscount = roundTo(Math.min(coupon.discount, subtotal));
    couponId       = coupon.couponId;
    couponCode     = coupon.code;
  }

  const afterCoupon     = roundTo(subtotal - couponDiscount);
  const shippingCharge  = roundTo(
    afterCoupon >= (parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 500)
      ? 0
      : (parseFloat(process.env.DEFAULT_SHIPPING_CHARGE) || 50)
  );

  // If coupon type is FREE_SHIPPING, waive shipping
  if (coupon?.type === 'FREE_SHIPPING') {
    // shipping already covered in couponDiscount
  }

  const total = roundTo(afterCoupon + shippingCharge);

  return {
    subtotal,
    couponDiscount,
    couponId,
    couponCode,
    shippingCharge,
    taxAmount: roundTo(totalTax),
    discountAmount: 0,
    total,
    orderItems,
  };
};

// ═══════════════════════════════════════════════════════════
//   ADDRESS SNAPSHOT
// ═══════════════════════════════════════════════════════════

/**
 * Create an immutable snapshot of the delivery address at order time.
 * Stored as JSON on the order — survives address deletion.
 */
const createAddressSnapshot = (address) => {
  if (!address) return null;
  return {
    id:           address.id,
    type:         address.type,
    fullName:     address.fullName,
    phone:        address.phone,
    alternatePhone: address.alternatePhone || null,
    line1:        address.line1,
    line2:        address.line2 || null,
    landmark:     address.landmark || null,
    city:         address.city,
    state:        address.state,
    pincode:      address.pincode,
    country:      address.country || 'India',
  };
};

// ═══════════════════════════════════════════════════════════
//   STOCK OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Atomically deduct stock from all order items within a transaction.
 * Throws if any product has insufficient stock.
 */
const deductStockForOrder = async (tx, cartItems) => {
  for (const item of cartItems) {
    const { product, variant, quantity } = item;

    if (variant) {
      // Check stock
      const freshVariant = await tx.productVariant.findUnique({
        where: { id: variant.id },
        select: { stock: true, name: true },
      });

      if (!freshVariant || freshVariant.stock < quantity) {
        throw AppError.badRequest(
          `Insufficient stock for "${product.name} - ${variant.name}". Only ${freshVariant?.stock || 0} left.`,
          'INSUFFICIENT_STOCK'
        );
      }

      await tx.productVariant.update({
        where: { id: variant.id },
        data: { stock: { decrement: quantity } },
      });
    } else {
      // Check stock
      const freshProduct = await tx.product.findUnique({
        where: { id: product.id },
        select: { stock: true, allowBackorder: true, name: true },
      });

      if (!freshProduct || (!freshProduct.allowBackorder && freshProduct.stock < quantity)) {
        throw AppError.badRequest(
          `Insufficient stock for "${product.name}". Only ${freshProduct?.stock || 0} left.`,
          'INSUFFICIENT_STOCK'
        );
      }

      await tx.product.update({
        where: { id: product.id },
        data: {
          stock:     { decrement: quantity },
          totalSold: { increment: quantity },
        },
      });
    }
  }
};

/**
 * Restore stock when an order is cancelled or returned.
 */
const restoreStockForOrder = async (tx, orderItems) => {
  for (const item of orderItems) {
    if (item.variantId) {
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } },
      });
    } else {
      await tx.product.update({
        where: { id: item.productId },
        data: {
          stock:     { increment: item.quantity },
          totalSold: { decrement: item.quantity },
        },
      });
    }
  }
};

// ═══════════════════════════════════════════════════════════
//   COUPON USAGE
// ═══════════════════════════════════════════════════════════

/**
 * Record coupon usage (increment global counter + create usage record).
 * Called within order creation transaction.
 */
const recordCouponUsage = async (tx, couponId, userId, orderId) => {
  if (!couponId) return;

  await Promise.all([
    tx.coupon.update({
      where: { id: couponId },
      data: { currentUsageCount: { increment: 1 } },
    }),
    tx.couponUsage.create({
      data: { couponId, userId, orderId },
    }),
  ]);
};

// ═══════════════════════════════════════════════════════════
//   CACHE INVALIDATION
// ═══════════════════════════════════════════════════════════

const invalidateOrderCache = async (userId, orderId = null) => {
  const keys = [`orders:user:${userId}:*`];
  if (orderId) keys.push(`order:${orderId}`);
  await cache.delPattern(`orders:user:${userId}:*`);
  if (orderId) await cache.del(`order:${orderId}`);
};

// ═══════════════════════════════════════════════════════════
//   INVOICE DATA BUILDER
// ═══════════════════════════════════════════════════════════

/**
 * Build a structured invoice data object for HTML/PDF generation.
 */
const buildInvoiceData = (order, user) => {
  const address = order.shippingAddress || order.address;
  const issuedAt = new Date();

  return {
    invoiceNumber: `INV-${order.orderNumber}`,
    issuedAt,
    issuedAtFormatted: issuedAt.toLocaleDateString('en-IN', {
      year: 'numeric', month: 'long', day: 'numeric',
    }),
    order: {
      id:          order.id,
      orderNumber: order.orderNumber,
      placedAt:    order.placedAt || order.createdAt,
      status:      order.status,
      paymentMethod: order.paymentMethod,
    },
    seller: {
      name:    process.env.STORE_NAME    || 'An Shop',
      tagline: process.env.STORE_TAGLINE || 'Premium Homemade Snacks',
      address: process.env.STORE_ADDRESS || 'Maharashtra, India',
      phone:   process.env.STORE_PHONE   || '',
      email:   process.env.STORE_EMAIL   || '',
      fssai:   process.env.STORE_FSSAI   || '',
      gstin:   process.env.STORE_GSTIN   || '',
    },
    customer: {
      name:  user?.name  || 'Customer',
      email: user?.email || '',
      phone: user?.phone || '',
    },
    shippingAddress: address
      ? {
          fullName: address.fullName,
          phone:    address.phone,
          line1:    address.line1,
          line2:    address.line2 || '',
          landmark: address.landmark || '',
          city:     address.city,
          state:    address.state,
          pincode:  address.pincode,
          country:  address.country || 'India',
        }
      : null,
    items: (order.items || []).map((item) => ({
      name:       item.productName,
      variant:    item.variantName || '',
      sku:        item.productSku  || '',
      qty:        item.quantity,
      unitPrice:  parseFloat(item.unitPrice),
      taxPercent: parseFloat(item.taxPercent),
      subtotal:   parseFloat(item.subtotal),
      total:      parseFloat(item.total),
    })),
    pricing: {
      subtotal:      parseFloat(order.subtotal),
      discount:      parseFloat(order.discountAmount || 0),
      couponCode:    order.couponCode || null,
      couponDiscount: parseFloat(order.couponDiscount || 0),
      shipping:      parseFloat(order.shippingCharge),
      tax:           parseFloat(order.taxAmount),
      total:         parseFloat(order.total),
    },
  };
};

/**
 * Render invoice as HTML string.
 * Frontend can print this or convert to PDF via Puppeteer/WeasyPrint.
 */
const renderInvoiceHtml = (data) => {
  const itemRows = data.items.map((item) => `
    <tr>
      <td class="item-name">
        <strong>${item.name}</strong>
        ${item.variant ? `<br><span class="variant">${item.variant}</span>` : ''}
        ${item.sku ? `<br><small class="sku">SKU: ${item.sku}</small>` : ''}
      </td>
      <td class="center">${item.qty}</td>
      <td class="right">₹${item.unitPrice.toFixed(2)}</td>
      <td class="right">₹${item.total.toFixed(2)}</td>
    </tr>
  `).join('');

  const addressHtml = data.shippingAddress ? `
    <div class="address-block">
      <strong>${data.shippingAddress.fullName}</strong><br>
      ${data.shippingAddress.line1}<br>
      ${data.shippingAddress.line2 ? data.shippingAddress.line2 + '<br>' : ''}
      ${data.shippingAddress.landmark ? `Near ${data.shippingAddress.landmark}<br>` : ''}
      ${data.shippingAddress.city}, ${data.shippingAddress.state} - ${data.shippingAddress.pincode}<br>
      ${data.shippingAddress.country}<br>
      <strong>Ph:</strong> ${data.shippingAddress.phone}
    </div>
  ` : '<p>No address on file.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice ${data.invoiceNumber} — ${data.seller.name}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 30px; }
    .invoice-wrapper { max-width: 800px; margin: 0 auto; border: 1px solid #e5e5e5; border-radius: 8px; overflow: hidden; }

    /* Header */
    .invoice-header { background: linear-gradient(135deg, #2d1b4e, #6b35a0); color: #fff; padding: 32px 36px; display: flex; justify-content: space-between; align-items: flex-start; }
    .store-name { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .store-tagline { font-size: 11px; opacity: 0.75; margin-top: 4px; }
    .invoice-meta { text-align: right; }
    .invoice-title { font-size: 22px; font-weight: 700; }
    .invoice-number { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    .invoice-date { font-size: 11px; opacity: 0.7; margin-top: 3px; }

    /* Body */
    .invoice-body { padding: 28px 36px; }

    /* Party info */
    .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
    .party-block h4 { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
    .party-block p, .address-block { font-size: 13px; line-height: 1.7; color: #333; }
    .address-block strong { color: #1a1a1a; }

    /* Order info bar */
    .order-info-bar { background: #f8f6ff; border: 1px solid #e8e0f5; border-radius: 6px; padding: 12px 20px; display: flex; gap: 32px; margin-bottom: 28px; flex-wrap: wrap; }
    .order-info-bar .info-item label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: #888; display: block; }
    .order-info-bar .info-item span { font-weight: 600; color: #2d1b4e; font-size: 13px; }

    /* Items table */
    table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
    thead tr { background: #2d1b4e; color: #fff; }
    thead th { padding: 10px 14px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; }
    thead th.center { text-align: center; }
    thead th.right  { text-align: right; }
    tbody tr { border-bottom: 1px solid #f0f0f0; }
    tbody tr:last-child { border-bottom: none; }
    tbody td { padding: 12px 14px; vertical-align: top; }
    tbody td.center { text-align: center; }
    tbody td.right  { text-align: right; }
    .item-name .variant { color: #666; font-size: 12px; }
    .item-name .sku { color: #999; font-size: 11px; }

    /* Totals */
    .totals-wrapper { display: flex; justify-content: flex-end; }
    .totals-table { width: 280px; }
    .totals-table td { padding: 6px 0; font-size: 13px; }
    .totals-table td:last-child { text-align: right; font-weight: 500; }
    .totals-table .divider td { border-top: 1px solid #e5e5e5; padding-top: 10px; }
    .totals-table .total-row td { font-size: 16px; font-weight: 800; color: #2d1b4e; padding-top: 10px; }
    .totals-table .discount-row td { color: #22a06b; }
    .totals-table .free-shipping td { color: #22a06b; }

    /* Footer */
    .invoice-footer { background: #fafafa; border-top: 1px solid #e5e5e5; padding: 20px 36px; font-size: 11px; color: #888; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    .invoice-footer .badge { background: #2d1b4e; color: #fff; padding: 3px 10px; border-radius: 20px; font-size: 10px; font-weight: 600; }

    /* Print */
    @media print {
      body { padding: 0; }
      .invoice-wrapper { border: none; border-radius: 0; }
      @page { margin: 15mm; }
    }
  </style>
</head>
<body>
  <div class="invoice-wrapper">

    <!-- HEADER -->
    <div class="invoice-header">
      <div>
        <div class="store-name">${data.seller.name}</div>
        <div class="store-tagline">${data.seller.tagline}</div>
        ${data.seller.fssai ? `<div style="margin-top:6px;font-size:10px;opacity:.7">FSSAI: ${data.seller.fssai}</div>` : ''}
        ${data.seller.gstin ? `<div style="font-size:10px;opacity:.7">GSTIN: ${data.seller.gstin}</div>` : ''}
      </div>
      <div class="invoice-meta">
        <div class="invoice-title">INVOICE</div>
        <div class="invoice-number">${data.invoiceNumber}</div>
        <div class="invoice-date">Issued: ${data.issuedAtFormatted}</div>
      </div>
    </div>

    <!-- BODY -->
    <div class="invoice-body">

      <!-- Parties -->
      <div class="parties">
        <div class="party-block">
          <h4>From (Seller)</h4>
          <p>
            <strong>${data.seller.name}</strong><br>
            ${data.seller.address}<br>
            ${data.seller.phone ? `Ph: ${data.seller.phone}<br>` : ''}
            ${data.seller.email ? `${data.seller.email}<br>` : ''}
          </p>
        </div>
        <div class="party-block">
          <h4>Bill To (Customer)</h4>
          <p>
            <strong>${data.customer.name}</strong><br>
            ${data.customer.email}<br>
            ${data.customer.phone}
          </p>
        </div>
      </div>

      <!-- Ship to -->
      <div style="margin-bottom:28px;">
        <div class="party-block">
          <h4>Ship To</h4>
          ${addressHtml}
        </div>
      </div>

      <!-- Order Info Bar -->
      <div class="order-info-bar">
        <div class="info-item">
          <label>Order Number</label>
          <span>${data.order.orderNumber}</span>
        </div>
        <div class="info-item">
          <label>Order Date</label>
          <span>${new Date(data.order.placedAt).toLocaleDateString('en-IN')}</span>
        </div>
        <div class="info-item">
          <label>Payment</label>
          <span>${data.order.paymentMethod?.replace('_', ' ') || 'N/A'}</span>
        </div>
        <div class="info-item">
          <label>Status</label>
          <span>${data.order.status?.replace('_', ' ')}</span>
        </div>
      </div>

      <!-- Line Items -->
      <table>
        <thead>
          <tr>
            <th style="width:55%">Item</th>
            <th class="center" style="width:10%">Qty</th>
            <th class="right" style="width:17.5%">Unit Price</th>
            <th class="right" style="width:17.5%">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      <!-- Totals -->
      <div class="totals-wrapper">
        <table class="totals-table">
          <tbody>
            <tr>
              <td>Subtotal</td>
              <td>₹${data.pricing.subtotal.toFixed(2)}</td>
            </tr>
            ${data.pricing.discount > 0 ? `
            <tr class="discount-row">
              <td>Discount</td>
              <td>−₹${data.pricing.discount.toFixed(2)}</td>
            </tr>` : ''}
            ${data.pricing.couponDiscount > 0 ? `
            <tr class="discount-row">
              <td>Coupon (${data.pricing.couponCode})</td>
              <td>−₹${data.pricing.couponDiscount.toFixed(2)}</td>
            </tr>` : ''}
            <tr class="${data.pricing.shipping === 0 ? 'free-shipping' : ''}">
              <td>Shipping</td>
              <td>${data.pricing.shipping === 0 ? 'FREE' : `₹${data.pricing.shipping.toFixed(2)}`}</td>
            </tr>
            ${data.pricing.tax > 0 ? `
            <tr>
              <td>GST (incl.)</td>
              <td>₹${data.pricing.tax.toFixed(2)}</td>
            </tr>` : ''}
            <tr class="divider"></tr>
            <tr class="total-row">
              <td>Total Paid</td>
              <td>₹${data.pricing.total.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </div>

    </div><!-- /invoice-body -->

    <!-- FOOTER -->
    <div class="invoice-footer">
      <div>
        <span class="badge">Thank you for your order!</span>
        <span style="margin-left:12px;">This is a computer-generated invoice.</span>
      </div>
      <div>${data.seller.name} · ${data.seller.address}</div>
    </div>

  </div>
</body>
</html>`;
};

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  generateOrderNumber,
  STATUS_TRANSITIONS,
  CUSTOMER_CANCELLABLE,
  TERMINAL_STATUSES,
  validateStatusTransition,
  calculateOrderTotals,
  createAddressSnapshot,
  deductStockForOrder,
  restoreStockForOrder,
  recordCouponUsage,
  invalidateOrderCache,
  buildInvoiceData,
  renderInvoiceHtml,
};
