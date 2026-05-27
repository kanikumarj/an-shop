/**
 * middleware/notFoundHandler.js
 * ==============================
 * 404 handler for unmatched routes.
 */

'use strict';

const AppError = require('../utils/AppError');

const notFoundHandler = (req, res, next) => {
  next(
    AppError.notFound(
      `Cannot ${req.method} ${req.originalUrl} — route`
    )
  );
};

module.exports = { notFoundHandler };
