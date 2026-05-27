/**
 * controllers/coupon.controller.js
 */
'use strict';

const { prisma } = require('../config/database');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const { roundTo } = require('../utils/helpers');

exports.validateCoupon = async (req, res) => {
  const { code, cartTotal, productIds = [], categoryIds = [] } = req.body;

  const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });

  if (!coupon || !coupon.isActive) throw AppError.notFound('Coupon');
  if (coupon.validUntil && new Date() > coupon.validUntil) {
    throw AppError.badRequest('This coupon has expired.');
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw AppError.badRequest('This coupon has reached its usage limit.');
  }
  if (coupon.minOrderAmount && cartTotal < coupon.minOrderAmount) {
    throw AppError.badRequest(`Minimum order amount is ₹${coupon.minOrderAmount} for this coupon.`);
  }

  // Check applicability
  if (coupon.applicableProducts.length > 0) {
    const hasApplicable = productIds.some((id) => coupon.applicableProducts.includes(id));
    if (!hasApplicable) throw AppError.badRequest('This coupon is not applicable to items in your cart.');
  }

  // Calculate discount
  let discount = 0;
  if (coupon.type === 'PERCENT') {
    discount = roundTo(cartTotal * (coupon.value / 100));
    if (coupon.maxDiscount) discount = Math.min(discount, coupon.maxDiscount);
  } else {
    discount = Math.min(coupon.value, cartTotal);
  }

  ApiResponse.success(res, {
    couponId: coupon.id,
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    discount: roundTo(discount),
    finalTotal: roundTo(cartTotal - discount),
    description: coupon.description,
  }, `Coupon "${code}" applied! You save ₹${discount}.`);
};
