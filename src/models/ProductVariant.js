const mongoose = require("mongoose");

const productVariantSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  color: { type: String },
  size: { type: String },
  sku: { type: String, required: true, unique: true },
  stock: { type: Number, default: 0 },
  price: { type: Number, required: true },
  discountPrice: { type: Number },
  onSale: { type: Boolean, default: false },
  saleNote: { type: String },
  images: [{ type: String }]
});

module.exports = mongoose.model("ProductVariant", productVariantSchema);
