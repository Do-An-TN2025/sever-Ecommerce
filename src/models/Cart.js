const mongoose = require("mongoose");

const CartItemSchema = new mongoose.Schema({
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant" },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  name: String,
  color: String,
  size: String,
  quantity: { type: Number, default: 1 },
  price: Number,
  image: String
}, { _id: false });

const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  items: [CartItemSchema],
  totalPrice: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model("Cart", CartSchema);
    