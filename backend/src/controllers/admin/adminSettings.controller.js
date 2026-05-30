/**
 * controllers/admin/adminSettings.controller.js
 */
'use strict';
const { prisma } = require('../../config/database');
const { cache } = require('../../config/redis');
const { ApiResponse } = require('../../utils/ApiResponse');
const AppError = require('../../utils/AppError');

exports.getSettings = async (req, res) => {
  const settings = await prisma.setting.findMany({ orderBy: { group: 'asc' } });
  const grouped = settings.reduce((acc, s) => {
    if (!acc[s.group]) acc[s.group] = {};
    acc[s.group][s.key] = s.value;
    return acc;
  }, {});
  ApiResponse.success(res, grouped);
};

exports.updateSettings = async (req, res) => {
  const { settings } = req.body;
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value, group: req.body.group || 'general' },
    });
  }
  await cache.del('settings:global');
  ApiResponse.success(res, null, 'Settings updated.');
};

exports.uploadQrCode = async (req, res) => {
  if (!req.file) throw AppError.badRequest('No QR code image uploaded.');
  ApiResponse.success(res, {
    url: req.file.path.startsWith('http') ? req.file.path : `/uploads/${req.file.filename}`,
    publicId: req.file.filename,
  }, 'QR code uploaded successfully.');
};
