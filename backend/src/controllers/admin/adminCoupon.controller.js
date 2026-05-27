/**
 * controllers/admin/adminCoupon.controller.js
 */
'use strict';
const { prisma } = require('../../config/database');
const { ApiResponse, parsePagination } = require('../../utils/ApiResponse');
const AppError = require('../../utils/AppError');

exports.getAllCoupons = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const [coupons, total] = await Promise.all([
    prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.coupon.count(),
  ]);
  ApiResponse.paginated(res, coupons, { page, limit, total });
};

exports.createCoupon = async (req, res) => {
  const { code } = req.body;
  const existing = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
  if (existing) throw AppError.conflict('Coupon code already exists.');

  const coupon = await prisma.coupon.create({
    data: { ...req.body, code: code.toUpperCase() },
  });
  ApiResponse.created(res, coupon, 'Coupon created.');
};

exports.updateCoupon = async (req, res) => {
  const coupon = await prisma.coupon.update({
    where: { id: req.params.id },
    data: req.body,
  });
  ApiResponse.success(res, coupon, 'Coupon updated.');
};

exports.deleteCoupon = async (req, res) => {
  await prisma.coupon.delete({ where: { id: req.params.id } });
  ApiResponse.success(res, null, 'Coupon deleted.');
};
