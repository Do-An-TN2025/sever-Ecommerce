const mongoose = require("mongoose");
const { Schema } = mongoose;

const SimilarItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: "Product" },
  score: { type: Number, default: 0 },
});

const CFRecommendationSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: "Product", unique: true, index: true },
  recommendations: [SimilarItemSchema], 
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("CFRecommendation", CFRecommendationSchema);