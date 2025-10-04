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
      sizes,
      isDefault,
      status
    } = req.body;

    console.log('Raw sizes received:', sizes);
    console.log('Files received:', req.files);

    let sizesArray = [];
    if (sizes) {
      try {
        if (typeof sizes === 'string') {
          sizesArray = JSON.parse(sizes);
        } else if (Array.isArray(sizes)) {
          sizesArray = sizes;
        }
      } catch (parseError) {
        console.error('Error parsing sizes:', parseError);
        return res.status(400).json({ 
          message: "Invalid sizes format", 
          error: parseError.message 
        });
      }
    }

    const imageUrls = [];

    if (req.files && req.files.length > 0) {
      console.log(`Processing ${req.files.length} image files`);
      
      for (const file of req.files) {
        try {
          console.log('Uploading file:', file.originalname, file.path);

          if (!file.path) {
            console.error('File path is undefined:', file);
            continue;
          }
          
          const imageUrl = await uploadImage(file.path, "variants");
          if (imageUrl) {
            imageUrls.push(imageUrl);
            console.log('Successfully uploaded:', imageUrl);
          } else {
            console.error('Upload returned undefined for file:', file.originalname);
          }
        } catch (uploadError) {
          console.error('Error uploading image:', uploadError);
        }
      }
    }

    let imageUrlsFromBody = [];
    if (req.body.images) {
      try {
        imageUrlsFromBody = typeof req.body.images === 'string' 
          ? JSON.parse(req.body.images) 
          : req.body.images;
        
        if (!Array.isArray(imageUrlsFromBody)) {
          imageUrlsFromBody = [imageUrlsFromBody];
        }
        console.log('Images from body:', imageUrlsFromBody);
      } catch (parseError) {
        console.error('Error parsing images from body:', parseError);
      }
    }

    const newVariant = new ProductVariant({
      productId,
      color,
      colorCode,
      sizes: sizesArray,
      images: [...imageUrls, ...imageUrlsFromBody],
      isDefault: isDefault || false,
      status: status || 'in_stock'
    });

    console.log('Creating variant with:', {
      productId,
      color,
      colorCode,
      sizesCount: sizesArray.length,
      imagesCount: newVariant.images.length
    });

    await newVariant.save();
  
    await Product.findByIdAndUpdate(productId, { 
      $push: { variants: newVariant._id } 
    });

    await recalcVariantStatus(newVariant._id);

    res.status(201).json({ 
      message: "Variant created successfully", 
      variant: newVariant 
    });

  } catch (error) {
    console.error('Error creating variant:', error);
    res.status(500).json({ 
      message: "Failed to create variant", 
      error: error.message 
    });
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


exports.updateVariant = async (req, res) => {
  try {
    const { variantId } = req.params;
    
    // Parse data từ FormData
    let {
      color,
      colorCode,
      status,
      sizes,
      images,
      action = 'merge'
    } = req.body;

    console.log('Update variant request:', { 
      variantId, 
      color, 
      colorCode, 
      status, 
      action,
      sizes: typeof sizes === 'string' ? 'string (need parse)' : sizes 
    });

    // Tìm variant
    const variant = await ProductVariant.findById(variantId);
    if (!variant) {
      return res.status(404).json({ message: "Variant not found" });
    }

    // Xử lý upload ảnh từ file
    const newImageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        try {
          const imageUrl = await uploadImage(file.path, "variants");
          newImageUrls.push(imageUrl);
          console.log('Uploaded new image:', imageUrl);
        } catch (uploadError) {
          console.error('Error uploading image:', uploadError);
        }
      }
    }

    // Xử lý ảnh từ URLs
    let imageUrlsFromBody = [];
    if (images) {
      try {
        imageUrlsFromBody = typeof images === 'string' ? JSON.parse(images) : images;
        if (!Array.isArray(imageUrlsFromBody)) {
          imageUrlsFromBody = [imageUrlsFromBody];
        }
        console.log('Images from body:', imageUrlsFromBody);
      } catch (parseError) {
        console.error('Error parsing images:', parseError);
        return res.status(400).json({ 
          message: "Invalid images format", 
          error: parseError.message 
        });
      }
    }

    // Cập nhật thông tin cơ bản
    if (color !== undefined) variant.color = color;
    if (colorCode !== undefined) variant.colorCode = colorCode;
    if (status !== undefined) variant.status = status;

    // Cập nhật ảnh
    if (action === 'replace') {
      // Thay thế toàn bộ ảnh
      variant.images = [...imageUrlsFromBody, ...newImageUrls];
    } else {
      // Merge ảnh mới vào ảnh hiện có (mặc định)
      const allNewImages = [...imageUrlsFromBody, ...newImageUrls];
      variant.images = [...variant.images, ...allNewImages];
    }

    // Loại bỏ ảnh trùng lặp
    variant.images = [...new Set(variant.images)];

    // Xử lý sizes - QUAN TRỌNG: Sửa phần này
    if (sizes !== undefined) {
      let sizesArray = sizes;
      
      // Parse sizes nếu là string (trường hợp gửi từ FormData)
      if (typeof sizes === 'string') {
        try {
          sizesArray = JSON.parse(sizes);
          console.log('Parsed sizes array:', sizesArray);
        } catch (parseError) {
          console.error('Error parsing sizes:', parseError);
          return res.status(400).json({ 
            message: "Invalid sizes format", 
            error: parseError.message 
          });
        }
      }

      if (!Array.isArray(sizesArray)) {
        console.error('Sizes is not array:', sizesArray);
        return res.status(400).json({ message: "Sizes must be an array" });
      }

      // Validate sizes data
      for (const size of sizesArray) {
        if (!size.size || typeof size.size !== 'string') {
          return res.status(400).json({ 
            message: "Each size must have a 'size' field of type string" 
          });
        }
      }

      console.log('Before update - variant sizes:', variant.sizes);
      console.log('New sizes to set:', sizesArray);

      // QUAN TRỌNG: Thay thế toàn bộ sizes array
      variant.sizes = sizesArray.map(size => ({
        size: size.size,
        sku: size.sku || '',
        stock: size.stock || 0,
        price: size.price || 0,
        originalPrice: size.originalPrice || 0,
        discountPrice: size.discountPrice || 0,
        discountPercent: size.discountPercent || 0,
        onSale: size.onSale || false,
        saleNote: size.saleNote || '',
        isDefault: size.isDefault || false,
        // Giữ lại _id nếu có (cho các size đã tồn tại)
        _id: size._id || new mongoose.Types.ObjectId()
      }));

      console.log('After update - variant sizes:', variant.sizes);
    }

    // Validate trước khi save
    try {
      await variant.validate();
    } catch (validationError) {
      console.error('Validation error:', validationError);
      return res.status(400).json({ 
        message: "Validation failed", 
        error: validationError.message 
      });
    }

    // Lưu variant
    const savedVariant = await variant.save();
    console.log('Variant saved successfully:', savedVariant._id);
    
    // Recalculate status
    await recalcVariantStatus(variantId);

    // Populate thông tin mới nhất
    const updatedVariant = await ProductVariant.findById(variantId);

    res.status(200).json({ 
      message: "Variant updated successfully", 
      variant: updatedVariant 
    });

  } catch (error) {
    console.error('Error updating variant:', error);
    
    if (error.name === 'ValidationError') {
      return res.status(400).json({ 
        message: "Validation failed", 
        error: error.message 
      });
    }
    
    if (error.name === 'CastError') {
      return res.status(400).json({ 
        message: "Invalid variant ID", 
        error: error.message 
      });
    }

    res.status(500).json({ 
      message: "Failed to update variant", 
      error: error.message 
    });
  }
};
