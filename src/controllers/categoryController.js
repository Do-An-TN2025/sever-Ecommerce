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


const slugify = (str = "") =>
  str
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

exports.updateCategory = async (req, res) => {
  try {
    const currentSlug = req.params.slug;     
    const { name, path } = req.body;
    let newSlug = req.body.slug;
    if (typeof newSlug === "string") {
      newSlug = slugify(newSlug);
    }

    const category = await Category.findOne({ slug: currentSlug });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }
    if (newSlug && newSlug !== currentSlug) {
      const existed = await Category.findOne({ slug: newSlug });
      if (existed) {
        return res.status(400).json({ message: "Slug đã tồn tại" });
      }
      category.slug = newSlug;
    }

    if (typeof name === "string") category.name = name;
    if (typeof path === "string") category.path = path;

    await category.save();

    return res.json(category);
  } catch (err) {
    console.error("Update category error:", err);
    return res.status(400).json({ message: err.message || "Update failed" });
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