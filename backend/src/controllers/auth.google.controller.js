/**
 * controllers/auth.google.controller.js
 * ========================================
 * Google OAuth2 — ID Token verification flow.
 *
 * Flow:
 *   Frontend gets a Google ID Token via Google Identity Services (GSI)
 *   → POST /auth/google  { idToken }
 *   → Backend verifies token with Google API
 *   → Find or create user in NeonDB
 *   → Return JWT access + refresh tokens
 */

'use strict';

const { OAuth2Client }  = require('google-auth-library');
const { prisma }        = require('../config/database');
const { hashPassword }  = require('../utils/helpers');
const { ApiResponse }   = require('../utils/ApiResponse');
const AppError          = require('../utils/AppError');
const logger            = require('../utils/logger');
const authService       = require('../services/auth.service');
const notificationService = require('../services/notification.service');
const {
  generateAccessToken,
  generateRefreshToken,
  getAccessCookieOptions,
  getRefreshCookieOptions,
} = require('../utils/jwt');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!CLIENT_ID || CLIENT_ID.includes('your_google')) {
  logger.warn('⚠️  GOOGLE_CLIENT_ID not configured — Google OAuth will be disabled.');
}

const client = CLIENT_ID && !CLIENT_ID.includes('your_google')
  ? new OAuth2Client(CLIENT_ID)
  : null;

// ─── Helper: issue tokens + send response ─────────────────────────────────────
const sendOAuthResponse = async (res, user, statusCode, message, req) => {
  const { accessToken, refreshToken } = await authService.issueTokenPair(user, req);

  res.cookie('accessToken',  accessToken,  getAccessCookieOptions());
  res.cookie('refreshToken', refreshToken, getRefreshCookieOptions());

  const { password, ...safeUser } = user;

  return res.status(statusCode).json({
    success: true,
    message,
    data: {
      user: safeUser,
      accessToken,
      tokenType: 'Bearer',
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
      isNewUser: !!user._isNewUser,
    },
  });
};

// ═══════════════════════════════════════════════════════════
//   POST /auth/google
//   Body: { idToken: string }
// ═══════════════════════════════════════════════════════════
exports.googleLogin = async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    throw AppError.badRequest('Google ID token is required.', 'MISSING_ID_TOKEN');
  }

  if (!client) {
    throw AppError.serviceUnavailable(
      'Google OAuth is not configured on this server.',
      'GOOGLE_OAUTH_DISABLED'
    );
  }

  // 1. Verify the ID token with Google
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn('Google ID token verification failed:', { error: err.message, ip: req.ip });
    throw AppError.unauthorized(
      'Invalid Google token. Please try signing in again.',
      'INVALID_GOOGLE_TOKEN'
    );
  }

  const { sub: googleId, email, name, picture, email_verified } = payload;

  if (!email) {
    throw AppError.badRequest('Could not retrieve email from Google account.', 'NO_GOOGLE_EMAIL');
  }

  // 2. Find existing user or create one
  let user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  let isNewUser = false;

  if (!user) {
    // New user — auto-register with a random password (they'll use Google to sign in)
    const randomPassword = await hashPassword(
      `google_${googleId}_${Date.now()}_${Math.random().toString(36)}`
    );

    user = await prisma.user.create({
      data: {
        name:            name || email.split('@')[0],
        email:           email.toLowerCase(),
        password:        randomPassword,
        avatar:          picture || null,
        isEmailVerified: !!email_verified,
        isActive:        true,
        role:            'CUSTOMER',
      },
    });

    isNewUser = true;
    logger.apiEvent('GOOGLE_OAUTH_REGISTER', {
      userId: user.id,
      email:  email,
      ip:     req.ip,
    });

    // Welcome notification (fire-and-forget)
    notificationService.createNotification({
      userId:  user.id,
      type:    'WELCOME',
      title:   '🎉 Welcome! You signed in with Google.',
      message: 'Explore our premium homemade snacks!',
    }).catch(() => {});

  } else {
    // Existing user — check not banned/inactive
    if (user.isBanned) {
      throw AppError.forbidden(
        'Your account has been banned. Please contact support.',
        'ACCOUNT_BANNED'
      );
    }
    if (!user.isActive) {
      throw AppError.forbidden(
        'Your account has been deactivated. Please contact support.',
        'ACCOUNT_INACTIVE'
      );
    }

    // Update avatar if they don't have one yet
    if (!user.avatar && picture) {
      user = await prisma.user.update({
        where: { id: user.id },
        data:  { avatar: picture, isEmailVerified: true, lastLogin: new Date() },
      });
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data:  { lastLogin: new Date(), lastLoginIp: req.ip },
      });
    }

    logger.apiEvent('GOOGLE_OAUTH_LOGIN', {
      userId: user.id,
      email:  email,
      ip:     req.ip,
    });
  }

  // Attach flag for response
  user._isNewUser = isNewUser;

  return sendOAuthResponse(
    res,
    user,
    isNewUser ? 201 : 200,
    isNewUser
      ? 'Account created successfully with Google! Welcome 🎉'
      : 'Signed in with Google successfully!',
    req
  );
};
