/**
 * routes/coupon.routes.js
 */
'use strict';
const express = require('express');
const router = express.Router();
const { validateCoupon } = require('../controllers/coupon.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.post('/validate', validateCoupon);

module.exports = router;
