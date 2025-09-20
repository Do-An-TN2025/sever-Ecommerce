const Category = require("../models/Category");

exports.createCategory = async (req, res) => {
  try {
    const { name, slug, path } = req.body;

    const category = new Category({ name, slug, path });
    await category.save();

    res.status(201).json(category);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ path: 1 });
    res.json(categories);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCategoryBySlug = async (req, res) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug });

    if (!category) return res.status(404).json({ message: "Category not found" });

    res.json(category);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.updateCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!category) return res.status(404).json({ message: "Category not found" });

    res.json(category);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};


exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);

    if (!category) return res.status(404).json({ message: "Category not found" });

    res.json({ message: "Category deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};