/**
 * middleware/auth.js  [ENTERPRISE EDITION]
 * ==========================================
 * JWT authentication, RBAC, session validation, and security guards.
 *
 * Exported middleware:
 *   protect              — Require valid JWT access token
 *   optionalAuth         — Attach user if token present, don't block
 *   restrictTo(...roles) — RBAC role guard
 *   requireEmailVerified — Force email verification
 *   requirePhoneVerified — Force phone verification
 *   ownerOrAdmin         — Allow resource owner or admin
 *   refreshGuard         — Validate refresh token for /auth/refresh only
 *   adminOnly            — Shorthand: restrictTo('ADMIN','SUPERADMIN')
 *   superAdminOnly       — Shorthand: restrictTo('SUPERADMIN')
 */

'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const { prisma } = require('../config/database');
const { cache } = require('../config/redis');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ─── Shared Fields Selected for req.user ──────────────────────────────────────
const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  avatar: true,
  isActive: true,
  isBanned: true,
  isEmailVerified: true,
  isPhoneVerified: true,
  passwordChangedAt: true,
  lastLogin: true,
  createdAt: true,
};

// ─── Token Extraction ─────────────────────────────────────────────────────────
const extractToken = (req) => {
  // Priority 1: Authorization header (Bearer <token>)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  // Priority 2: Signed HTTP-only cookie
  if (req.cookies?.accessToken) {
    return req.cookies.accessToken;
  }
  // Priority 3: X-Access-Token header (for mobile apps)
  if (req.headers['x-access-token']) {
    return req.headers['x-access-token'];
  }
  return null;
};

// ─── Core: Protect ────────────────────────────────────────────────────────────
const protect = async (req, res, next) => {
  try {
    // 1. Extract
    const token = extractToken(req);
    if (!token) {
      return next(AppError.unauthorized(
        'Authentication required. Please log in.',
        'NO_TOKEN'
      ));
    }

    // 2. Verify signature + expiry
    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      return next(err);
    }

    // 3. Check JWT blacklist (logout invalidation)
    if (decoded.jti) {
      const blacklisted = await cache.exists(`blacklist:jti:${decoded.jti}`);
      if (blacklisted) {
        return next(AppError.unauthorized(
          'Session has been invalidated. Please log in again.',
          'TOKEN_BLACKLISTED'
        ));
      }
    }

    // 4. Verify user still exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.id, deletedAt: null },
      select: USER_SELECT,
    });

    if (!user) {
      return next(AppError.unauthorized(
        'Account associated with this token no longer exists.',
        'USER_NOT_FOUND'
      ));
    }

    // 5. Check account is active and not banned
    if (!user.isActive) {
      return next(AppError.forbidden(
        'Your account has been deactivated. Please contact support.',
        'ACCOUNT_INACTIVE'
      ));
    }

    if (user.isBanned) {
      return next(AppError.forbidden(
        'Your account has been banned. Please contact support.',
        'ACCOUNT_BANNED'
      ));
    }

    // 6. Check if password was changed after token was issued
    //    (Forces re-login after password change/reset)
    if (user.passwordChangedAt && decoded.iat) {
      const passwordChangedTimestamp = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (decoded.iat < passwordChangedTimestamp) {
        return next(AppError.unauthorized(
          'Password recently changed. Please log in again.',
          'PASSWORD_CHANGED'
        ));
      }
    }

    // 7. Attach to request
    req.user = user;
    req.token = token;
    req.tokenData = decoded;

    next();
  } catch (error) {
    next(error);
  }
};

// ─── Optional Auth ─────────────────────────────────────────────────────────────
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) return next();

    const decoded = verifyAccessToken(token);

    const blacklisted = decoded.jti
      ? await cache.exists(`blacklist:jti:${decoded.jti}`)
      : false;
    if (blacklisted) return next();

    const user = await prisma.user.findUnique({
      where: { id: decoded.id, deletedAt: null },
      select: USER_SELECT,
    });

    if (user?.isActive && !user.isBanned) {
      req.user = user;
      req.tokenData = decoded;
    }
  } catch {
    // Silently ignore — optionalAuth never blocks
  }
  next();
};

// ─── RBAC: Restrict To Roles ───────────────────────────────────────────────────
const restrictTo = (...roles) => (req, res, next) => {
  if (!req.user) {
    return next(AppError.unauthorized('Please log in to access this resource.'));
  }

  if (!roles.includes(req.user.role)) {
    logger.securityEvent('UNAUTHORIZED_ROLE_ACCESS', {
      userId: req.user.id,
      userRole: req.user.role,
      requiredRoles: roles,
      endpoint: `${req.method} ${req.originalUrl}`,
      ip: req.ip,
    });

    return next(AppError.forbidden(
      `Access denied. Required role: ${roles.join(' or ')}.`,
      'INSUFFICIENT_ROLE'
    ));
  }

  next();
};

// ─── Convenience Role Shortcuts ───────────────────────────────────────────────
const adminOnly = restrictTo('ADMIN', 'SUPERADMIN');
const superAdminOnly = restrictTo('SUPERADMIN');

// ─── Email Verification Guard ──────────────────────────────────────────────────
const requireEmailVerified = (req, res, next) => {
  if (!req.user?.isEmailVerified) {
    return next(AppError.forbidden(
      'Please verify your email address before accessing this feature. Check your inbox.',
      'EMAIL_NOT_VERIFIED'
    ));
  }
  next();
};

// ─── Phone Verification Guard ──────────────────────────────────────────────────
const requirePhoneVerified = (req, res, next) => {
  if (!req.user?.isPhoneVerified) {
    return next(AppError.forbidden(
      'Please verify your phone number to access this feature.',
      'PHONE_NOT_VERIFIED'
    ));
  }
  next();
};

// ─── Owner or Admin Guard ─────────────────────────────────────────────────────
/**
 * Allow access if user owns the resource OR is admin.
 *
 * Usage:
 *   ownerOrAdmin('userId')           — looks at req.params.userId
 *   ownerOrAdmin(async (req) => req.params.userId) — async resolver
 */
const ownerOrAdmin = (getUserId) => async (req, res, next) => {
  try {
    if (!req.user) {
      return next(AppError.unauthorized('Please log in.'));
    }

    // Admins bypass ownership check
    if (['ADMIN', 'SUPERADMIN'].includes(req.user.role)) {
      return next();
    }

    const resourceOwnerId =
      typeof getUserId === 'function'
        ? await getUserId(req)
        : req.params[getUserId] || req.body[getUserId];

    if (req.user.id === resourceOwnerId) {
      return next();
    }

    return next(AppError.forbidden(
      'You can only access your own resources.',
      'NOT_RESOURCE_OWNER'
    ));
  } catch (error) {
    next(error);
  }
};

// ─── Refresh Token Guard ───────────────────────────────────────────────────────
/**
 * Validates presence of refresh token cookie/body.
 * Used specifically on /auth/refresh to give cleaner error messages.
 */
const refreshGuard = (req, res, next) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) {
    return next(AppError.unauthorized(
      'No refresh token provided. Please log in again.',
      'NO_REFRESH_TOKEN'
    ));
  }
  next();
};

// ─── Self or Specific Roles ────────────────────────────────────────────────────
/**
 * Allow access if requester IS the target user, or has one of the specified roles
 */
const selfOrRoles = (paramKey, ...roles) => async (req, res, next) => {
  try {
    if (!req.user) return next(AppError.unauthorized('Please log in.'));
    if (roles.includes(req.user.role)) return next();

    const targetId = req.params[paramKey] || req.body[paramKey];
    if (req.user.id === targetId) return next();

    return next(AppError.forbidden('Access denied.', 'ACCESS_DENIED'));
  } catch (error) {
    next(error);
  }
};

module.exports = {
  protect,
  optionalAuth,
  restrictTo,
  adminOnly,
  superAdminOnly,
  requireEmailVerified,
  requirePhoneVerified,
  ownerOrAdmin,
  refreshGuard,
  selfOrRoles,
};
