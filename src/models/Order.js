const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant" },
  name: String,
  sku: String,
  color: String,
  size: String,
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },       // snapshot giá tại thời điểm đặt
  image: String
}, { _id: false });

const ShippingAddressSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true },
  addressLine1: { type: String, required: true },
  addressLine2: String,
  ward: String,
  district: String,
  city: String,
  postalCode: String
}, { _id: false });

const GuestInfoSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: String,
  phone: { type: String, required: true }
}, { _id: false });

const PaymentMethodSchema = new mongoose.Schema({
  type: { type: String, enum: ["COD", "PayOS"], default: "COD" },
  status: { type: String, enum: ["pending", "paid", "failed", "cancelled"], default: "pending" },
  transactionId: String,
  invoiceUrl: String,
  note: String,
  expiresAt: Date
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  guestInfo: GuestInfoSchema,
  items: { type: [OrderItemSchema], validate: v => v.length > 0 },
  shippingAddress: ShippingAddressSchema,
  paymentMethod: PaymentMethodSchema,
  orderStatus: {
    type: String,
    enum: ["pending", "confirmed", "shipped", "delivered", "cancelled"],
    default: "pending"
  },
  subtotal: { type: Number, default: 0 },
  shippingFee: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  customerNote: String,
  metadata: mongoose.Schema.Types.Mixed
}, { timestamps: true });

OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ "paymentMethod.transactionId": 1 }, { sparse: true });

module.exports = mongoose.model("Order", OrderSchema);