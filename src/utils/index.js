const jwt = require('jsonwebtoken');
const { ENV } = require('../config');
const path = require('path');

// ========== JWT ==========
function signToken(payload, expires = '7d') {
  return jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: expires });
}
function verifyToken(token) {
  return jwt.verify(token, ENV.JWT_SECRET);
}

// ========== Cloudinary (lazy init) ==========
let _cloudinary = null;
function cloudinary() {
  if (_cloudinary) return _cloudinary;
  const c = ENV.CLOUDINARY;
  if (!c.CLOUD_NAME) throw new Error('Cloudinary config missing');
  _cloudinary = require('cloudinary').v2;
  _cloudinary.config({
    cloud_name: c.CLOUD_NAME,
    api_key: c.API_KEY,
    api_secret: c.API_SECRET
  });
  return _cloudinary;
}
async function uploadImage(filePath, folder = 'uploads') {
  const cd = cloudinary();
  const res = await cd.uploader.upload(filePath, {
    folder,
    resource_type: 'image'
  });
  return { url: res.secure_url, publicId: res.public_id };
}

// ========== Price helpers ==========
function calcFinalPrice(price, discountPrice) {
  if (discountPrice != null && discountPrice > 0 && discountPrice < price) return discountPrice;
  return price;
}
function percentDiscount(price, discountPrice) {
  if (discountPrice && discountPrice < price) {
    return Math.round((1 - discountPrice / price) * 100);
  }
  return 0;
}

// ========== Standard API response ==========
function ok(res, data = {}, status = 200) {
  return res.status(status).json(data);
}
function fail(res, error) {
  const status = error.status || 500;
  return res.status(status).json({ message: error.message || 'Server error', code: error.code });
}

// ========== Simple async wrapper ==========
const asyncWrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ========== Export ==========
module.exports = {
  signToken,
  verifyToken,
  uploadImage,
  calcFinalPrice,
  percentDiscount,
  ok,
  fail,
  asyncWrap
};
