/**
 * routes/auth.routes.js  [ENTERPRISE EDITION]
 * =============================================
 * Complete authentication routing with per-route
 * rate limiting, validation, and security middleware.
 */

'use strict';

const { Router } = require('express');
const rateLimit = require('express-rate-limit');

const authController = require('../controllers/auth.controller');
const googleController = require('../controllers/auth.google.controller');
const { protect, restrictTo } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  sendOTPSchema,
  verifyOTPSchema,
  otpLoginSchema,
  adminLoginSchema,
} = require('../validations/auth.validation');

const router = Router();

// ─── Rate Limiters ─────────────────────────────────────────────────────────────
const makeRateLimiter = (max, windowMin, message) =>
  rateLimit({
    max,
    windowMs: windowMin * 60 * 1000,
    message: { success: false, message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
  });

// Different limits per endpoint sensitivity
const authLimiter         = makeRateLimiter(10, 15, 'Too many auth attempts. Try again in 15 minutes.');
const registerLimiter     = makeRateLimiter(5, 60,  'Too many registrations. Try again in 1 hour.');
const otpRequestLimiter   = makeRateLimiter(5, 10,  'Too many OTP requests. Try again in 10 minutes.');
const forgotPassLimiter   = makeRateLimiter(3, 60,  'Too many password reset requests. Try again in 1 hour.');
const refreshLimiter      = makeRateLimiter(30, 15, 'Too many token refresh requests.');
const adminLoginLimiter   = makeRateLimiter(5, 30,  'Too many admin login attempts. Try again in 30 minutes.');
const googleLimiter       = makeRateLimiter(20, 15, 'Too many Google sign-in attempts. Try again in 15 minutes.');

// ─── Public Routes ─────────────────────────────────────────────────────────────

// POST /auth/google — Google OAuth ID Token login/register
router.post('/google',
  googleLimiter,
  googleController.googleLogin
);

// POST /auth/firebase/login — Firebase Phone Auth login/register
router.post('/firebase/login',
  googleLimiter,
  authController.firebasePhoneLogin
);

// POST /auth/register
router.post('/register',
  registerLimiter,
  validate(registerSchema),
  authController.register
);

// POST /auth/login
router.post('/login',
  authLimiter,
  validate(loginSchema),
  authController.login
);

// POST /auth/otp/send
router.post('/otp/send',
  otpRequestLimiter,
  validate(sendOTPSchema),
  authController.sendOTP
);

// POST /auth/otp/login  — Passwordless login via OTP
router.post('/otp/login',
  authLimiter,
  validate(otpLoginSchema),
  authController.otpLogin
);

// POST /auth/otp/verify  — Verify OTP for email/phone verification
router.post('/otp/verify',
  authLimiter,
  validate(verifyOTPSchema),
  authController.verifyOTP
);

// GET /auth/verify-email/:token
router.get('/verify-email/:token', authController.verifyEmail);

// POST /auth/refresh
router.post('/refresh',
  refreshLimiter,
  authController.refreshToken
);

// POST /auth/forgot-password
router.post('/forgot-password',
  forgotPassLimiter,
  validate(forgotPasswordSchema),
  authController.forgotPassword
);

// POST /auth/reset-password/:token
router.post('/reset-password/:token',
  authLimiter,
  validate(resetPasswordSchema),
  authController.resetPassword
);

// ─── Admin Auth ─────────────────────────────────────────────────────────────────

// POST /auth/admin/login
router.post('/admin/login',
  adminLoginLimiter,
  validate(adminLoginSchema),
  authController.adminLogin
);

// ─── Protected Routes (require valid JWT) ─────────────────────────────────────

// POST /auth/logout
router.post('/logout',
  protect,
  authController.logout
);

// POST /auth/logout-all  — Logout from all devices
router.post('/logout-all',
  protect,
  authController.logoutAll
);

// GET /auth/me
router.get('/me',
  protect,
  authController.getMe
);

// POST /auth/change-password
router.post('/change-password',
  protect,
  authLimiter,
  validate(changePasswordSchema),
  authController.changePassword
);

// GET /auth/sessions  — List active sessions
router.get('/sessions',
  protect,
  authController.getSessions
);

// DELETE /auth/sessions/:sessionId  — Revoke a specific session
router.delete('/sessions/:sessionId',
  protect,
  authController.revokeSession
);

module.exports = router;
