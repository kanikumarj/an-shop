/**
 * routes/category.routes.js
 */
'use strict';
const express = require('express');
const router = express.Router();
const {
  getAllCategories, getCategoryBySlug, getCategoryProducts,
  createCategory, updateCategory, deleteCategory,
} = require('../controllers/category.controller');
const { protect, restrictTo } = require('../middleware/auth');
const { uploadCategoryImage } = require('../config/cloudinary');
const { validate } = require('../middleware/validate');
const { categorySchema } = require('../validations/category.validation');

// Public
router.get('/', getAllCategories);
router.get('/:slug', getCategoryBySlug);
router.get('/:slug/products', getCategoryProducts);

// Admin
router.use(protect, restrictTo('ADMIN', 'SUPERADMIN'));
router.post('/', uploadCategoryImage, validate(categorySchema), createCategory);
router.put('/:id', uploadCategoryImage, validate(categorySchema), updateCategory);
router.delete('/:id', deleteCategory);

module.exports = router;
