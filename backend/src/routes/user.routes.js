/**
 * routes/user.routes.js
 */
'use strict';
const express = require('express');
const router = express.Router();
const {
  getProfile, updateProfile, updateAvatar, deleteAccount,
  getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress,
} = require('../controllers/user.controller');
const { protect } = require('../middleware/auth');
const { uploadAvatar } = require('../config/cloudinary');
const { validate } = require('../middleware/validate');
const { updateProfileSchema, addressSchema } = require('../validations/user.validation');

router.use(protect);
router.get('/profile', getProfile);
router.patch('/profile', validate(updateProfileSchema), updateProfile);
router.patch('/avatar', uploadAvatar.single('avatar'), updateAvatar);
router.delete('/account', deleteAccount);
router.get('/addresses', getAddresses);
router.post('/addresses', validate(addressSchema), addAddress);
router.put('/addresses/:id', validate(addressSchema), updateAddress);
router.delete('/addresses/:id', deleteAddress);
router.patch('/addresses/:id/default', setDefaultAddress);

module.exports = router;
