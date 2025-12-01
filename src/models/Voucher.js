const mongoose = require('mongoose');

const VoucherSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  type: { type: String, enum: ['percent', 'fixed'], required: true },
  value: { type: Number, required: true },
  maxDiscount: { type: Number, default: null },
  startAt: { type: Date, default: Date.now },
  endAt: { type: Date, required: true },
  usageLimit: { type: Number, default: null }, 
  usedCount: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: 1 },
  usersUsed: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      count: { type: Number, default: 0 }
    }
  ],
  applicableProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  applicableCategories: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Category' }],
  minOrderValue: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  combinable: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Voucher', VoucherSchema);
// `code` has `unique: true` in the schema which creates an index,
// so the explicit schema index was removed to avoid duplicate-index warnings.
module.exports = mongoose.model('Voucher', VoucherSchema);