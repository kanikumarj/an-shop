/**
 * routes/review.routes.js
 */
'use strict';
const express = require('express');
const router = express.Router();
const {
  getProductReviews, createReview, updateReview, deleteReview, markHelpful,
} = require('../controllers/review.controller');
const { protect, optionalAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { reviewSchema } = require('../validations/review.validation');

router.get('/product/:productId', optionalAuth, getProductReviews);
router.use(protect);
router.post('/product/:productId', validate(reviewSchema), createReview);
router.put('/:id', validate(reviewSchema), updateReview);
router.delete('/:id', deleteReview);
router.post('/:id/helpful', markHelpful);

module.exports = router;
