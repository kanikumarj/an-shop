/**
 * utils/helpers.js
 * =================
 * General-purpose utility functions used across the app.
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ─── Password Utilities ────────────────────────────────────────────────────────
const hashPassword = async (password) => {
  const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS) || 12;
  return bcrypt.hash(password, rounds);
};

const comparePassword = async (plaintext, hashed) => {
  return bcrypt.compare(plaintext, hashed);
};

// ─── OTP Generation ───────────────────────────────────────────────────────────
const generateOTP = (length = 6) => {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
};

const generateSecureOTP = (length = 6) => {
  const max = Math.pow(10, length);
  const buffer = crypto.randomBytes(4);
  const otp = (buffer.readUInt32BE(0) % max).toString().padStart(length, '0');
  return otp;
};

// ─── String Utilities ─────────────────────────────────────────────────────────
const slugify = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
};

const capitalize = (str) =>
  str ? str.charAt(0).toUpperCase() + str.slice(1).toLowerCase() : '';

const truncate = (str, length = 100, suffix = '...') => {
  if (!str || str.length <= length) return str;
  return str.substring(0, length - suffix.length) + suffix;
};

// ─── Number/Currency Utilities ────────────────────────────────────────────────
const formatCurrency = (amount, currency = 'INR') => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
};

const roundTo = (num, decimals = 2) => {
  return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals);
};

const calculateTax = (amount, taxRate = null) => {
  const rate = taxRate ?? parseFloat(process.env.TAX_RATE) ?? 0.18;
  const tax = roundTo(amount * rate);
  const total = roundTo(amount + tax);
  return { subtotal: roundTo(amount), tax, total, taxRate: rate };
};

const calculateShipping = (subtotal) => {
  const threshold = parseFloat(process.env.FREE_SHIPPING_THRESHOLD) || 500;
  const charge = parseFloat(process.env.DEFAULT_SHIPPING_CHARGE) || 50;
  return subtotal >= threshold ? 0 : charge;
};

// ─── Order/Reference Utilities ─────────────────────────────────────────────────
const generateOrderNumber = () => {
  const prefix = 'AN';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

const generateTransactionId = () => {
  return `TXN-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
};

// ─── Date Utilities ────────────────────────────────────────────────────────────
const addMinutes = (date, minutes) =>
  new Date(date.getTime() + minutes * 60 * 1000);

const addDays = (date, days) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const isExpired = (date) => new Date() > new Date(date);

const formatDate = (date, locale = 'en-IN') =>
  new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));

// ─── Object Utilities ─────────────────────────────────────────────────────────
const pick = (obj, keys) => {
  return keys.reduce((result, key) => {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      result[key] = obj[key];
    }
    return result;
  }, {});
};

const omit = (obj, keys) => {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
};

const removeUndefined = (obj) => {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
};

// ─── Phone Number Utilities ────────────────────────────────────────────────────
const formatPhoneNumber = (phone) => {
  // Normalize to E.164 format for India
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) return `+91${cleaned}`;
  if (cleaned.length === 12 && cleaned.startsWith('91')) return `+${cleaned}`;
  return phone;
};

const maskPhone = (phone) => {
  if (!phone || phone.length < 6) return phone;
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
};

const maskEmail = (email) => {
  if (!email) return email;
  const [user, domain] = email.split('@');
  const masked = user.slice(0, 2) + '***';
  return `${masked}@${domain}`;
};

const isValidIndianPhone = (phone) => {
  const cleaned = phone.replace(/\D/g, '');
  return /^[6-9]\d{9}$/.test(cleaned) || /^91[6-9]\d{9}$/.test(cleaned);
};

// ─── Security Utilities ───────────────────────────────────────────────────────
/**
 * Constant-time string comparison (prevents timing attacks)
 */
const safeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * Generate a cryptographically secure random token
 */
const generateSecureToken = (bytes = 32) => {
  return crypto.randomBytes(bytes).toString('hex');
};

module.exports = {
  // Auth
  hashPassword,
  comparePassword,
  generateOTP,
  generateSecureOTP,
  generateSecureToken,
  safeCompare,
  // String
  slugify,
  capitalize,
  truncate,
  // Currency
  formatCurrency,
  roundTo,
  calculateTax,
  calculateShipping,
  // References
  generateOrderNumber,
  generateTransactionId,
  // Dates
  addMinutes,
  addDays,
  isExpired,
  formatDate,
  // Objects
  pick,
  omit,
  removeUndefined,
  // Phone/Email
  formatPhoneNumber,
  maskPhone,
  maskEmail,
  isValidIndianPhone,
};
