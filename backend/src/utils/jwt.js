/**
 * utils/jwt.js  [ENTERPRISE EDITION]
 * =====================================
 * JWT token generation, verification, and cookie management.
 *
 * Access tokens  — 15min TTL, stateless, checked against blacklist
 * Refresh tokens — 30d TTL, stored in DB (revocable), HTTP-only cookie
 * Token family   — Tracks token lineage for theft detection
 */

'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AppError = require('./AppError');
const logger = require('./logger');

// ─── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  access: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  },
  refresh: {
    secret: process.env.JWT_REFRESH_SECRET,
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },
  cookieDomain: process.env.COOKIE_DOMAIN,
  isProd: process.env.NODE_ENV === 'production',
};

if (!CONFIG.access.secret || !CONFIG.refresh.secret) {
  throw new Error(
    '❌ JWT_SECRET and JWT_REFRESH_SECRET must be set in environment variables.\n' +
    'Generate them with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"'
  );
}

// ─── Token Generation ─────────────────────────────────────────────────────────

/**
 * Generate an access token (short-lived)
 * Payload: { id, email, role, jti }
 */
const generateAccessToken = (payload) => {
  return jwt.sign(
    {
      ...payload,
      jti: crypto.randomUUID(),    // Unique ID for blacklisting
      type: 'access',
    },
    CONFIG.access.secret,
    {
      expiresIn: CONFIG.access.expiresIn,
      issuer: process.env.JWT_ISSUER || 'an-shop-api',
      audience: process.env.JWT_AUDIENCE || 'an-shop-client',
    }
  );
};

/**
 * Generate a refresh token (long-lived)
 * Payload: { id, email, family, jti }
 */
const generateRefreshToken = (payload) => {
  return jwt.sign(
    {
      ...payload,
      jti: crypto.randomUUID(),
      type: 'refresh',
      family: payload.family || crypto.randomBytes(16).toString('hex'),
    },
    CONFIG.refresh.secret,
    {
      expiresIn: CONFIG.refresh.expiresIn,
      issuer: process.env.JWT_ISSUER || 'an-shop-api',
      audience: process.env.JWT_AUDIENCE || 'an-shop-client',
    }
  );
};

// ─── Token Verification ───────────────────────────────────────────────────────

/**
 * Verify access token — throws structured AppError on failure
 */
const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, CONFIG.access.secret, {
      issuer: process.env.JWT_ISSUER || 'an-shop-api',
      audience: process.env.JWT_AUDIENCE || 'an-shop-client',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Session expired. Please log in again.', 'TOKEN_EXPIRED');
    }
    if (err.name === 'JsonWebTokenError') {
      throw AppError.unauthorized('Invalid token. Please log in again.', 'TOKEN_INVALID');
    }
    if (err.name === 'NotBeforeError') {
      throw AppError.unauthorized('Token not active yet.', 'TOKEN_NOT_ACTIVE');
    }
    throw AppError.unauthorized('Token verification failed.', 'TOKEN_ERROR');
  }
};

/**
 * Verify refresh token — throws on failure
 */
const verifyRefreshToken = (token) => {
  try {
    return jwt.verify(token, CONFIG.refresh.secret, {
      issuer: process.env.JWT_ISSUER || 'an-shop-api',
      audience: process.env.JWT_AUDIENCE || 'an-shop-client',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Refresh token expired. Please log in again.', 'REFRESH_EXPIRED');
    }
    throw AppError.unauthorized('Invalid refresh token. Please log in again.', 'REFRESH_INVALID');
  }
};

/**
 * Decode a token without verifying signature (for expired token inspection)
 */
const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

// ─── Cookie Options ───────────────────────────────────────────────────────────

/**
 * HTTP-only cookie options for access token
 */
const getAccessCookieOptions = () => ({
  httpOnly: true,
  secure: CONFIG.isProd,
  sameSite: CONFIG.isProd ? 'strict' : 'lax',
  maxAge: parseDurationToMs(CONFIG.access.expiresIn),
  ...(CONFIG.cookieDomain && { domain: CONFIG.cookieDomain }),
});

/**
 * HTTP-only cookie options for refresh token
 */
const getRefreshCookieOptions = () => ({
  httpOnly: true,
  secure: CONFIG.isProd,
  sameSite: CONFIG.isProd ? 'strict' : 'lax',
  maxAge: parseDurationToMs(CONFIG.refresh.expiresIn),
  path: '/api/v1/auth',           // Restrict to auth routes only
  ...(CONFIG.cookieDomain && { domain: CONFIG.cookieDomain }),
});

// ─── Token Response Helper ────────────────────────────────────────────────────
/**
 * @deprecated - Use authService.issueTokenPair + sendAuthResponse instead
 * Kept for backward compatibility
 */
const sendTokenResponse = (res, user, statusCode = 200, message = 'Success') => {
  const accessToken = generateAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    email: user.email,
  });

  res.cookie('accessToken', accessToken, getAccessCookieOptions());
  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());

  const { password, otp, otpExpiry, otpType, ...safeUser } = user;

  res.status(statusCode).json({
    success: true,
    message,
    data: {
      user: safeUser,
      accessToken,
      tokenType: 'Bearer',
      expiresIn: CONFIG.access.expiresIn,
    },
  });
};

// ─── Duration Parser ─────────────────────────────────────────────────────────
/**
 * Convert JWT duration string to milliseconds
 * e.g., "15m" → 900000, "7d" → 604800000
 */
const parseDurationToMs = (duration) => {
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const match = String(duration).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60 * 1000; // Default 15min
  return parseInt(match[1]) * (units[match[2]] || 1000);
};

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  decodeToken,
  sendTokenResponse,
  getAccessCookieOptions,
  getRefreshCookieOptions,
  parseDurationToMs,
};
