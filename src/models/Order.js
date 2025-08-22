const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema({
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant" },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  name: String,
  color: String,
  size: String,
  quantity: Number,
  price: Number,
  image: String
}, { _id: false });

const ShippingAddressSchema = new mongoose.Schema({
  fullName: String,
  phone: String,
  addressLine1: String,
  addressLine2: String,
  city: String,
  district: String,
  ward: String,
  postalCode: String
}, { _id: false });

const PaymentMethodSchema = new mongoose.Schema({
  type: { type: String, enum: ["COD", "Momo", "VNPAY", "Paypal"], default: "COD" },
  status: { type: String, enum: ["pending", "paid", "failed"], default: "pending" }
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // cho phép null (guest checkout)
  items: [OrderItemSchema],
  shippingAddress: ShippingAddressSchema,
  paymentMethod: PaymentMethodSchema,
  orderStatus: { 
    type: String, 
    enum: ["pending", "confirmed", "shipped", "delivered", "cancelled"], 
    default: "pending" 
  },
  subtotal: Number,
  shippingFee: Number,
  discount: Number,
  totalAmount: Number
}, { timestamps: true });

module.exports = mongoose.model("Order", OrderSchema);
