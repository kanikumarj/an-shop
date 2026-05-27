/**
 * routes/wishlist.routes.js
 */
'use strict';
const express = require('express');
const router = express.Router();
const {
  getWishlist, addToWishlist, removeFromWishlist, clearWishlist, moveToCart,
} = require('../controllers/wishlist.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/', getWishlist);
router.post('/:productId', addToWishlist);
router.delete('/:productId', removeFromWishlist);
router.delete('/', clearWishlist);
router.post('/:productId/move-to-cart', moveToCart);

module.exports = router;
