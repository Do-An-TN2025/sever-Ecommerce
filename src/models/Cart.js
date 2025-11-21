const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
  // color and colorCode added so frontend selections are persisted
  color: { type: String },
  colorCode: { type: String },
  size: { type: String, required: true },
  quantity: { type: Number, default: 1 },
  price: Number,          // giá gốc
  discountPrice: Number,  // giá sau giảm (nếu có)
  finalPrice: Number      // finalPrice = discountPrice || price
  ,
  key: { type: String },
  image: { type: String }
}, { _id: true });

const cartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  guestId: { type: String, default: null },
  items: [cartItemSchema],
  currency: { type: String, default: 'VND' },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

cartSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } });
cartSchema.index({ guestId: 1 }, { unique: true, partialFilterExpression: { guestId: { $type: 'string' } } });

module.exports = mongoose.model('Cart', cartSchema);
