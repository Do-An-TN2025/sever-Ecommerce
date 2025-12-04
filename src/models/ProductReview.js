const mongoose = require("mongoose");

const productReviewSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    rating: { type: Number, min: 1, max: 5, required: true },
      comment: { type: String, trim: true },
      // Admin reply subdocument: stored when an admin responds to a customer's review
      adminReply: {
        adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        message: { type: String, trim: true },
        repliedAt: { type: Date }
      }
  },
  { timestamps: true }
);

productReviewSchema.post("save", async function () {
  const Product = require("./Product");
  const reviews = await this.constructor.find({ productId: this.productId });

  const avg = reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;

  await Product.findByIdAndUpdate(this.productId, {
    $set: {
      "rating.average": avg,
      "rating.count": reviews.length
    }
  });
});

const ProductReview = mongoose.model("ProductReview", productReviewSchema);

module.exports = ProductReview;