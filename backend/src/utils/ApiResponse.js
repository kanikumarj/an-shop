/**
 * utils/ApiResponse.js
 * =====================
 * Standardized API response builder for consistent JSON structure.
 */

'use strict';

class ApiResponse {
  /**
   * Send a success response
   */
  static success(res, data = null, message = 'Success', statusCode = 200, meta = {}) {
    const response = {
      success: true,
      message,
      ...(data !== null && { data }),
      ...meta,
      timestamp: new Date().toISOString(),
    };
    return res.status(statusCode).json(response);
  }

  /**
   * Send a created response (201)
   */
  static created(res, data = null, message = 'Created successfully') {
    return ApiResponse.success(res, data, message, 201);
  }

  /**
   * Send a paginated list response
   */
  static paginated(res, data, pagination, message = 'Success') {
    const { page, limit, total } = pagination;
    const pages = Math.ceil(total / limit);

    // Set pagination headers
    res.set('X-Total-Count', total);
    res.set('X-Page-Count', pages);
    res.set('X-Current-Page', page);

    return res.status(200).json({
      success: true,
      message,
      data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages,
        hasNext: page < pages,
        hasPrev: page > 1,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send an error response
   */
  static error(res, message = 'Something went wrong', statusCode = 500, errors = [], code = null) {
    return res.status(statusCode).json({
      success: false,
      message,
      ...(code && { code }),
      ...(errors.length > 0 && { errors }),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Send a no-content response (204)
   */
  static noContent(res) {
    return res.status(204).send();
  }
}

/**
 * Pagination query parser helper
 */
const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(
    parseInt(process.env.MAX_PAGE_SIZE) || 100,
    Math.max(1, parseInt(query.limit) || parseInt(process.env.DEFAULT_PAGE_SIZE) || 12)
  );
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

/**
 * Sort query parser helper
 * Converts "price:asc,name:desc" → { price: 'asc', name: 'desc' }
 */
const parseSort = (sortQuery, allowedFields = []) => {
  if (!sortQuery) return { createdAt: 'desc' };

  const sortObj = {};
  const parts = sortQuery.split(',');

  for (const part of parts) {
    const [field, order] = part.trim().split(':');
    if (allowedFields.includes(field) && ['asc', 'desc'].includes(order?.toLowerCase())) {
      sortObj[field] = order.toLowerCase();
    }
  }

  return Object.keys(sortObj).length > 0 ? sortObj : { createdAt: 'desc' };
};

module.exports = { ApiResponse, parsePagination, parseSort };
