const mongoose = require('mongoose');

const productVariantSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  color: {
    type: String,
    required: true
  },
  colorCode: {
    type: String,
    required: true
  },
sizes: [
  {
    size: String,
    sku: String,
    stock: { type: Number, default: 0 },
    price: Number,
    originalPrice: Number,
    discountPrice: Number,
    discountPercent: Number,
    onSale: Boolean,
    saleNote: String,
    isDefault: Boolean
  }
],
  status: {
    type: String,
    enum: ['in_stock', 'out_of_stock', 'coming_soon'],
    default: 'in_stock'
  },
  images: [String]
}, {
  timestamps: true
});

module.exports = mongoose.model('ProductVariant', productVariantSchema);

productVariantSchema.pre('save', function(next) {
  if (this.isModified('stock')) {
    if (this.stock > 0 && this.status !== 'coming_soon') {
      this.status = 'in_stock';
    } else if (this.stock <= 0) {
      this.status = 'out_of_stock';
    }
  }
  next();
});