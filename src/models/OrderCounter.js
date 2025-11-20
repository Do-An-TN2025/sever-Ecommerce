const mongoose = require('mongoose');

const OrderCounterSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.models.OrderCounter || mongoose.model('OrderCounter', OrderCounterSchema);
