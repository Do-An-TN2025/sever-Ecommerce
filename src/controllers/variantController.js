const ProductVariant = require("../models/ProductVariant");
const { uploadImage } = require("../utils/cloudinary");

exports.createVariant = async (req, res) => {
  try {
    const { productId, color, size, sku, stock, price, discountPrice, onSale, saleNote } = req.body;

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
      size,
      sku,
      stock,
      price,
      discountPrice,
      onSale,
      saleNote,
      images: imageUrls
    });

    await newVariant.save();

    res.status(201).json({
      message: "Variant created successfully",
      variant: newVariant
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create variant", error: error.message });
  }
};