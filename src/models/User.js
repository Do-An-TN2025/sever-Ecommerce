const mongoose = require("mongoose");

const AddressSchema = new mongoose.Schema({
  receiverName: String,
  phone: String,
  addressLine: String,
  city: String,
  district: String,
  ward: String,
  isDefault: { type: Boolean, default: false }
}, { _id: true });

const OrderHistorySchema = new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
  purchasedAt: Date
}, { _id: false });

const SocialLoginSchema = new mongoose.Schema({
  provider: { type: String, required: true }, 
  providerId: { type: String, required: true },
  linkedAt: { type: Date, default: Date.now }
}, { _id: false });


const UserSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: String,
  phone: String,
  gender: String,
  dateOfBirth: Date,
  avatar: String,
  addresses: [AddressSchema],
  role: { type: String, enum: ["customer", "staff", "admin"], default: "customer" },
  status: { type: String, default: "active" },
  orderHistory: [OrderHistorySchema],
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
  socialLogins: [SocialLoginSchema],
}, { timestamps: true });

module.exports = mongoose.model("User", UserSchema);
  