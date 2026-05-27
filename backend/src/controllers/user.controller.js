/**
 * controllers/user.controller.js
 */
'use strict';

const { prisma } = require('../config/database');
const { ApiResponse } = require('../utils/ApiResponse');
const AppError = require('../utils/AppError');
const { deleteFromCloudinary } = require('../config/cloudinary');
const { omit } = require('../utils/helpers');

exports.getProfile = async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, email: true, phone: true, role: true,
      avatar: true, isEmailVerified: true, isPhoneVerified: true,
      lastLogin: true, createdAt: true,
      _count: { select: { orders: true, reviews: true, wishlist: true } },
    },
  });
  ApiResponse.success(res, user, 'Profile fetched.');
};

exports.updateProfile = async (req, res) => {
  const { name, phone } = req.body;

  if (phone) {
    const phoneExists = await prisma.user.findFirst({
      where: { phone, id: { not: req.user.id } },
    });
    if (phoneExists) throw AppError.conflict('Phone number already in use.');
  }

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { name, phone },
    select: {
      id: true, name: true, email: true, phone: true, avatar: true,
      isEmailVerified: true, isPhoneVerified: true,
    },
  });

  ApiResponse.success(res, updated, 'Profile updated.');
};

exports.updateAvatar = async (req, res) => {
  if (!req.file) throw AppError.badRequest('Please upload an image file.');

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { avatarPublicId: true },
  });

  // Delete old avatar
  if (user.avatarPublicId) {
    await deleteFromCloudinary(user.avatarPublicId);
  }

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { avatar: req.file.path, avatarPublicId: req.file.filename },
    select: { id: true, avatar: true },
  });

  ApiResponse.success(res, updated, 'Avatar updated.');
};

exports.deleteAccount = async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { isActive: false },
  });
  ApiResponse.success(res, null, 'Account deactivated. Contact support to reactivate.');
};

// ─── Addresses ─────────────────────────────────────────────────────────────────
exports.getAddresses = async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user.id },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  ApiResponse.success(res, addresses);
};

exports.addAddress = async (req, res) => {
  const { isDefault } = req.body;

  if (isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const count = await prisma.address.count({ where: { userId: req.user.id } });
  if (count >= 5) throw AppError.badRequest('Maximum 5 addresses allowed.');

  const address = await prisma.address.create({
    data: { ...req.body, userId: req.user.id, isDefault: isDefault || count === 0 },
  });

  ApiResponse.created(res, address, 'Address added.');
};

exports.updateAddress = async (req, res) => {
  const existing = await prisma.address.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!existing) throw AppError.notFound('Address');

  if (req.body.isDefault) {
    await prisma.address.updateMany({
      where: { userId: req.user.id },
      data: { isDefault: false },
    });
  }

  const updated = await prisma.address.update({
    where: { id: req.params.id },
    data: req.body,
  });

  ApiResponse.success(res, updated, 'Address updated.');
};

exports.deleteAddress = async (req, res) => {
  const existing = await prisma.address.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!existing) throw AppError.notFound('Address');

  await prisma.address.delete({ where: { id: req.params.id } });
  ApiResponse.success(res, null, 'Address deleted.');
};

exports.setDefaultAddress = async (req, res) => {
  const existing = await prisma.address.findFirst({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!existing) throw AppError.notFound('Address');

  await prisma.address.updateMany({
    where: { userId: req.user.id },
    data: { isDefault: false },
  });

  await prisma.address.update({
    where: { id: req.params.id },
    data: { isDefault: true },
  });

  ApiResponse.success(res, null, 'Default address updated.');
};
