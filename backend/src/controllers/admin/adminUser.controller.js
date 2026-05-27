/**
 * controllers/admin/adminUser.controller.js
 */
'use strict';
const { prisma } = require('../../config/database');
const { ApiResponse, parsePagination } = require('../../utils/ApiResponse');
const AppError = require('../../utils/AppError');

exports.getAllUsers = async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const { search, role, isActive } = req.query;
  const where = {
    ...(role && { role }),
    ...(isActive !== undefined && { isActive: isActive === 'true' }),
    ...(search && { OR: [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ]}),
  };
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, select: {
      id: true, name: true, email: true, phone: true, role: true,
      isActive: true, isEmailVerified: true, lastLogin: true, createdAt: true,
      _count: { select: { orders: true } },
    }, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.user.count({ where }),
  ]);
  ApiResponse.paginated(res, users, { page, limit, total });
};

exports.getUserDetail = async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, name: true, email: true, phone: true, role: true,
      isActive: true, isEmailVerified: true, lastLogin: true, createdAt: true,
      addresses: true,
      orders: { orderBy: { createdAt: 'desc' }, take: 5, include: { items: { take: 2 } } },
      _count: { select: { orders: true, reviews: true, wishlist: true } },
    },
  });
  if (!user) throw AppError.notFound('User');
  ApiResponse.success(res, user);
};

exports.toggleUserStatus = async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) throw AppError.notFound('User');
  if (user.role === 'SUPERADMIN') throw AppError.forbidden('Cannot modify SuperAdmin status.');

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: !user.isActive },
    select: { id: true, name: true, isActive: true },
  });
  ApiResponse.success(res, updated, `User ${updated.isActive ? 'activated' : 'deactivated'}.`);
};

exports.changeUserRole = async (req, res) => {
  const { role } = req.body;
  if (role === 'SUPERADMIN') throw AppError.forbidden('Cannot assign SUPERADMIN role.');
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { role },
    select: { id: true, name: true, email: true, role: true },
  });
  ApiResponse.success(res, user, 'User role updated.');
};
