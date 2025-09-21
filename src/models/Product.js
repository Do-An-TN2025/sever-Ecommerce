const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true }, 
  shortDescription: { type: String },
  categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
  brand: { type: String },
  tags: [{ type: String }],
  status: { type: String, enum: ["active", "inactive"], default: "active" },
  rating: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 }
  },
  variants: [{ type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant" }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Product", productSchema);
