/**
 * routes/admin/adminCategory.routes.js
 * =======================================
 * Admin category management routes.
 */

'use strict';

const { Router } = require('express');
const adminProductController = require('../../controllers/admin/adminProduct.controller');
const { protect, adminOnly } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { uploadCategoryImage } = require('../../config/cloudinary');
const { createCategorySchema, updateCategorySchema } = require('../../validations/product.validation');

const router = Router();

router.use(protect, adminOnly);

// GET  /admin/categories
router.get('/', adminProductController.listCategories);

// POST /admin/categories  (optional image upload)
router.post('/',
  uploadCategoryImage,
  validate(createCategorySchema),
  adminProductController.createCategory
);

// PUT /admin/categories/:id
router.put('/:id',
  uploadCategoryImage,
  validate(updateCategorySchema),
  adminProductController.updateCategory
);

// DELETE /admin/categories/:id
router.delete('/:id', adminProductController.deleteCategory);

module.exports = router;
