/**
 * services/email.service.js  [ENTERPRISE EDITION]
 * ==================================================
 * Production-grade email infrastructure.
 *
 * FEATURES:
 *   - Nodemailer with SMTP pooling (5 connections, 5 msgs/sec rate cap)
 *   - Redis-backed job queue with 3-attempt exponential backoff retry
 *   - 12 rich HTML templates (welcome, OTP, order, payment, shipment, admin)
 *   - IST-formatted dates throughout
 *   - Graceful fallback: logs failure, never crashes server
 *   - Admin email helper for operational alerts
 *   - Background queue processor (no blocking the main thread)
 *
 * QUEUE FORMAT (Redis list → email:queue):
 *   { id, to, subject, html, text, priority, attempts, createdAt }
 *
 * USAGE:
 *   const email = require('./email.service');
 *   await email.sendOrderConfirmation(user.email, order);
 *   await email.sendOTPEmail(user.email, otp);
 *   await email.enqueue({ to, subject, html });   // custom
 */

'use strict';

const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const logger     = require('../utils/logger');
const { formatCurrency } = require('../utils/helpers');

// ─── Shop Meta ─────────────────────────────────────────────────────────────────
const SHOP = {
  name:    process.env.SHOP_NAME    || 'An Shop',
  email:   process.env.SHOP_EMAIL   || 'hello@anshop.in',
  phone:   process.env.SHOP_PHONE   || '+91 98765 43210',
  address: process.env.SHOP_ADDRESS || 'India',
  url:     process.env.FRONTEND_URL || 'https://anshop.in',
  logo:    process.env.SHOP_LOGO_URL|| '',
  primary: '#e94560',
  dark:    '#1a1a2e',
};

// ─── IST Date Formatter ────────────────────────────────────────────────────────
const toIST = (date) => new Date(date).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

const toISTDate = (date) => new Date(date).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: 'short', year: 'numeric',
});

// ─── SMTP Transporter (pooled) ─────────────────────────────────────────────────
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    logger.warn('⚠️ Email: SMTP not configured (SMTP_HOST / SMTP_USER missing)');
    return null;
  }

  transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    pool:           true,       // Connection pooling
    maxConnections: 5,
    maxMessages:    100,
    rateDelta:      1000,       // 1 second window
    rateLimit:      5,          // Max 5 msgs/sec (Gmail/SMTP limit)
    socketTimeout:  10000,
    greetingTimeout:10000,
  });

  transporter.verify((err) => {
    if (err) logger.warn('⚠️ Email transporter verify failed:', { error: err.message });
    else     logger.info('✅ Email transporter ready');
  });

  return transporter;
};

// ═══════════════════════════════════════════════════════════
//   REDIS QUEUE SYSTEM
// ═══════════════════════════════════════════════════════════

const QUEUE_KEY    = 'email:queue';
const DLQ_KEY      = 'email:dlq';         // Dead-letter queue (failed after max retries)
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [5, 30, 120];        // Seconds: 5s, 30s, 2min

/**
 * Enqueue an email job. Stored in Redis list.
 * If Redis is unavailable, sends directly (fallback).
 */
const enqueue = async ({ to, subject, html, text, priority = 'normal' }) => {
  const job = {
    id:        crypto.randomUUID(),
    to,
    subject,
    html,
    text:      text || 'Please view this email in an HTML-compatible email client.',
    priority,
    attempts:  0,
    createdAt: new Date().toISOString(),
  };

  try {
    const { redis } = require('../config/redis');
    if (redis) {
      // High priority → right side (RPUSH), normal → left side (LPUSH) — FIFO with priority
      if (priority === 'high') {
        await redis.rpush(QUEUE_KEY, JSON.stringify(job));
      } else {
        await redis.lpush(QUEUE_KEY, JSON.stringify(job));
      }
      logger.info(`📧 Email queued: ${subject} → ${to} [${job.id}]`);
      return job.id;
    }
  } catch (err) {
    logger.warn('⚠️ Email queue unavailable — sending directly:', { error: err.message });
  }

  // Fallback: direct send
  await sendDirect({ to, subject, html, text: job.text });
  return null;
};

/**
 * Direct SMTP send (no queue). Used as fallback and by queue processor.
 */
const sendDirect = async ({ to, subject, html, text }) => {
  const smtp = getTransporter();
  if (!smtp) {
    logger.warn(`📵 Email skipped (no SMTP): ${subject} → ${to}`);
    return null;
  }

  const info = await smtp.sendMail({
    from:    `"${SHOP.name}" <${process.env.EMAIL_FROM || SHOP.email}>`,
    to,
    subject,
    html,
    text,
  });

  logger.info('📧 Email sent:', { to, subject, messageId: info.messageId });
  return info;
};

// ═══════════════════════════════════════════════════════════
//   QUEUE PROCESSOR — called from cron job or startup
// ═══════════════════════════════════════════════════════════

/**
 * Process the email queue (batch of up to `batchSize` messages).
 * Call from a cron job: every minute.
 */
const processQueue = async (batchSize = 10) => {
  let processed = 0;
  let failed    = 0;

  try {
    const { redis } = require('../config/redis');
    if (!redis) return { processed, failed };

    for (let i = 0; i < batchSize; i++) {
      const raw = await redis.rpop(QUEUE_KEY);
      if (!raw) break;

      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        continue;
      }

      try {
        await sendDirect(job);
        processed++;
      } catch (err) {
        job.attempts++;
        job.lastError = err.message;
        job.lastAttemptAt = new Date().toISOString();

        if (job.attempts < MAX_ATTEMPTS) {
          const delay = RETRY_DELAYS[job.attempts - 1] || 120;
          // Re-queue with delay using sorted set (score = unix timestamp to send at)
          const sendAt = Math.floor(Date.now() / 1000) + delay;
          await redis.zadd('email:retry', sendAt, JSON.stringify(job));
          logger.warn(`⚠️ Email retry scheduled in ${delay}s: ${job.subject} → ${job.to} (attempt ${job.attempts}/${MAX_ATTEMPTS})`);
        } else {
          // Move to dead-letter queue
          await redis.lpush(DLQ_KEY, JSON.stringify(job));
          logger.error(`❌ Email permanently failed (DLQ): ${job.subject} → ${job.to}`);
        }
        failed++;
      }
    }

    // Process retries that are now due
    const now    = Math.floor(Date.now() / 1000);
    const retries = await redis.zrangebyscore('email:retry', 0, now, 'LIMIT', 0, 5);
    for (const raw of retries) {
      await redis.zrem('email:retry', raw);
      await redis.lpush(QUEUE_KEY, raw); // Back to main queue
    }

  } catch (err) {
    logger.error('❌ Email queue processor error:', { error: err.message });
  }

  if (processed + failed > 0) {
    logger.info(`📧 Email batch: ${processed} sent, ${failed} failed/retried`);
  }

  return { processed, failed };
};

// ═══════════════════════════════════════════════════════════
//   BASE HTML TEMPLATE
// ═══════════════════════════════════════════════════════════

const baseTemplate = (content, { preheader = '' } = {}) => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${SHOP.name}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f0f2f5; font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; color: #333; }
    .wrapper { max-width: 600px; margin: 30px auto; }
    .header { background: linear-gradient(135deg, ${SHOP.dark} 0%, ${SHOP.primary} 100%); padding: 32px; text-align: center; border-radius: 16px 16px 0 0; }
    .header h1 { color: #fff; font-size: 26px; font-weight: 700; margin: 0; letter-spacing: 1px; }
    .header p  { color: rgba(255,255,255,0.75); margin: 6px 0 0; font-size: 13px; }
    .body  { background: #fff; padding: 36px 40px; }
    .footer{ background: #f7f7f7; padding: 20px; text-align: center; border-radius: 0 0 16px 16px; font-size: 12px; color: #999; line-height: 1.7; }
    h2  { font-size: 22px; color: ${SHOP.dark}; margin-bottom: 12px; }
    p   { line-height: 1.7; margin-bottom: 14px; color: #555; }
    .btn { display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, ${SHOP.primary}, #c13150); color: #fff !important; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 16px 0; }
    .card { background: #f9f9f9; border: 1px solid #eee; border-radius: 10px; padding: 20px; margin: 18px 0; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; }
    .badge-success { background: #e8f5e9; color: #2e7d32; }
    .badge-warning { background: #fff8e1; color: #f57f17; }
    .badge-danger  { background: #fce4ec; color: #c62828; }
    .badge-info    { background: #e3f2fd; color: #1565c0; }
    table.items  { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    table.items th { background: #f5f5f5; padding: 10px; text-align: left; color: #666; font-weight: 600; }
    table.items td { padding: 10px; border-bottom: 1px solid #f0f0f0; }
    table.items tr.total td { font-weight: 700; background: #fff5f5; }
    .otp-box { text-align: center; padding: 28px; background: linear-gradient(135deg, #fff5f5, #fff); border: 2px dashed ${SHOP.primary}; border-radius: 12px; margin: 24px 0; }
    .otp-box .otp { font-size: 44px; font-weight: 900; letter-spacing: 14px; color: ${SHOP.primary}; }
    .track-steps { display: flex; justify-content: space-between; margin: 20px 0; }
    .step { text-align: center; font-size: 11px; }
    .step .dot { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; margin-bottom: 4px; }
    .dot-done { background: #e8f5e9; }
    .dot-curr { background: ${SHOP.primary}; }
    .dot-pend { background: #f5f5f5; }
    .divider { border: none; border-top: 1px solid #eee; margin: 20px 0; }
    @media (max-width: 600px) { .body { padding: 24px 20px; } }
  </style>
</head>
<body>
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>` : ''}
  <div class="wrapper">
    <div class="header">
      <h1>🍪 ${SHOP.name}</h1>
      <p>${process.env.SHOP_TAGLINE || 'Premium Homemade Snacks'}</p>
    </div>
    <div class="body">${content}</div>
    <div class="footer">
      <p>© ${new Date().getFullYear()} <strong>${SHOP.name}</strong> · All rights reserved.</p>
      <p>${SHOP.address}</p>
      <p>
        <a href="${SHOP.url}" style="color:${SHOP.primary};text-decoration:none;">Shop</a> ·
        <a href="${SHOP.url}/support" style="color:${SHOP.primary};text-decoration:none;">Support</a> ·
        <a href="${SHOP.url}/unsubscribe" style="color:#ccc;text-decoration:none;">Unsubscribe</a>
      </p>
      <p style="font-size:11px;color:#ccc;margin-top:8px;">
        You received this email because you have an account with ${SHOP.name}.
        This is a transactional email.
      </p>
    </div>
  </div>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════
//   12 RICH EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════

// ── 1. Welcome Email ──────────────────────────────────────
const sendWelcomeEmail = async (email, { name, verifyUrl }) => {
  const html = baseTemplate(`
    <h2>Welcome aboard, ${name}! 🎉</h2>
    <p>We're so excited to have you join <strong>${SHOP.name}</strong> — your go-to destination for the freshest, most delicious homemade snacks crafted with love.</p>
    <p>Please verify your email address to unlock your account:</p>
    <div style="text-align:center;">
      <a href="${verifyUrl}" class="btn">✅ Verify My Email</a>
    </div>
    <div class="card">
      <p style="margin:0;font-size:13px;color:#888;">
        This link expires in <strong>24 hours</strong>.<br>
        If you didn't create an account, you can safely ignore this email.
      </p>
    </div>
    <p>Happy snacking! 🍪</p>
  `, { preheader: `Welcome to ${SHOP.name}! Please verify your email.` });

  return enqueue({ to: email, subject: `🎉 Welcome to ${SHOP.name}! Please verify your email`, html, priority: 'high' });
};

// ── 2. OTP Email ──────────────────────────────────────────
const sendOTPEmail = async (email, { otp, purpose = 'Verification', expiresIn = 10, name = '' }) => {
  const html = baseTemplate(`
    <h2>Your Verification Code 🔐</h2>
    <p>${name ? `Hi <strong>${name}</strong>, ` : ''}use the code below to ${purpose.toLowerCase()}:</p>
    <div class="otp-box">
      <div class="otp">${otp}</div>
      <p style="margin:12px 0 0;color:#888;font-size:13px;">
        Valid for <strong>${expiresIn} minutes</strong>
      </p>
    </div>
    <div class="card">
      <p style="margin:0;color:#888;font-size:13px;">
        ⚠️ <strong>Never share this OTP</strong> with anyone — not even our team.<br>
        If you didn't request this, please ignore this email.
      </p>
    </div>
  `, { preheader: `${otp} is your ${SHOP.name} verification code` });

  return enqueue({ to: email, subject: `${otp} — Your ${SHOP.name} ${purpose} Code`, html, priority: 'high' });
};

// ── 3. Password Reset ─────────────────────────────────────
const sendPasswordResetEmail = async (email, { name, resetUrl, expiresIn = 60 }) => {
  const html = baseTemplate(`
    <h2>Password Reset Request 🔑</h2>
    <p>Hi <strong>${name}</strong>,</p>
    <p>We received a request to reset your password. Click the button below to set a new one:</p>
    <div style="text-align:center;">
      <a href="${resetUrl}" class="btn">🔑 Reset My Password</a>
    </div>
    <div class="card">
      <p style="margin:0;font-size:13px;color:#888;">
        This link expires in <strong>${expiresIn} minutes</strong>.<br>
        If you didn't request a password reset, please ignore this email and your password will remain unchanged.
      </p>
    </div>
  `, { preheader: 'Reset your An Shop password' });

  return enqueue({ to: email, subject: `🔑 Password Reset — ${SHOP.name}`, html, priority: 'high' });
};

// ── 4. Email Verification (resend) ────────────────────────
const sendEmailVerification = async (email, { name, verifyUrl }) => {
  const html = baseTemplate(`
    <h2>Verify Your Email ✉️</h2>
    <p>Hi <strong>${name}</strong>, please click the button below to verify your email address:</p>
    <div style="text-align:center;">
      <a href="${verifyUrl}" class="btn">✅ Verify Email</a>
    </div>
    <p style="font-size:13px;color:#888;">Link expires in 24 hours.</p>
  `, { preheader: 'Verify your An Shop email address' });

  return enqueue({ to: email, subject: `✅ Verify your email — ${SHOP.name}`, html, priority: 'high' });
};

// ── 5. Order Placed ───────────────────────────────────────
const sendOrderConfirmation = async (email, order) => {
  const itemsHtml = (order.items || []).map((item) => `
    <tr>
      <td>${item.productName}${item.variantName ? ` <span style="color:#888">(${item.variantName})</span>` : ''}</td>
      <td style="text-align:center;">${item.quantity}</td>
      <td style="text-align:right;">${formatCurrency(item.unitPrice)}</td>
      <td style="text-align:right;">${formatCurrency(item.total)}</td>
    </tr>
  `).join('');

  const html = baseTemplate(`
    <h2>Order Confirmed! 🎉</h2>
    <p>Your order has been placed successfully.</p>
    <div class="card" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div><small style="color:#888;">Order Number</small><br><strong>#${order.orderNumber}</strong></div>
      <div><small style="color:#888;">Date</small><br><strong>${toISTDate(order.createdAt || new Date())}</strong></div>
      <div><small style="color:#888;">Payment</small><br><span class="badge badge-warning">Awaiting Payment</span></div>
    </div>
    <table class="items">
      <thead><tr><th>Product</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Price</th><th style="text-align:right;">Total</th></tr></thead>
      <tbody>
        ${itemsHtml}
        <tr><td colspan="3">Subtotal</td><td style="text-align:right;">${formatCurrency(order.subtotal)}</td></tr>
        <tr><td colspan="3">Shipping</td><td style="text-align:right;">${order.shippingCharge === 0 ? '<span style="color:#2e7d32">FREE</span>' : formatCurrency(order.shippingCharge)}</td></tr>
        ${order.couponDiscount > 0 ? `<tr><td colspan="3">Coupon Discount</td><td style="text-align:right;color:#2e7d32;">-${formatCurrency(order.couponDiscount)}</td></tr>` : ''}
        <tr><td colspan="3">GST (18%)</td><td style="text-align:right;">${formatCurrency(order.taxAmount || 0)}</td></tr>
        <tr class="total"><td colspan="3" style="font-size:16px;">Total</td><td style="text-align:right;font-size:16px;color:${SHOP.primary};">${formatCurrency(order.total)}</td></tr>
      </tbody>
    </table>
    <p style="font-size:13px;color:#888;">
      📲 <strong>Next step:</strong> Complete your UPI payment and upload the screenshot to confirm your order.<br>
      📦 Track your order at: <a href="${SHOP.url}/orders/${order.id}" style="color:${SHOP.primary};">${SHOP.url}/orders/${order.id}</a>
    </p>
  `, { preheader: `Order #${order.orderNumber} placed! Complete payment to confirm.` });

  return enqueue({ to: email, subject: `📦 Order Placed #${order.orderNumber} — ${SHOP.name}`, html });
};

// ── 6. Payment Verified ───────────────────────────────────
const sendPaymentConfirmation = async (email, order) => {
  const html = baseTemplate(`
    <h2>Payment Verified! ✅</h2>
    <p>Your payment of <strong style="color:${SHOP.primary};">${formatCurrency(order.total)}</strong> for order <strong>#${order.orderNumber}</strong> has been verified and confirmed.</p>
    <div class="card" style="background:#e8f5e9;border-color:#c8e6c9;">
      <p style="margin:0;color:#2e7d32;font-size:14px;">
        ✅ Payment confirmed &nbsp;·&nbsp; 👩‍🍳 Preparing your order &nbsp;·&nbsp; 🚚 Shipping soon
      </p>
    </div>
    <div style="text-align:center;">
      <a href="${SHOP.url}/orders/${order.id}/track" class="btn">📦 Track My Order</a>
    </div>
    <p style="font-size:13px;color:#888;">Thank you for choosing ${SHOP.name}! 🍪</p>
  `, { preheader: `Payment confirmed for order #${order.orderNumber}` });

  return enqueue({ to: email, subject: `✅ Payment Confirmed — Order #${order.orderNumber}`, html, priority: 'high' });
};

// ── 7. Payment Rejected ───────────────────────────────────
const sendPaymentRejection = async (email, { order, reason, reuploadUrl }) => {
  const html = baseTemplate(`
    <h2>Payment Screenshot Rejected ❌</h2>
    <p>Unfortunately, the payment screenshot for order <strong>#${order.orderNumber}</strong> was rejected.</p>
    <div class="card" style="background:#fce4ec;border-color:#f48fb1;">
      <p style="margin:0;color:#c62828;"><strong>Reason:</strong> ${reason || 'Screenshot was unclear or amount was incorrect.'}</p>
    </div>
    <p>Please upload a clear screenshot showing:</p>
    <ul style="color:#555;line-height:2;padding-left:20px;">
      <li>✓ Full amount transferred</li>
      <li>✓ UPI reference / UTR number</li>
      <li>✓ Date and time of payment</li>
    </ul>
    <div style="text-align:center;">
      <a href="${reuploadUrl || SHOP.url + '/orders/' + order.id + '/payment'}" class="btn">📸 Re-upload Screenshot</a>
    </div>
    <p style="font-size:13px;color:#888;">Need help? Call us: <a href="tel:${SHOP.phone}" style="color:${SHOP.primary};">${SHOP.phone}</a></p>
  `, { preheader: `Action required: Re-upload payment for order #${order.orderNumber}` });

  return enqueue({ to: email, subject: `❌ Payment Screenshot Rejected — Order #${order.orderNumber}`, html, priority: 'high' });
};

// ── 8. Order Shipped ──────────────────────────────────────
const sendShipmentUpdate = async (email, order) => {
  const html = baseTemplate(`
    <h2>Your Order is On Its Way! 🚚</h2>
    <p>Great news! Order <strong>#${order.orderNumber}</strong> has been shipped.</p>
    <div class="card">
      <table style="width:100%;font-size:14px;">
        <tr><td style="color:#888;padding:4px 0;">Courier</td><td><strong>${order.courierName || 'Our delivery partner'}</strong></td></tr>
        <tr><td style="color:#888;padding:4px 0;">Tracking ID</td><td><strong>${order.trackingNumber || 'Will be updated shortly'}</strong></td></tr>
        ${order.estimatedDelivery ? `<tr><td style="color:#888;padding:4px 0;">Expected Delivery</td><td><strong>${toISTDate(order.estimatedDelivery)}</strong></td></tr>` : ''}
      </table>
    </div>
    <div style="text-align:center;">
      <a href="${SHOP.url}/tracking/${order.trackingNumber || ''}" class="btn">🔍 Track Shipment</a>
    </div>
    <p style="font-size:13px;color:#888;">We're so excited for you to receive your snacks! 🍪</p>
  `, { preheader: `Order #${order.orderNumber} shipped via ${order.courierName}` });

  return enqueue({ to: email, subject: `🚚 Shipped! Order #${order.orderNumber} is on its way`, html });
};

// ── 9. Order Delivered ────────────────────────────────────
const sendDeliveryConfirmation = async (email, { order, reviewUrl }) => {
  const html = baseTemplate(`
    <h2>Order Delivered! 🏠🎉</h2>
    <p>Your order <strong>#${order.orderNumber}</strong> has been delivered successfully!</p>
    <p>We hope you absolutely love your snacks! 🍪✨</p>
    <hr class="divider">
    <h2 style="font-size:18px;">How was your experience? ⭐</h2>
    <p>Your feedback helps us improve and helps other food lovers discover us. It takes less than 30 seconds!</p>
    <div style="text-align:center;">
      <a href="${reviewUrl || SHOP.url + '/orders/' + order.id + '/review'}" class="btn">⭐ Leave a Review</a>
    </div>
    <p style="font-size:13px;color:#888;">Thank you for choosing ${SHOP.name}! Shop again: <a href="${SHOP.url}" style="color:${SHOP.primary};">${SHOP.url}</a></p>
  `, { preheader: `Order #${order.orderNumber} delivered! We'd love your feedback.` });

  return enqueue({ to: email, subject: `🏠 Delivered! Order #${order.orderNumber} — Leave a Review`, html });
};

// ── 10. Order Cancelled ───────────────────────────────────
const sendOrderCancellation = async (email, { order, reason, refundInfo }) => {
  const html = baseTemplate(`
    <h2>Order Cancelled ❌</h2>
    <p>Your order <strong>#${order.orderNumber}</strong> has been cancelled.</p>
    ${reason ? `<div class="card"><p style="margin:0;color:#888;"><strong>Reason:</strong> ${reason}</p></div>` : ''}
    ${refundInfo ? `
      <div class="card" style="background:#e8f5e9;border-color:#c8e6c9;">
        <p style="margin:0;color:#2e7d32;">💰 <strong>Refund:</strong> ${refundInfo}</p>
      </div>
    ` : ''}
    <p>We're sorry to see you go. If this was a mistake or you need help, contact us:</p>
    <p style="font-size:13px;"><a href="mailto:${SHOP.email}" style="color:${SHOP.primary};">${SHOP.email}</a> · ${SHOP.phone}</p>
  `, { preheader: `Order #${order.orderNumber} has been cancelled` });

  return enqueue({ to: email, subject: `❌ Order Cancelled — #${order.orderNumber}`, html });
};

// ── 11. Refund Processed ──────────────────────────────────
const sendRefundConfirmation = async (email, { order, amount, transactionRef }) => {
  const html = baseTemplate(`
    <h2>Refund Processed! 💰</h2>
    <p>A refund of <strong style="color:${SHOP.primary};">${formatCurrency(amount || order.total)}</strong> for order <strong>#${order.orderNumber}</strong> has been processed.</p>
    ${transactionRef ? `<div class="card"><p style="margin:0;color:#888;">Transaction Reference: <strong>${transactionRef}</strong></p></div>` : ''}
    <p>Please allow <strong>5–7 business days</strong> for the amount to reflect in your account.</p>
    <p style="font-size:13px;color:#888;">Thank you for your patience. ${SHOP.name}</p>
  `, { preheader: `Refund of ${formatCurrency(amount || order.total)} processed for order #${order.orderNumber}` });

  return enqueue({ to: email, subject: `💰 Refund Processed — Order #${order.orderNumber}`, html });
};

// ── 12. Admin Alert ───────────────────────────────────────
const sendAdminAlert = async ({ subject, title, body, severity = 'info' }) => {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
  if (!adminEmail) return;

  const badgeClass = { error: 'badge-danger', warning: 'badge-warning', info: 'badge-info', success: 'badge-success' }[severity] || 'badge-info';
  const icon       = { error: '🚨', warning: '⚠️', info: 'ℹ️', success: '✅' }[severity] || 'ℹ️';

  const html = baseTemplate(`
    <h2>${icon} Admin Alert</h2>
    <span class="badge ${badgeClass}" style="margin-bottom:16px;display:inline-block;">${severity.toUpperCase()}</span>
    <h3 style="margin-bottom:12px;">${title}</h3>
    <div class="card"><pre style="white-space:pre-wrap;word-break:break-all;font-size:13px;color:#555;">${body}</pre></div>
    <p style="font-size:12px;color:#888;">Sent at: ${toIST(new Date())} IST</p>
  `, { preheader: `[${severity.toUpperCase()}] ${title}` });

  return enqueue({ to: adminEmail, subject: `${icon} [Admin] ${subject}`, html, priority: 'high' });
};

// ═══════════════════════════════════════════════════════════
//   EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
  // Core
  enqueue,
  sendDirect,
  processQueue,

  // Templates
  sendWelcomeEmail,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendOrderConfirmation,
  sendPaymentConfirmation,
  sendPaymentRejection,
  sendShipmentUpdate,
  sendDeliveryConfirmation,
  sendOrderCancellation,
  sendRefundConfirmation,
  sendAdminAlert,

  // Utilities
  SHOP,
  toIST,
  toISTDate,
};
