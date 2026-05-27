/**
 * middleware/security.js  [ENTERPRISE EDITION v2]
 * =================================================
 * Production security middleware stack — fully consolidated.
 *
 * LAYERS (in recommended app.js mount order):
 *  1.  requestId          — Unique X-Request-ID per request
 *  2.  securityLogger     — Correlation ID + suspicious pattern detection
 *  3.  helmetMiddleware   — 14 HTTP security headers
 *  4.  corsMiddleware     — CORS with origin whitelist
 *  5.  globalRateLimiter  — IP-based 100 req/15min
 *  6.  speedLimiter       — Progressive slow-down after 50 req/15min
 *  7.  hppMiddleware      — HTTP parameter pollution prevention
 *  8.  sanitizationMiddleware — NoSQL injection ($, .) removal
 *  9.  xssProtection      — Script tag / XSS pattern scrubber
 * 10.  csrfTokenMiddleware — Double-submit CSRF cookie generation
 * 11.  csrfProtection     — CSRF header validation on mutating requests
 * 12.  adminIpAllowlist   — IP whitelist for /admin routes
 * 13.  adminRateLimiter   — Stricter admin rate limit (60 req/min)
 * 14.  bruteForceGuard    — Account lockout on repeated auth failures (Redis)
 *
 * EXPORTS (all named, backward compatible):
 *   requestId, securityLogger, helmetMiddleware, corsMiddleware,
 *   globalRateLimiter, speedLimiter, hppMiddleware, sanitizationMiddleware,
 *   xssProtection, csrfTokenMiddleware, csrfProtection,
 *   adminIpAllowlist, adminRateLimiter, bruteForceGuard,
 *   securityStack         ← full ordered array for app.use(...securityStack)
 */

'use strict';

const helmet       = require('helmet');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const slowDown     = require('express-slow-down');
const hpp          = require('hpp');
const mongoSanitize= require('express-mongo-sanitize');
const crypto       = require('crypto');
const logger       = require('../utils/logger');
const AppError     = require('../utils/AppError');

// ─── CORS Config ──────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map((o) => o.trim());

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, mobile apps, Postman)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    logger.securityEvent('CORS_BLOCKED', { origin });
    cb(new Error(`CORS policy: origin ${origin} is not allowed.`));
  },
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-CSRF-Token',
    'X-Request-ID', 'X-Correlation-ID', 'X-Mobile-App',
    'X-Access-Token',
  ],
  exposedHeaders: ['X-Request-ID', 'X-Correlation-ID', 'RateLimit-Limit', 'RateLimit-Remaining'],
  maxAge:      86400, // Preflight cache: 24 hours
};

const corsMiddleware = [cors(corsOptions), cors.options ? cors(corsOptions) : (req, res, next) => next()];

// ─── 1. Request ID ────────────────────────────────────────────────────────────
const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
};

// ─── 2. Security Event Logger ─────────────────────────────────────────────────
const securityLogger = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  res.setHeader('X-Correlation-ID', req.correlationId);

  // Detect common attack patterns in URL + query
  const xssPatterns = [/<script/i, /javascript:/i, /on\w+\s*=/i, /data:text\/html/i];
  const sqliPatterns = [/union\s+select/i, /'\s*(or|and)\s*'?\d/i, /;\s*drop\s+table/i];
  const allPatterns  = [...xssPatterns, ...sqliPatterns];

  const urlStr = decodeURIComponent(req.url || '');
  const qryStr = JSON.stringify(req.query || {});

  if (allPatterns.some((p) => p.test(urlStr) || p.test(qryStr))) {
    logger.securityEvent('ATTACK_PATTERN_DETECTED', {
      ip:     req.ip,
      url:    req.url.slice(0, 200),
      method: req.method,
      ua:     req.headers['user-agent']?.slice(0, 100),
    });
  }

  next();
};

// ─── 3. Helmet — HTTP Security Headers ───────────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:             ["'self'"],
      scriptSrc:              ["'self'", 'https://checkout.razorpay.com'],
      scriptSrcAttr:          ["'none'"],
      styleSrc:               ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:                ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:                 ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
      connectSrc:             ["'self'"],
      frameSrc:               ["'none'"],
      objectSrc:              ["'none'"],
      baseUri:                ["'self'"],
      formAction:             ["'self'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginEmbedderPolicy:  false,
  crossOriginResourcePolicy:  { policy: 'cross-origin' },
  crossOriginOpenerPolicy:    { policy: 'same-origin-allow-popups' },
  referrerPolicy:             { policy: 'strict-origin-when-cross-origin' },
  strictTransportSecurity:    process.env.NODE_ENV === 'production'
    ? { maxAge: 63072000, includeSubDomains: true, preload: true }
    : false,
  noSniff:                    true,
  xssFilter:                  true,
  hidePoweredBy:              true,
  frameguard:                 { action: 'deny' },
  ieNoOpen:                   true,
  dnsPrefetchControl:         { allow: false },
  permittedCrossDomainPolicies: false,
});

// ─── 4. Global Rate Limiter ───────────────────────────────────────────────────
const globalRateLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.ip,
  skip: (req) => req.path === '/api/v1/health',
  handler: (req, res) => {
    logger.securityEvent('RATE_LIMIT_HIT', {
      ip: req.ip, path: req.path, method: req.method,
    });
    res.status(429).json({
      success: false,
      message: 'Too many requests from this IP. Please try again later.',
      code:    'RATE_LIMIT_EXCEEDED',
    });
  },
});

// ─── 5. Speed Limiter (progressive delay) ────────────────────────────────────
const speedLimiter = slowDown({
  windowMs:   15 * 60 * 1000,
  delayAfter: 50,
  delayMs:    (hits) => hits * 50,
  maxDelayMs: 2000,
  skip: (req) => req.path === '/api/v1/health',
});

// ─── 6. Admin Rate Limiter (stricter) ─────────────────────────────────────────
const adminRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, message: 'Admin rate limit exceeded.', code: 'RATE_LIMIT_EXCEEDED' },
});

// ─── 7. HPP — HTTP Parameter Pollution ────────────────────────────────────────
const hppMiddleware = hpp({
  whitelist: ['sort', 'tags', 'category', 'rating', 'status', 'price'],
});

// ─── 8. NoSQL Injection Sanitization ─────────────────────────────────────────
const sanitizationMiddleware = mongoSanitize({
  onSanitize: ({ req, key }) => {
    logger.securityEvent('NOSQL_INJECTION_BLOCKED', {
      key, ip: req.ip, path: req.path,
    });
  },
});

// ─── 9. XSS Body Scrubber ─────────────────────────────────────────────────────
/**
 * Recursively strips dangerous HTML/script patterns from req.body.
 * Works on strings at any nesting depth.
 * Does NOT use xss-clean (deprecated) — implemented natively.
 */
const XSS_PATTERNS = [
  [/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ''],
  [/<[^>]+on\w+\s*=\s*["'][^"']*["'][^>]*>/gi, ''],
  [/javascript\s*:/gi, ''],
  [/vbscript\s*:/gi, ''],
  [/data:text\/html/gi, ''],
];

const scrubValue = (val) => {
  if (typeof val !== 'string') return val;
  let out = val;
  for (const [pattern, replace] of XSS_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  return out;
};

const scrubObject = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(scrubObject);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === 'object' ? scrubObject(v) : scrubValue(v);
  }
  return result;
};

const xssProtection = (req, res, next) => {
  if (req.body) req.body = scrubObject(req.body);
  if (req.query) req.query = scrubObject(req.query);
  if (req.params) req.params = scrubObject(req.params);
  next();
};

// ─── 10. CSRF Token Generator ────────────────────────────────────────────────
const csrfTokenMiddleware = (req, res, next) => {
  if (!req.cookies?.csrfToken) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrfToken', token, {
      httpOnly: false,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
    });
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies.csrfToken;
  }
  next();
};

// ─── 11. CSRF Protection ─────────────────────────────────────────────────────
const CSRF_EXEMPT = [
  '/api/v1/payments/webhook',
  '/api/v1/health',
];

const csrfProtection = (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.headers['x-mobile-app'] === 'true') return next();
  if (CSRF_EXEMPT.some((p) => req.path.startsWith(p))) return next();

  const cookieToken = req.cookies?.csrfToken;
  const headerToken = req.headers['x-csrf-token'];

  if (!cookieToken || !headerToken) {
    logger.securityEvent('CSRF_MISSING_TOKEN', { ip: req.ip, path: req.path });
    return next(AppError.forbidden('CSRF token missing. Please refresh the page.', 'CSRF_MISSING'));
  }

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(cookieToken, 'hex'),
      Buffer.from(headerToken, 'hex')
    );
    if (!isValid) throw new Error('mismatch');
  } catch {
    logger.securityEvent('CSRF_INVALID_TOKEN', { ip: req.ip, path: req.path });
    return next(AppError.forbidden('Invalid CSRF token.', 'CSRF_INVALID'));
  }

  next();
};

// ─── 12. Admin IP Allowlist ───────────────────────────────────────────────────
const adminIpAllowlist = (req, res, next) => {
  const allowed = (process.env.ADMIN_IP_WHITELIST || '')
    .split(',').map((ip) => ip.trim()).filter(Boolean);

  if (!allowed.length) return next();

  const clientIp = req.ip || req.socket?.remoteAddress || '';
  if (!allowed.includes(clientIp)) {
    logger.securityEvent('ADMIN_IP_BLOCKED', { ip: clientIp, path: req.path, allowed });
    return next(AppError.forbidden('Access denied from this IP.', 'IP_NOT_ALLOWED'));
  }
  next();
};

// ─── 13. Brute Force Guard (Redis-backed) ────────────────────────────────────
/**
 * Tracks failed auth attempts per IP in Redis.
 * Locks out IP after MAX_ATTEMPTS within WINDOW_MINUTES.
 *
 * Usage: apply to POST /auth/login and POST /auth/register
 *   router.post('/login', bruteForceGuard, authController.login)
 */
const BRUTE_MAX      = parseInt(process.env.BRUTE_MAX_ATTEMPTS)  || 10;
const BRUTE_WINDOW   = parseInt(process.env.BRUTE_WINDOW_MINUTES) || 15;
const BRUTE_LOCKOUT  = parseInt(process.env.BRUTE_LOCKOUT_MINUTES)|| 30;

const bruteForceGuard = async (req, res, next) => {
  const ip  = req.ip;
  const key = `brute:${ip}`;

  try {
    const { redis } = require('../config/redis');
    if (!redis) return next(); // Skip if Redis unavailable

    const [count, ttl] = await redis.multi()
      .get(key)
      .ttl(key)
      .exec();

    const attempts = parseInt(count?.[1] || '0');
    const remaining = ttl?.[1] || 0;

    if (attempts >= BRUTE_MAX) {
      const lockMins = Math.ceil(remaining / 60);
      logger.securityEvent('BRUTE_FORCE_BLOCKED', {
        ip, attempts, lockoutRemainingMins: lockMins,
      });
      return res.status(429).json({
        success: false,
        message: `Too many failed attempts. Try again in ${lockMins} minutes.`,
        code:    'BRUTE_FORCE_LOCKOUT',
        retryAfter: remaining,
      });
    }
  } catch (err) {
    logger.warn('⚠️ BruteForce guard Redis error:', { error: err.message });
  }

  next();
};

/**
 * Call this after a FAILED login attempt to increment the counter.
 * Call with `success=true` after a SUCCESSFUL login to clear the counter.
 */
bruteForceGuard.recordAttempt = async (ip, success = false) => {
  try {
    const { redis } = require('../config/redis');
    if (!redis) return;

    const key = `brute:${ip}`;
    if (success) {
      await redis.del(key);
    } else {
      const newCount = await redis.incr(key);
      if (newCount === 1) {
        // First failure — set window expiry
        await redis.expire(key, BRUTE_WINDOW * 60);
      }
      if (newCount >= BRUTE_MAX) {
        // Lock out — extend TTL to lockout window
        await redis.expire(key, BRUTE_LOCKOUT * 60);
        logger.securityEvent('BRUTE_FORCE_LOCKOUT_TRIGGERED', { ip, attempts: newCount });
      }
    }
  } catch (err) {
    logger.warn('⚠️ BruteForce record error:', { error: err.message });
  }
};

// ─── 14. Secure Headers (extra, beyond Helmet) ────────────────────────────────
/**
 * Adds application-level security headers not covered by Helmet.
 * Mount as: app.use(securityHeaders)
 */
const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
};

// ─── Full Security Stack (for app.use(...securityStack)) ─────────────────────
const securityStack = [
  requestId,
  securityLogger,
  helmetMiddleware,
  cors(corsOptions),
  hppMiddleware,
  sanitizationMiddleware,
  xssProtection,
  globalRateLimiter,
  speedLimiter,
];

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Individual middleware
  requestId,
  securityLogger,
  helmetMiddleware,
  corsMiddleware,
  corsOptions,
  globalRateLimiter,
  speedLimiter,
  adminRateLimiter,
  hppMiddleware,
  sanitizationMiddleware,
  xssProtection,
  csrfTokenMiddleware,
  csrfProtection,
  adminIpAllowlist,
  bruteForceGuard,
  securityHeaders,

  // Full stack shorthand
  securityStack,
};
