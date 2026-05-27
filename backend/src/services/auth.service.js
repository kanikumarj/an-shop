/**
 * services/auth.service.js
 * ==========================
 * Enterprise authentication business logic layer.
 * Separates auth concerns from HTTP controllers.
 *
 * Features:
 *  - Account lockout after N failed attempts
 *  - Refresh token rotation with family tracking
 *  - Token blacklisting (Redis)
 *  - OTP-based passwordless login
 *  - Admin-specific auth with elevated security
 *  - Comprehensive security audit logging
 */

'use strict';

const crypto = require('crypto');
const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const {
  hashPassword,
  comparePassword,
  generateSecureOTP,
  addMinutes,
  addDays,
  isExpired,
  maskEmail,
  maskPhone,
  formatPhoneNumber,
} = require('../utils/helpers');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
} = require('../utils/jwt');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ─── Constants ─────────────────────────────────────────────────────────────────
const LOCK_CONFIG = {
  MAX_ATTEMPTS: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
  WINDOW_MINUTES: parseInt(process.env.LOCKOUT_WINDOW_MINUTES) || 15,
  LOCKOUT_MINUTES: parseInt(process.env.LOCKOUT_DURATION_MINUTES) || 30,
};

const OTP_CONFIG = {
  LENGTH: parseInt(process.env.OTP_LENGTH) || 6,
  EXPIRY_MINUTES: parseInt(process.env.OTP_EXPIRES_IN) || 10,
  MAX_ATTEMPTS: 5,
};

const TOKEN_CONFIG = {
  ACCESS_EXPIRY: process.env.JWT_EXPIRES_IN || '15m',
  REFRESH_EXPIRY_DAYS: parseInt(process.env.JWT_REFRESH_EXPIRES_IN_DAYS) || 30,
};

// ─── Safe User Select ──────────────────────────────────────────────────────────
const SAFE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  avatar: true,
  isActive: true,
  isEmailVerified: true,
  isPhoneVerified: true,
  isBanned: true,
  lastLogin: true,
  loginCount: true,
  createdAt: true,
};

// ═══════════════════════════════════════════════════════════
//   ACCOUNT LOCKOUT
// ═══════════════════════════════════════════════════════════

/**
 * Get Redis key for tracking failed login attempts
 */
const getLockKey = (identifier) => `auth:lock:${identifier}`;
const getAttemptsKey = (identifier) => `auth:attempts:${identifier}`;

/**
 * Check if account is currently locked out
 * @returns {{ locked: boolean, remainingSeconds?: number }}
 */
const checkLockout = async (identifier) => {
  const lockKey = getLockKey(identifier);
  const lockData = await cache.get(lockKey);

  if (lockData) {
    const remainingSeconds = lockData.unlocksAt
      ? Math.max(0, Math.ceil((new Date(lockData.unlocksAt) - Date.now()) / 1000))
      : LOCK_CONFIG.LOCKOUT_MINUTES * 60;

    return { locked: true, remainingSeconds, lockedAt: lockData.lockedAt };
  }

  return { locked: false };
};

/**
 * Record a failed login attempt; lock if threshold exceeded
 * @returns {{ attempts: number, locked: boolean, remainingSeconds?: number }}
 */
const recordFailedAttempt = async (identifier, ip = null) => {
  const attemptsKey = getAttemptsKey(identifier);
  const lockKey = getLockKey(identifier);

  // Increment attempt counter
  const attempts = await (async () => {
    const current = await cache.get(attemptsKey);
    const count = (current?.count || 0) + 1;
    await cache.set(attemptsKey, { count, ip, lastAttempt: new Date() },
      LOCK_CONFIG.WINDOW_MINUTES * 60);
    return count;
  })();

  logger.securityEvent('FAILED_LOGIN_ATTEMPT', {
    identifier: identifier.includes('@') ? maskEmail(identifier) : maskPhone(identifier),
    attempts,
    maxAttempts: LOCK_CONFIG.MAX_ATTEMPTS,
    ip,
  });

  // Trigger lockout
  if (attempts >= LOCK_CONFIG.MAX_ATTEMPTS) {
    const unlocksAt = addMinutes(new Date(), LOCK_CONFIG.LOCKOUT_MINUTES);
    await cache.set(lockKey, {
      lockedAt: new Date(),
      unlocksAt,
      triggerAttempts: attempts,
      ip,
    }, LOCK_CONFIG.LOCKOUT_MINUTES * 60);

    logger.securityEvent('ACCOUNT_LOCKED', {
      identifier: identifier.includes('@') ? maskEmail(identifier) : maskPhone(identifier),
      attempts,
      unlocksAt,
      ip,
    });

    return {
      locked: true,
      attempts,
      remainingSeconds: LOCK_CONFIG.LOCKOUT_MINUTES * 60,
    };
  }

  return { locked: false, attempts, remaining: LOCK_CONFIG.MAX_ATTEMPTS - attempts };
};

/**
 * Clear failed attempt counters after successful login
 */
const clearFailedAttempts = async (identifier) => {
  await cache.del(getAttemptsKey(identifier), getLockKey(identifier));
};

// ═══════════════════════════════════════════════════════════
//   TOKEN MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * Hash a token for safe storage (never store raw refresh tokens)
 */
const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

/**
 * Generate a secure device fingerprint from request headers
 */
const getDeviceInfo = (req) => ({
  userAgent: req.headers['user-agent'] || 'unknown',
  ip: req.ip || req.socket?.remoteAddress || 'unknown',
  deviceType: /mobile|android|iphone|ipad/i.test(req.headers['user-agent'] || '')
    ? 'mobile'
    : 'desktop',
});

/**
 * Issue a new token pair (access + refresh) and store refresh in DB
 */
const issueTokenPair = async (user, req, family = null) => {
  const device = getDeviceInfo(req);

  // 1. Generate tokens
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email,
    family: family || crypto.randomBytes(16).toString('hex'),
  });

  // 2. Decode the generated tokens to get jti
  const { decodeToken } = require('../utils/jwt');
  const decodedAccess = decodeToken(accessToken);
  const decodedRefresh = decodeToken(refreshToken);

  // 3. Store hashed refresh token in DB
  const expiresAt = addDays(new Date(), TOKEN_CONFIG.REFRESH_EXPIRY_DAYS);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      jti: decodedRefresh?.jti || crypto.randomUUID(),
      family: decodedRefresh?.family || family,
      expiresAt,
      deviceName: device.userAgent.slice(0, 200),
      deviceType: device.deviceType,
      userAgent: device.userAgent.slice(0, 500),
      ipAddress: device.ip,
    },
  });

  return { accessToken, refreshToken, expiresAt, jti: decodedAccess?.jti };
};

/**
 * Rotate refresh token — revoke old, issue new
 * Implements token family detection for theft detection
 */
const rotateRefreshToken = async (rawRefreshToken, req) => {
  const tokenHash = hashToken(rawRefreshToken);

  // 1. Find the token record
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: SAFE_USER_SELECT } },
  });

  if (!stored) {
    // Token not found — could be replay attack or already rotated
    logger.securityEvent('REFRESH_TOKEN_NOT_FOUND', {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    throw AppError.unauthorized('Invalid refresh token. Please log in again.');
  }

  // 2. Check if revoked (theft detection)
  if (stored.isRevoked) {
    // Someone is using a revoked token — revoke the entire family!
    logger.securityEvent('REFRESH_TOKEN_REUSE_DETECTED', {
      userId: stored.userId,
      family: stored.family,
      ip: req.ip,
    });

    // Revoke all tokens in this family
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, family: stored.family, isRevoked: false },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        revokedReason: 'security_theft_detected',
      },
    });

    throw AppError.unauthorized(
      'Security alert: Please log in again. Your session was invalidated.'
    );
  }

  // 3. Check expiry
  if (new Date() > stored.expiresAt) {
    throw AppError.unauthorized('Refresh token expired. Please log in again.');
  }

  // 4. Check user is still valid
  if (!stored.user || !stored.user.isActive || stored.user.isBanned) {
    throw AppError.forbidden('Account is inactive or banned.');
  }

  // 5. Revoke the used token (rotation)
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: {
      isRevoked: true,
      revokedAt: new Date(),
      revokedReason: 'refresh',
    },
  });

  // 6. Issue new token pair in same family
  const tokens = await issueTokenPair(stored.user, req, stored.family);

  return { tokens, user: stored.user };
};

/**
 * Revoke a specific refresh token
 */
const revokeRefreshToken = async (rawRefreshToken, reason = 'logout') => {
  const tokenHash = hashToken(rawRefreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, isRevoked: false },
    data: { isRevoked: true, revokedAt: new Date(), revokedReason: reason },
  });
};

/**
 * Revoke all refresh tokens for a user (force logout all devices)
 */
const revokeAllUserTokens = async (userId, reason = 'force_logout') => {
  await prisma.refreshToken.updateMany({
    where: { userId, isRevoked: false },
    data: { isRevoked: true, revokedAt: new Date(), revokedReason: reason },
  });
};

/**
 * Blacklist a JWT access token in Redis until its natural expiry
 */
const blacklistAccessToken = async (jti, exp) => {
  if (!jti || !exp) return;
  const ttl = Math.max(0, exp - Math.floor(Date.now() / 1000));
  if (ttl > 0) {
    await cache.set(`blacklist:jti:${jti}`, '1', ttl);
  }
};

// ═══════════════════════════════════════════════════════════
//   OTP MANAGEMENT (New OtpToken table-based)
// ═══════════════════════════════════════════════════════════

/**
 * Create and store an OTP using the OtpToken model
 */
const createOtp = async ({ userId, type, channel, target, req }) => {
  const device = getDeviceInfo(req || {});
  const code = generateSecureOTP(OTP_CONFIG.LENGTH);
  const expiresAt = addMinutes(new Date(), OTP_CONFIG.EXPIRY_MINUTES);

  // Invalidate any existing unused OTPs of same type for this user
  await prisma.otpToken.updateMany({
    where: { userId, type, isUsed: false },
    data: { isUsed: true, usedAt: new Date() },
  });

  const otpRecord = await prisma.otpToken.create({
    data: {
      userId,
      code,
      type,
      channel: channel || 'email',
      target,
      expiresAt,
      ipAddress: device.ip,
      userAgent: device.userAgent.slice(0, 500),
    },
  });

  return { code, expiresAt, recordId: otpRecord.id };
};

/**
 * Verify an OTP code
 * Handles: expiry, brute-force, single-use enforcement
 */
const verifyOtp = async ({ userId, code, type }) => {
  const otpRecord = await prisma.otpToken.findFirst({
    where: {
      userId,
      type,
      isUsed: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otpRecord) {
    throw AppError.badRequest('No active OTP found. Please request a new one.');
  }

  // Check expiry
  if (new Date() > otpRecord.expiresAt) {
    throw AppError.badRequest('OTP has expired. Please request a new one.');
  }

  // Check max attempts
  if (otpRecord.attempts >= OTP_CONFIG.MAX_ATTEMPTS) {
    throw AppError.tooManyRequests('Too many incorrect OTP attempts. Please request a new OTP.');
  }

  // Verify code
  if (otpRecord.code !== code) {
    // Increment attempt counter
    await prisma.otpToken.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });

    const remaining = OTP_CONFIG.MAX_ATTEMPTS - (otpRecord.attempts + 1);
    throw AppError.badRequest(
      `Incorrect OTP. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : 'No attempts left — request a new OTP.'}`
    );
  }

  // Mark as used
  await prisma.otpToken.update({
    where: { id: otpRecord.id },
    data: { isUsed: true, usedAt: new Date() },
  });

  return true;
};

// ═══════════════════════════════════════════════════════════
//   USER LOOKUP HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Find a user by email or phone — used across multiple auth flows
 */
const findUserByIdentifier = async (identifier) => {
  const isEmail = identifier.includes('@');

  if (isEmail) {
    return prisma.user.findUnique({ where: { email: identifier.toLowerCase() } });
  }

  return prisma.user.findUnique({ where: { phone: formatPhoneNumber(identifier) } });
};

/**
 * Get safe user data (no sensitive fields)
 */
const getSafeUser = async (userId) => {
  return prisma.user.findUnique({
    where: { id: userId },
    select: SAFE_USER_SELECT,
  });
};

// ═══════════════════════════════════════════════════════════
//   SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════

/**
 * List all active sessions for a user
 */
const getActiveSessions = async (userId) => {
  return prisma.refreshToken.findMany({
    where: {
      userId,
      isRevoked: false,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      deviceName: true,
      deviceType: true,
      ipAddress: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Revoke a specific session by token ID
 */
const revokeSession = async (tokenId, userId) => {
  const token = await prisma.refreshToken.findFirst({
    where: { id: tokenId, userId },
  });

  if (!token) throw AppError.notFound('Session');

  await prisma.refreshToken.update({
    where: { id: tokenId },
    data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'user_revoked' },
  });
};

// ─── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  // Lockout
  checkLockout,
  recordFailedAttempt,
  clearFailedAttempts,
  LOCK_CONFIG,
  // Tokens
  issueTokenPair,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  blacklistAccessToken,
  hashToken,
  getDeviceInfo,
  // OTP
  createOtp,
  verifyOtp,
  OTP_CONFIG,
  // Users
  findUserByIdentifier,
  getSafeUser,
  SAFE_USER_SELECT,
  // Sessions
  getActiveSessions,
  revokeSession,
};
