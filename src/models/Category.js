const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, trim: true },
  path: { type: String, required: true, index: true }
});

module.exports = mongoose.model("Category", categorySchema);
