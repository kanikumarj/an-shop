/**
 * utils/AppError.js  [ENTERPRISE EDITION]
 * ==========================================
 * Custom error class with typed factory methods,
 * error codes, and full HTTP status coverage.
 */

'use strict';

class AppError extends Error {
  /**
   * @param {string} message   — Human-readable error message
   * @param {number} statusCode — HTTP status code
   * @param {string} code      — Machine-readable error code (e.g., 'VALIDATION_ERROR')
   * @param {*} details        — Additional structured data (e.g., validation errors)
   */
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);

    this.statusCode = statusCode;
    this.status = statusCode >= 400 && statusCode < 500 ? 'fail' : 'error';
    this.code = code || AppError._inferCode(statusCode);
    this.details = details;
    this.isOperational = true;  // Operational errors: safe to send details to client

    Error.captureStackTrace(this, this.constructor);
  }

  // ─── HTTP Status Code → Default Code Map ────────────────────────────────────
  static _inferCode(statusCode) {
    const codes = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      405: 'METHOD_NOT_ALLOWED',
      408: 'REQUEST_TIMEOUT',
      409: 'CONFLICT',
      410: 'GONE',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
      422: 'VALIDATION_ERROR',
      429: 'TOO_MANY_REQUESTS',
      500: 'INTERNAL_SERVER_ERROR',
      501: 'NOT_IMPLEMENTED',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
    };
    return codes[statusCode] || 'ERROR';
  }

  // ─── Factory Methods ─────────────────────────────────────────────────────────

  /** 400 Bad Request */
  static badRequest(message = 'Bad request.', code = 'BAD_REQUEST', details = null) {
    return new AppError(message, 400, code, details);
  }

  /** 401 Unauthorized */
  static unauthorized(message = 'Authentication required.', code = 'UNAUTHORIZED') {
    return new AppError(message, 401, code);
  }

  /** 403 Forbidden */
  static forbidden(message = 'Access denied.', code = 'FORBIDDEN') {
    return new AppError(message, 403, code);
  }

  /** 404 Not Found */
  static notFound(resource = 'Resource') {
    return new AppError(`${resource} not found.`, 404, 'NOT_FOUND');
  }

  /** 405 Method Not Allowed */
  static methodNotAllowed(method, path) {
    return new AppError(
      `Method ${method} not allowed on ${path}.`,
      405,
      'METHOD_NOT_ALLOWED'
    );
  }

  /** 409 Conflict */
  static conflict(message = 'Resource already exists.', code = 'CONFLICT') {
    return new AppError(message, 409, code);
  }

  /** 410 Gone */
  static gone(message = 'Resource no longer available.') {
    return new AppError(message, 410, 'GONE');
  }

  /** 413 Payload Too Large */
  static payloadTooLarge(message = 'Request payload too large.') {
    return new AppError(message, 413, 'PAYLOAD_TOO_LARGE');
  }

  /** 422 Unprocessable Entity */
  static unprocessable(message = 'Validation failed.', details = null) {
    return new AppError(message, 422, 'VALIDATION_ERROR', details);
  }

  /** 429 Too Many Requests */
  static tooManyRequests(message = 'Too many requests. Please slow down.', retryAfter = null) {
    const err = new AppError(message, 429, 'TOO_MANY_REQUESTS');
    if (retryAfter) err.retryAfter = retryAfter;
    return err;
  }

  /** 500 Internal Server Error */
  static internal(message = 'An unexpected error occurred.') {
    const err = new AppError(message, 500, 'INTERNAL_SERVER_ERROR');
    err.isOperational = false;
    return err;
  }

  /** 501 Not Implemented */
  static notImplemented(feature = 'Feature') {
    return new AppError(`${feature} is not yet implemented.`, 501, 'NOT_IMPLEMENTED');
  }

  /** 503 Service Unavailable */
  static serviceUnavailable(service = 'Service') {
    return new AppError(`${service} is temporarily unavailable.`, 503, 'SERVICE_UNAVAILABLE');
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────
  toJSON() {
    return {
      success: false,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      ...(this.details && { details: this.details }),
    };
  }

  toString() {
    return `[${this.statusCode}] ${this.code}: ${this.message}`;
  }
}

module.exports = AppError;
