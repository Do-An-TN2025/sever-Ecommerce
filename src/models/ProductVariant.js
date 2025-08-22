const mongoose = require("mongoose");

const RatingSchema = new mongoose.Schema({
  average: { type: Number, default: 0 },
  count: { type: Number, default: 0 }
}, { _id: false });

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, unique: true },
  shortDescription: String,
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
  brand: String,
  tags: [String],
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  rating: RatingSchema
}, { timestamps: true });

module.exports = mongoose.model("Product", ProductSchema);
