const mongoose = require("mongoose");
const ProductVariant = require("../models/ProductVariant");
const Product = require("../models/Product");
const { uploadImage } = require("../utils/cloudinary");

async function recalcVariantStatus(variantId) {
  const variant = await ProductVariant.findById(variantId).lean();
  if (!variant) return null;
  const totalStock = (variant.sizes || []).reduce((s, it) => s + (Number(it.stock) || 0), 0);
  const status = totalStock > 0 ? "in_stock" : "out_of_stock";
  return ProductVariant.findByIdAndUpdate(variantId, { status }, { new: true });
}


exports.createVariant = async (req, res) => {
  try {
    const {
      productId,
      color,
      colorCode,
      // nếu bạn cho phép gửi sizes là 1 mảng trong body
      sizes = [], 
      isDefault,
      status
    } = req.body;

    const imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const imageUrl = await uploadImage(file.path, "variants");
        imageUrls.push(imageUrl);
      }
    }

    const newVariant = new ProductVariant({
      productId,
      color,
      colorCode,
      sizes,     
      images: imageUrls,
      isDefault,
      status
    });

    await newVariant.save();
    await Product.findByIdAndUpdate(productId, { $push: { variants: newVariant._id } });

    await recalcVariantStatus(newVariant._id);

    res.status(201).json({ message: "Variant created", variant: newVariant });
  } catch (error) {
    res.status(500).json({ message: "Failed to create variant", error: error.message });
  }
};

exports.addSizeToVariant = async (req, res) => {
  try {
    const { variantId } = req.params;
    const sizeData = { ...req.body }; // size, sku, stock, price, ..

    // (tùy chọn) kiểm tra trùng size + sku trong cùng variant
    const variant = await ProductVariant.findById(variantId);
    if (!variant) return res.status(404).json({ message: "Variant not found" });

    // ví dụ tránh trùng same size (optional)
    if (variant.sizes.some(s => s.size === sizeData.size && s.sku === sizeData.sku)) {
      return res.status(400).json({ message: "This size+sku already exists for this variant" });
    }

    variant.sizes.push(sizeData);
    await variant.save();

    await recalcVariantStatus(variantId);

    res.status(200).json({ message: "Size added", variant });
  } catch (error) {
    res.status(500).json({ message: "Failed to add size", error: error.message });
  }
};

exports.updateSizeInVariant = async (req, res) => {
  try {
    const { variantId, sizeId } = req.params;
    const allowed = ["size","sku","stock","price","originalPrice","discountPrice","discountPercent","onSale","saleNote","isDefault"];
    const updateFields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updateFields[`sizes.$[elem].${key}`] = req.body[key];
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const updated = await ProductVariant.findOneAndUpdate(
      { _id: variantId },
      { $set: updateFields },
      {
        new: true,
        runValidators: true,
        arrayFilters: [{ "elem._id": mongoose.Types.ObjectId(sizeId) }]
      }
    );

    if (!updated) return res.status(404).json({ message: "Variant or size not found" });

    await recalcVariantStatus(variantId);

    res.status(200).json({ message: "Size updated", variant: updated });
  } catch (error) {
    res.status(500).json({ message: "Failed to update size", error: error.message });
  }
};


exports.removeSizeFromVariant = async (req, res) => {
  try {
    const { variantId, sizeId } = req.params;
    const updated = await ProductVariant.findByIdAndUpdate(
      variantId,
      { $pull: { sizes: { _id: mongoose.Types.ObjectId(sizeId) } } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: "Variant not found" });

    if (!updated.sizes || updated.sizes.length === 0) {
      updated.status = "out_of_stock";
      await updated.save();
    } else {
      await recalcVariantStatus(variantId);
    }

    res.status(200).json({ message: "Size removed", variant: updated });
  } catch (error) {
    res.status(500).json({ message: "Failed to remove size", error: error.message });
  }
};

exports.updateVariantImages = async (req, res) => {
  try {
    const { variantId } = req.params;
    const action = req.query.action || "append";
    const imageUrls = [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const url = await uploadImage(file.path, "variants");
        imageUrls.push(url);
      }
    }

    if (imageUrls.length === 0) {
      return res.status(400).json({ message: "No images uploaded" });
    }

    let updated;
    if (action === "replace") {
      updated = await ProductVariant.findByIdAndUpdate(
        variantId,
        { images: imageUrls },
        { new: true }
      );
    } else {
      updated = await ProductVariant.findByIdAndUpdate(
        variantId,
        { $push: { images: { $each: imageUrls } } },
        { new: true }
      );
    }

    if (!updated) return res.status(404).json({ message: "Variant not found" });

    res.status(200).json({ message: "Images updated", variant: updated });
  } catch (error) {
    res.status(500).json({ message: "Failed to update images", error: error.message });
  }
};
