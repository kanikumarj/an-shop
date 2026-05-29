/**
 * controllers/auth.controller.js  [ENTERPRISE EDITION]
 * ======================================================
 * Complete authentication controller with all security features:
 *
 * Public routes:
 *   POST /auth/register          — Email/password registration
 *   POST /auth/login             — Email/password login + lockout guard
 *   POST /auth/otp/send          — Request OTP (email or WhatsApp)
 *   POST /auth/otp/login         — Passwordless OTP login
 *   POST /auth/otp/verify        — Verify OTP for a purpose
 *   POST /auth/refresh           — Rotate refresh token
 *   POST /auth/forgot-password   — Send password reset link
 *   POST /auth/reset-password    — Apply new password via reset token
 *   GET  /auth/verify-email/:t   — Click-link email verification
 *
 * Protected routes (require valid access token):
 *   POST /auth/logout            — Revoke current session
 *   POST /auth/logout-all        — Revoke all sessions (all devices)
 *   POST /auth/change-password   — Change password
 *   GET  /auth/me                — Current user profile
 *   GET  /auth/sessions          — List active sessions
 *   DELETE /auth/sessions/:id    — Revoke a specific session
 *
 * Admin routes (ADMIN + SUPERADMIN):
 *   POST /auth/admin/login       — Admin login with stricter checks
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
  isExpired,
  maskEmail,
  maskPhone,
  formatPhoneNumber,
  isValidIndianPhone,
} = require('../utils/helpers');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  getRefreshCookieOptions,
  getAccessCookieOptions,
} = require('../utils/jwt');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

const emailService = require('../services/email.service');
const whatsappService = require('../services/whatsapp.service');
const notificationService = require('../services/notification.service');
const authService = require('../services/auth.service');

// ─── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Send both access + refresh tokens as HTTP-only cookies and in response body
 */
const sendAuthResponse = async (res, user, statusCode, message, req) => {
  const { accessToken, refreshToken } = await authService.issueTokenPair(user, req);

  // Set HTTP-only cookies
  res.cookie('accessToken', accessToken, getAccessCookieOptions());
  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());

  const { password, otp, otpExpiry, otpType, ...safeUser } = user;

  return res.status(statusCode).json({
    success: true,
    message,
    data: {
      user: safeUser,
      accessToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    },
  });
};

// ═══════════════════════════════════════════════════════════
//   REGISTRATION
// ═══════════════════════════════════════════════════════════

exports.register = async (req, res) => {
  const { name, email, password, phone, referralCode } = req.body;

  // 1. Duplicate check (email)
  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true },
  });
  if (existing) {
    throw AppError.conflict('An account with this email already exists.');
  }

  // 2. Duplicate check (phone)
  let formattedPhone = null;
  if (phone) {
    formattedPhone = formatPhoneNumber(phone);
    const phoneExists = await prisma.user.findUnique({
      where: { phone: formattedPhone },
      select: { id: true },
    });
    if (phoneExists) throw AppError.conflict('This phone number is already registered.');
  }

  // 3. Validate referral code (if provided)
  let referredById = null;
  if (referralCode) {
    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.toUpperCase() },
      select: { id: true },
    });
    if (!referrer) throw AppError.badRequest('Invalid referral code.');
    referredById = referrer.id;
  }

  // 4. Hash password
  const hashedPassword = await hashPassword(password);

  // 5. Create user
  const user = await prisma.user.create({
    data: {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      phone: formattedPhone,
      referredById,
      isActive: true,
      isEmailVerified: true,
      isPhoneVerified: true,
    },
  });

  // 6. Create + send email verification OTP
  const { code: verifyCode } = await authService.createOtp({
    userId: user.id,
    type: 'email_verify',
    channel: 'email',
    target: user.email,
    req,
  });

  // 7. Fire-and-forget: emails, WhatsApp, notification
  setImmediate(async () => {
    try {
      const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verifyCode}`;
      await emailService.sendWelcomeEmail(user, verifyUrl);
    } catch (e) {
      logger.warn('Welcome email failed', { error: e.message, userId: user.id });
    }

    if (formattedPhone) {
      try {
        await whatsappService.sendWelcomeMessage(user);
      } catch (e) {
        logger.warn('WhatsApp welcome failed', { error: e.message });
      }
    }

    notificationService.createNotification({
      userId: user.id,
      type: 'WELCOME',
      title: `Welcome to ${process.env.SHOP_NAME || 'An Shop'}! 🎉`,
      message: 'Explore our premium homemade snacks!',
    }).catch(() => {});
  });

  logger.apiEvent('USER_REGISTERED', {
    userId: user.id,
    email: maskEmail(email),
    ip: req.ip,
    referral: !!referredById,
  });

  return sendAuthResponse(res, user, 201, 'Account created successfully! Welcome aboard 🎉', req);
};

// ═══════════════════════════════════════════════════════════
//   EMAIL + PASSWORD LOGIN
// ═══════════════════════════════════════════════════════════

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const identifier = email.toLowerCase().trim();

  // 1. Check account lockout
  const lockStatus = await authService.checkLockout(identifier);
  if (lockStatus.locked) {
    const minutes = Math.ceil(lockStatus.remainingSeconds / 60);
    throw AppError.tooManyRequests(
      `Account temporarily locked due to too many failed attempts. Try again in ${minutes} minute(s).`
    );
  }

  // 2. Find user
  const user = await prisma.user.findUnique({ where: { email: identifier } });

  // 3. Validate credentials
  if (!user || !(await comparePassword(password, user.password))) {
    const result = await authService.recordFailedAttempt(identifier, req.ip);

    if (result.locked) {
      throw AppError.tooManyRequests(
        `Too many failed attempts. Account locked for ${authService.LOCK_CONFIG.LOCKOUT_MINUTES} minutes.`
      );
    }

    throw AppError.unauthorized(
      `Invalid email or password.${result.remaining ? ` ${result.remaining} attempt(s) left before lockout.` : ''}`
    );
  }

  // 4. Account health checks
  if (!user.isActive) {
    throw AppError.forbidden('Account deactivated. Contact support to reactivate.');
  }
  if (user.isBanned) {
    throw AppError.forbidden(`Account banned. Reason: ${user.banReason || 'Policy violation'}. Contact support.`);
  }
  if (!user.isEmailVerified) {
    throw AppError.forbidden('Please verify your email address before logging in. Check your inbox.');
  }

  // 5. Clear lockout counters on success
  await authService.clearFailedAttempts(identifier);

  // 6. Update login stats (fire-and-forget)
  prisma.user.update({
    where: { id: user.id },
    data: {
      lastLogin: new Date(),
      lastLoginIp: req.ip,
      loginCount: { increment: 1 },
    },
  }).catch(() => {});

  logger.apiEvent('USER_LOGIN', {
    userId: user.id,
    email: maskEmail(email),
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  return sendAuthResponse(res, user, 200, 'Login successful! Welcome back 👋', req);
};

// ═══════════════════════════════════════════════════════════
//   OTP: SEND
// ═══════════════════════════════════════════════════════════

exports.sendOTP = async (req, res) => {
  const { identifier, type = 'login', channel } = req.body;

  // Always return same response to prevent user enumeration
  const safeResponse = () => ApiResponse.success(res, {
    masked: identifier.includes('@') ? maskEmail(identifier) : maskPhone(identifier),
    expiresIn: `${authService.OTP_CONFIG.EXPIRY_MINUTES} minutes`,
    channel: channel || (identifier.includes('@') ? 'email' : 'whatsapp'),
  }, 'If an account exists, an OTP has been sent.');

  const user = await authService.findUserByIdentifier(identifier);
  if (!user) return safeResponse(); // Silent no-op

  if (!user.isActive || user.isBanned) return safeResponse();

  // Rate limit: max 3 OTPs per 10 minutes
  const rateLimitKey = `otp:rate:${user.id}:${type}`;
  const sendCount = await cache.get(rateLimitKey);
  if (sendCount && sendCount.count >= 3) {
    throw AppError.tooManyRequests('Too many OTP requests. Please wait 10 minutes.');
  }
  await cache.set(rateLimitKey,
    { count: (sendCount?.count || 0) + 1 },
    10 * 60
  );

  const isEmail = identifier.includes('@');
  const deliveryChannel = channel || (isEmail ? 'email' : 'whatsapp');
  const target = isEmail ? user.email : user.phone;

  const { code } = await authService.createOtp({
    userId: user.id,
    type,
    channel: deliveryChannel,
    target,
    req,
  });

  // Deliver OTP
  try {
    if (deliveryChannel === 'email' || isEmail) {
      await emailService.sendOTPEmail(target, code);
    } else {
      await whatsappService.sendOTP(target, code);
    }
  } catch (err) {
    logger.warn('OTP delivery failed', { error: err.message, userId: user.id });
  }

  logger.apiEvent('OTP_SENT', {
    userId: user.id,
    type,
    channel: deliveryChannel,
    ip: req.ip,
  });

  return safeResponse();
};

// ═══════════════════════════════════════════════════════════
//   OTP: PASSWORDLESS LOGIN
// ═══════════════════════════════════════════════════════════

exports.otpLogin = async (req, res) => {
  const { identifier, otp } = req.body;

  // Check lockout
  const lockStatus = await authService.checkLockout(identifier);
  if (lockStatus.locked) {
    const minutes = Math.ceil(lockStatus.remainingSeconds / 60);
    throw AppError.tooManyRequests(`Too many failed attempts. Try again in ${minutes} minute(s).`);
  }

  const user = await authService.findUserByIdentifier(identifier);

  if (!user) {
    await authService.recordFailedAttempt(identifier, req.ip);
    throw AppError.unauthorized('Invalid credentials.');
  }

  // Verify OTP
  try {
    await authService.verifyOtp({ userId: user.id, code: otp, type: 'login' });
  } catch (err) {
    await authService.recordFailedAttempt(identifier, req.ip);
    throw err;
  }

  // Health checks
  if (!user.isActive) throw AppError.forbidden('Account deactivated.');
  if (user.isBanned) throw AppError.forbidden(`Account banned: ${user.banReason || 'Contact support.'}`);

  await authService.clearFailedAttempts(identifier);

  // Mark verified (first OTP login verifies contact)
  const updates = { lastLogin: new Date(), lastLoginIp: req.ip, loginCount: { increment: 1 } };
  if (identifier.includes('@') && !user.isEmailVerified) updates.isEmailVerified = true;
  if (!identifier.includes('@') && !user.isPhoneVerified) updates.isPhoneVerified = true;

  await prisma.user.update({ where: { id: user.id }, data: updates });

  logger.apiEvent('OTP_LOGIN', {
    userId: user.id,
    identifier: identifier.includes('@') ? maskEmail(identifier) : maskPhone(identifier),
    ip: req.ip,
  });

  return sendAuthResponse(res, user, 200, 'OTP login successful! Welcome back 👋', req);
};

// ═══════════════════════════════════════════════════════════
//   OTP: VERIFY (for account verification, not login)
// ═══════════════════════════════════════════════════════════

exports.verifyOTP = async (req, res) => {
  const { identifier, otp, type } = req.body;

  const user = await authService.findUserByIdentifier(identifier);
  if (!user) throw AppError.badRequest('Invalid credentials.');

  await authService.verifyOtp({ userId: user.id, code: otp, type });

  // Mark verified
  const updates = {};
  if (type === 'email_verify') updates.isEmailVerified = true;
  if (type === 'phone_verify') updates.isPhoneVerified = true;

  if (Object.keys(updates).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: updates });
  }

  logger.apiEvent('OTP_VERIFIED', { userId: user.id, type, ip: req.ip });
  ApiResponse.success(res, { verified: true, type }, 'Verified successfully.');
};

// ═══════════════════════════════════════════════════════════
//   EMAIL VERIFICATION (link-based)
// ═══════════════════════════════════════════════════════════

exports.verifyEmail = async (req, res) => {
  const { token } = req.params;

  const otpRecord = await prisma.otpToken.findFirst({
    where: {
      code: token,
      type: 'email_verify',
      isUsed: false,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true, name: true, isEmailVerified: true } } },
  });

  if (!otpRecord) throw AppError.badRequest('Invalid or expired verification link. Please request a new one.');
  if (otpRecord.user.isEmailVerified) {
    return ApiResponse.success(res, null, 'Email is already verified. Please log in.');
  }

  // Mark OTP used and verify email
  await Promise.all([
    prisma.otpToken.update({
      where: { id: otpRecord.id },
      data: { isUsed: true, usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: otpRecord.userId },
      data: { isEmailVerified: true },
    }),
  ]);

  notificationService.createNotification({
    userId: otpRecord.userId,
    type: 'EMAIL_VERIFIED',
    title: 'Email Verified ✅',
    message: 'Your email has been verified. You can now shop!',
  }).catch(() => {});

  logger.apiEvent('EMAIL_VERIFIED', { userId: otpRecord.userId, ip: req.ip });
  ApiResponse.success(res, null, 'Email verified successfully! You can now log in.');
};

// ═══════════════════════════════════════════════════════════
//   REFRESH TOKEN
// ═══════════════════════════════════════════════════════════

exports.refreshToken = async (req, res) => {
  const rawToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!rawToken) throw AppError.unauthorized('No refresh token provided.');

  const { tokens, user } = await authService.rotateRefreshToken(rawToken, req);

  // Set new cookies
  res.cookie('accessToken', tokens.accessToken, getAccessCookieOptions());
  res.cookie('refreshToken', tokens.refreshToken, getRefreshCookieOptions());

  ApiResponse.success(res, {
    accessToken: tokens.accessToken,
    tokenType: 'Bearer',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    user,
  }, 'Token refreshed.');
};

// ═══════════════════════════════════════════════════════════
//   FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  // Always respond the same — prevent user enumeration
  const safeMsg = 'If an account with that email exists, a password reset link has been sent.';

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, name: true, email: true, isActive: true },
  });

  if (user && user.isActive) {
    // Use OTP token table for reset tokens
    const { code: resetToken } = await authService.createOtp({
      userId: user.id,
      type: 'password_reset',
      channel: 'email',
      target: user.email,
      req,
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    emailService.sendPasswordResetEmail(user.email, resetUrl, user.name).catch((e) => {
      logger.warn('Password reset email failed', { error: e.message, userId: user.id });
    });

    logger.securityEvent('PASSWORD_RESET_REQUESTED', {
      userId: user.id,
      email: maskEmail(email),
      ip: req.ip,
    });
  }

  ApiResponse.success(res, null, safeMsg);
};

// ═══════════════════════════════════════════════════════════
//   RESET PASSWORD
// ═══════════════════════════════════════════════════════════

exports.resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  // Find the OTP record
  const otpRecord = await prisma.otpToken.findFirst({
    where: {
      code: token,
      type: 'password_reset',
      isUsed: false,
      expiresAt: { gt: new Date() },
    },
    include: { user: { select: { id: true, email: true } } },
  });

  if (!otpRecord) {
    throw AppError.badRequest('Invalid or expired password reset link. Please request a new one.');
  }

  const hashedPassword = await hashPassword(password);

  // Apply new password and mark OTP used — atomic transaction
  await prisma.$transaction([
    prisma.otpToken.update({
      where: { id: otpRecord.id },
      data: { isUsed: true, usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: otpRecord.userId },
      data: {
        password: hashedPassword,
        passwordChangedAt: new Date(),
      },
    }),
  ]);

  // Force logout all existing sessions (security: password changed)
  await authService.revokeAllUserTokens(otpRecord.userId, 'password_reset');

  // Blacklist all active access tokens by updating passwordChangedAt
  // (JWT middleware checks this automatically)

  logger.securityEvent('PASSWORD_RESET_COMPLETED', {
    userId: otpRecord.userId,
    email: maskEmail(otpRecord.user.email),
    ip: req.ip,
  });

  ApiResponse.success(res, null, 'Password reset successfully. Please log in with your new password.');
};

// ═══════════════════════════════════════════════════════════
//   CHANGE PASSWORD (authenticated)
// ═══════════════════════════════════════════════════════════

exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });

  if (!(await comparePassword(currentPassword, user.password))) {
    throw AppError.unauthorized('Current password is incorrect.');
  }

  const hashedPassword = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: { password: hashedPassword, passwordChangedAt: new Date() },
  });

  // Revoke other sessions (keep current)
  const rawToken = req.cookies?.refreshToken;
  if (rawToken) {
    const currentHash = authService.hashToken(rawToken);
    await prisma.refreshToken.updateMany({
      where: {
        userId: user.id,
        isRevoked: false,
        tokenHash: { not: currentHash },
      },
      data: { isRevoked: true, revokedAt: new Date(), revokedReason: 'password_changed' },
    });
  }

  logger.securityEvent('PASSWORD_CHANGED', { userId: user.id, ip: req.ip });
  ApiResponse.success(res, null, 'Password changed. Other sessions have been logged out for security.');
};

// ═══════════════════════════════════════════════════════════
//   LOGOUT
// ═══════════════════════════════════════════════════════════

exports.logout = async (req, res) => {
  // Blacklist current access token
  if (req.tokenData?.jti && req.tokenData?.exp) {
    await authService.blacklistAccessToken(req.tokenData.jti, req.tokenData.exp);
  }

  // Revoke refresh token
  const rawRefreshToken = req.cookies?.refreshToken;
  if (rawRefreshToken) {
    await authService.revokeRefreshToken(rawRefreshToken, 'logout');
  }

  // Clear cookies
  const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 0 };
  res.clearCookie('accessToken', cookieOpts);
  res.clearCookie('refreshToken', cookieOpts);

  logger.apiEvent('USER_LOGOUT', { userId: req.user?.id, ip: req.ip });
  ApiResponse.success(res, null, 'Logged out successfully.');
};

// ═══════════════════════════════════════════════════════════
//   LOGOUT ALL DEVICES
// ═══════════════════════════════════════════════════════════

exports.logoutAll = async (req, res) => {
  if (req.tokenData?.jti && req.tokenData?.exp) {
    await authService.blacklistAccessToken(req.tokenData.jti, req.tokenData.exp);
  }

  await authService.revokeAllUserTokens(req.user.id, 'logout_all');

  const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 0 };
  res.clearCookie('accessToken', cookieOpts);
  res.clearCookie('refreshToken', cookieOpts);

  logger.securityEvent('LOGOUT_ALL_DEVICES', { userId: req.user.id, ip: req.ip });
  ApiResponse.success(res, null, 'Logged out from all devices successfully.');
};

// ═══════════════════════════════════════════════════════════
//   CURRENT USER
// ═══════════════════════════════════════════════════════════

exports.getMe = async (req, res) => {
  const user = await authService.getSafeUser(req.user.id);
  ApiResponse.success(res, user, 'Profile retrieved.');
};

// ═══════════════════════════════════════════════════════════
//   SESSION MANAGEMENT
// ═══════════════════════════════════════════════════════════

exports.getSessions = async (req, res) => {
  const sessions = await authService.getActiveSessions(req.user.id);
  ApiResponse.success(res, sessions, `${sessions.length} active session(s).`);
};

exports.revokeSession = async (req, res) => {
  await authService.revokeSession(req.params.sessionId, req.user.id);
  ApiResponse.success(res, null, 'Session revoked.');
};

// ═══════════════════════════════════════════════════════════
//   ADMIN LOGIN (stricter security)
// ═══════════════════════════════════════════════════════════

exports.adminLogin = async (req, res) => {
  const { email, password, adminKey } = req.body;

  // Additional admin entry key (set in .env)
  if (process.env.ADMIN_ENTRY_KEY && adminKey !== process.env.ADMIN_ENTRY_KEY) {
    logger.securityEvent('ADMIN_LOGIN_INVALID_KEY', { email: maskEmail(email), ip: req.ip });
    throw AppError.unauthorized('Invalid admin credentials.');
  }

  const identifier = email.toLowerCase().trim();

  // Stricter lockout for admin (3 attempts vs 5)
  const lockStatus = await authService.checkLockout(`admin:${identifier}`);
  if (lockStatus.locked) {
    const minutes = Math.ceil(lockStatus.remainingSeconds / 60);
    throw AppError.tooManyRequests(`Admin account locked. Try again in ${minutes} minute(s).`);
  }

  const user = await prisma.user.findUnique({ where: { email: identifier } });

  if (!user || !(await comparePassword(password, user.password))) {
    await authService.recordFailedAttempt(`admin:${identifier}`, req.ip);
    throw AppError.unauthorized('Invalid admin credentials.');
  }

  // Verify admin role
  if (!['ADMIN', 'SUPERADMIN'].includes(user.role)) {
    logger.securityEvent('ADMIN_LOGIN_ROLE_MISMATCH', {
      userId: user.id,
      role: user.role,
      ip: req.ip,
    });
    throw AppError.forbidden('Insufficient privileges. Admin access required.');
  }

  if (!user.isActive || user.isBanned) {
    throw AppError.forbidden('Admin account is deactivated or banned.');
  }

  await authService.clearFailedAttempts(`admin:${identifier}`);

  // Update login stats
  prisma.user.update({
    where: { id: user.id },
    data: { lastLogin: new Date(), lastLoginIp: req.ip, loginCount: { increment: 1 } },
  }).catch(() => {});

  logger.securityEvent('ADMIN_LOGIN', {
    userId: user.id,
    email: maskEmail(email),
    role: user.role,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  return sendAuthResponse(res, user, 200, `Welcome back, ${user.name}. Admin login successful.`, req);
};
