/**
 * validations/review.validation.js
 */
'use strict';
const { z } = require('zod');

exports.reviewSchema = z.object({
  rating: z.number().int().min(1, 'Rating must be 1-5').max(5),
  title: z.string().max(100).optional(),
  comment: z.string().min(10, 'Review must be at least 10 characters').max(2000).optional(),
  images: z.array(z.string().url()).max(5).optional(),
});
