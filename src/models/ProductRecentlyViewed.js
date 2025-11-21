const mongoose = require('mongoose');
const { Schema } = mongoose;

const ViewedItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', index: true },
  slug: { type: String },
  viewedAt: { type: Date, default: Date.now }
}, { _id: false });

const ProductRecentlyViewedSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, sparse: true },
  sessionId: { type: String, index: true, sparse: true },
  products: { type: [ViewedItemSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
});

// Optional: expire anonymous/session docs after 30 days
// ProductRecentlyViewedSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, partialFilterExpression: { sessionId: { $exists: true } } });

module.exports = mongoose.model('ProductRecentlyViewed', ProductRecentlyViewedSchema);
