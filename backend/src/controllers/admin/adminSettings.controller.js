/**
 * controllers/admin/adminSettings.controller.js
 */
'use strict';
const { prisma } = require('../../config/database');
const { cache } = require('../../config/redis');
const { ApiResponse } = require('../../utils/ApiResponse');

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
