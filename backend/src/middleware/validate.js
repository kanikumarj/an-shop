/**
 * middleware/validate.js
 * =======================
 * Request validation middleware using Zod schemas.
 */

'use strict';

const { z } = require('zod');
const AppError = require('../utils/AppError');

/**
 * Creates a validation middleware from a Zod schema.
 * Validates req.body by default, but can validate params/query too.
 *
 * @param {z.ZodSchema} schema - Zod schema to validate against
 * @param {string} source - 'body' | 'query' | 'params'
 */
const validate = (schema, source = 'body') => {
  return async (req, res, next) => {
    try {
      const data = await schema.parseAsync(req[source]);
      req[source] = data; // Replace with parsed/transformed data
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map((e) => ({
          field: e.path.join('.') || 'unknown',
          message: e.message,
          code: e.code,
        }));
        return next(AppError.unprocessable('Validation failed. Please check your input.', errors));
      }
      next(error);
    }
  };
};

/**
 * Validate multiple sources at once
 * @param {{ body?, query?, params? }} schemas
 */
const validateAll = (schemas) => {
  return async (req, res, next) => {
    const errors = [];

    for (const [source, schema] of Object.entries(schemas)) {
      try {
        const data = await schema.parseAsync(req[source] || {});
        req[source] = data;
      } catch (error) {
        if (error instanceof z.ZodError) {
          errors.push(
            ...error.errors.map((e) => ({
              field: `${source}.${e.path.join('.')}`,
              message: e.message,
              code: e.code,
            }))
          );
        }
      }
    }

    if (errors.length > 0) {
      return next(AppError.unprocessable('Validation failed. Please check your input.', errors));
    }

    next();
  };
};

module.exports = { validate, validateAll };
