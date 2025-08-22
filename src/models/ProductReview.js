const mongoose = require("mongoose");

const ProductReviewSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  comment: String
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model("ProductReview", ProductReviewSchema);
