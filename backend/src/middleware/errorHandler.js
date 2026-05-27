/**
 * middleware/errorHandler.js
 * ============================
 * Global error handler — converts every error type into a clean JSON response.
 *
 * Handles:
 *   - Prisma ORM errors (unique, not found, validation, constraint)
 *   - JWT errors (expired, invalid, not before)
 *   - Zod validation errors
 *   - Multer file upload errors
 *   - Generic operational errors (AppError)
 *   - Unknown system errors (logs full stack, returns 500)
 */

'use strict';

const { Prisma } = require('@prisma/client');
const { ZodError } = require('zod');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

// ─── Production: minimal error info ──────────────────────────────────────────
const sendProd = (res, err) => {
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code || undefined,
      ...(err.details && { details: err.details }),
    });
  }

  // Programming error — don't leak details
  logger.error('💥 UNHANDLED ERROR:', {
    message: err.message,
    stack: err.stack,
    name: err.name,
  });

  return res.status(500).json({
    success: false,
    message: 'An unexpected error occurred. Please try again later.',
    code: 'INTERNAL_SERVER_ERROR',
  });
};

// ─── Development: full error info ─────────────────────────────────────────────
const sendDev = (res, err) => {
  return res.status(err.statusCode || 500).json({
    success: false,
    message: err.message,
    code: err.code,
    stack: err.stack,
    details: err.details,
    isOperational: err.isOperational,
  });
};

// ─── Error Transformers ───────────────────────────────────────────────────────

const handlePrismaError = (err) => {
  // Unique constraint violation
  if (err.code === 'P2002') {
    const fields = err.meta?.target?.join(', ') || 'field';
    return new AppError(`This ${fields} is already in use.`, 409, 'DUPLICATE_ENTRY');
  }

  // Record not found
  if (err.code === 'P2001' || err.code === 'P2025') {
    return new AppError('The requested record was not found.', 404, 'NOT_FOUND');
  }

  // Foreign key violation
  if (err.code === 'P2003') {
    const field = err.meta?.field_name || 'reference';
    return new AppError(`Invalid ${field}: referenced record does not exist.`, 400, 'FOREIGN_KEY_VIOLATION');
  }

  // Required field missing
  if (err.code === 'P2011') {
    const field = err.meta?.constraint || 'field';
    return new AppError(`${field} is required.`, 400, 'REQUIRED_FIELD_MISSING');
  }

  // Value too long
  if (err.code === 'P2000') {
    return new AppError('Input value is too long for this field.', 400, 'VALUE_TOO_LONG');
  }

  // Invalid value type
  if (err.code === 'P2005' || err.code === 'P2006') {
    return new AppError('Invalid data format provided.', 400, 'INVALID_DATA_FORMAT');
  }

  // Connection issues
  if (err.code === 'P1001' || err.code === 'P1002') {
    return new AppError('Database connection failed. Please try again.', 503, 'DB_CONNECTION_ERROR');
  }

  return new AppError('Database error occurred.', 500, 'DATABASE_ERROR');
};

const handleJWTError = (err) => {
  if (err.name === 'TokenExpiredError') {
    return new AppError('Session expired. Please log in again.', 401, 'TOKEN_EXPIRED');
  }
  if (err.name === 'JsonWebTokenError') {
    return new AppError('Invalid authentication token.', 401, 'TOKEN_INVALID');
  }
  if (err.name === 'NotBeforeError') {
    return new AppError('Token not yet active.', 401, 'TOKEN_NOT_ACTIVE');
  }
  return new AppError('Authentication failed.', 401, 'AUTH_FAILED');
};

const handleZodError = (err) => {
  const details = err.errors.map((e) => ({
    field: e.path.join('.') || 'body',
    message: e.message,
    code: e.code,
  }));

  const firstMessage = details[0]?.message || 'Validation failed.';

  const appErr = new AppError(firstMessage, 422, 'VALIDATION_ERROR');
  appErr.details = details;
  return appErr;
};

const handleMulterError = (err) => {
  const multerMessages = {
    LIMIT_FILE_SIZE: `File too large. Maximum size is ${err.field || '10MB'}.`,
    LIMIT_FILE_COUNT: 'Too many files. Reduce the number of uploaded files.',
    LIMIT_UNEXPECTED_FILE: 'Unexpected file field name.',
    LIMIT_PART_COUNT: 'Too many form parts.',
  };

  const message = multerMessages[err.code] || 'File upload error.';
  return new AppError(message, 400, err.code || 'UPLOAD_ERROR');
};

// ─── Global Error Handler ─────────────────────────────────────────────────────
const globalErrorHandler = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  // Log all errors (level based on status)
  const logLevel = err.statusCode >= 500 ? 'error' : 'warn';
  logger[logLevel](`${err.statusCode} ${req.method} ${req.originalUrl}`, {
    message: err.message,
    code: err.code,
    userId: req.user?.id,
    ip: req.ip,
    correlationId: req.correlationId,
    ...(err.statusCode >= 500 && { stack: err.stack }),
  });

  // Transform known error types
  let transformedErr = err;

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    transformedErr = handlePrismaError(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    transformedErr = new AppError('Invalid data format sent to database.', 400, 'PRISMA_VALIDATION_ERROR');
  } else if (err instanceof Prisma.PrismaClientInitializationError) {
    transformedErr = new AppError('Database initialization failed.', 503, 'DB_INIT_ERROR');
  } else if (err instanceof ZodError) {
    transformedErr = handleZodError(err);
  } else if (err.name === 'MulterError') {
    transformedErr = handleMulterError(err);
  } else if (['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'].includes(err.name)) {
    transformedErr = handleJWTError(err);
  } else if (err.type === 'entity.parse.failed') {
    transformedErr = new AppError('Invalid JSON in request body.', 400, 'INVALID_JSON');
  } else if (err.code === 'EBADCSRFTOKEN') {
    transformedErr = new AppError('Invalid CSRF token. Please refresh the page.', 403, 'CSRF_ERROR');
  }

  if (process.env.NODE_ENV === 'development') {
    return sendDev(res, transformedErr);
  }

  return sendProd(res, transformedErr);
};

// ─── 404 Not Found Handler ────────────────────────────────────────────────────
const notFoundHandler = (req, res, next) => {
  next(new AppError(
    `Route not found: ${req.method} ${req.originalUrl}`,
    404,
    'ROUTE_NOT_FOUND'
  ));
};

module.exports = { globalErrorHandler, notFoundHandler };
