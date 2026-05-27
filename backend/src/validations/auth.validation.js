/**
 * validations/auth.validation.js  [ENTERPRISE EDITION]
 * ======================================================
 * Comprehensive Zod validation schemas for all auth endpoints.
 */

'use strict';

const { z } = require('zod');

// ─── Shared Field Validators ───────────────────────────────────────────────────
const emailField = z
  .string({ required_error: 'Email is required.' })
  .email('Please enter a valid email address.')
  .toLowerCase()
  .trim()
  .max(254, 'Email address is too long.');

const passwordField = z
  .string({ required_error: 'Password is required.' })
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter.')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter.')
  .regex(/\d/, 'Password must contain at least one number.')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character (!@#$...)');

const phoneField = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number (starts with 6-9).')
  .optional();

const otpField = (len = 6) =>
  z
    .string({ required_error: 'OTP is required.' })
    .length(len, `OTP must be exactly ${len} digits.`)
    .regex(/^\d+$/, 'OTP must contain digits only.');

// ─── Schemas ───────────────────────────────────────────────────────────────────

/**
 * POST /auth/register
 */
exports.registerSchema = z
  .object({
    name: z
      .string({ required_error: 'Full name is required.' })
      .min(2, 'Name must be at least 2 characters.')
      .max(50, 'Name must not exceed 50 characters.')
      .trim()
      .regex(/^[a-zA-Z\s.'-]+$/, 'Name contains invalid characters.'),
    email: emailField,
    password: passwordField,
    confirmPassword: z.string({ required_error: 'Please confirm your password.' }),
    phone: phoneField,
    referralCode: z
      .string()
      .length(8, 'Referral code must be 8 characters.')
      .toUpperCase()
      .optional(),
    agreeToTerms: z
      .boolean()
      .refine((v) => v === true, 'You must agree to the Terms and Conditions.'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

/**
 * POST /auth/login
 */
exports.loginSchema = z.object({
  email: emailField,
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, 'Password cannot be empty.'),
  rememberMe: z.boolean().optional().default(false),
});

/**
 * POST /auth/otp/send
 */
exports.sendOTPSchema = z.object({
  identifier: z.union(
    [
      z.string().email('Invalid email address.').toLowerCase().trim(),
      z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number.'),
    ],
    { errorMap: () => ({ message: 'Please provide a valid email or 10-digit phone number.' }) }
  ),
  type: z
    .enum(['login', 'email_verify', 'phone_verify', 'password_reset'], {
      errorMap: () => ({ message: 'Invalid OTP type.' }),
    })
    .default('login'),
  channel: z.enum(['email', 'whatsapp', 'sms']).optional(),
});

/**
 * POST /auth/otp/login
 */
exports.otpLoginSchema = z.object({
  identifier: z.union([
    z.string().email().toLowerCase().trim(),
    z.string().regex(/^[6-9]\d{9}$/),
  ], {
    errorMap: () => ({ message: 'Provide a valid email or phone number.' }),
  }),
  otp: otpField(parseInt(process.env.OTP_LENGTH) || 6),
});

/**
 * POST /auth/otp/verify
 */
exports.verifyOTPSchema = z.object({
  identifier: z.union([
    z.string().email().toLowerCase().trim(),
    z.string().regex(/^[6-9]\d{9}$/),
  ]),
  otp: otpField(parseInt(process.env.OTP_LENGTH) || 6),
  type: z.enum(['login', 'email_verify', 'phone_verify', 'password_reset']).default('email_verify'),
});

/**
 * POST /auth/forgot-password
 */
exports.forgotPasswordSchema = z.object({
  email: emailField,
});

/**
 * POST /auth/reset-password/:token
 */
exports.resetPasswordSchema = z
  .object({
    password: passwordField,
    confirmPassword: z.string({ required_error: 'Please confirm your new password.' }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match.',
    path: ['confirmPassword'],
  });

/**
 * POST /auth/change-password
 */
exports.changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ required_error: 'Current password is required.' })
      .min(1, 'Current password cannot be empty.'),
    newPassword: passwordField,
    confirmPassword: z.string({ required_error: 'Please confirm your new password.' }),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'New passwords do not match.',
    path: ['confirmPassword'],
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from the current password.',
    path: ['newPassword'],
  });

/**
 * POST /auth/admin/login
 */
exports.adminLoginSchema = z.object({
  email: emailField,
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, 'Password cannot be empty.'),
  adminKey: z.string().optional(),
});
