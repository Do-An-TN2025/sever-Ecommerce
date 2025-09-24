const Product = require("../models/Product");
const Category = require("../models/Category");
const ProductVariant = require("../models/ProductVariant");

exports.createProduct = async (req, res) => {
  try {
    const { name, slug, shortDescription, brand, tags, categoryId } = req.body;
    const category = await Category.findById(categoryId);
    if (!category) {
      return res.status(400).json({ message: "Danh mục không tồn tại" });
    }
    const product = new Product({
      name,
      slug,
      shortDescription,
      brand,
      tags,
      categoryId
    });
    await product.save();
    res.status(201).json(product);
  } catch (err) {
    res.status(400).json({ message: "Không thể tạo sản phẩm", error: err.message });
  }
};


exports.updateProduct = async (req, res) => {
  try {
    const { categoryId } = req.body;
    if (categoryId) {
      const category = await Category.findById(categoryId);
      if (!category) {
        return res.status(400).json({ message: "Danh mục không tồn tại" });
      }
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );

    if (!product) return res.status(404).json({ message: "Không tìm thấy sản phẩm" });

    res.json(product);
  } catch (err) {
    res.status(400).json({ message: "Không thể cập nhật sản phẩm", error: err.message });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) return res.status(404).json({ message: "Không tìm thấy sản phẩm" });

    res.json({ message: "Xóa sản phẩm thành công" });
  } catch (err) {
    res.status(500).json({ message: "Lỗi server", error: err.message });
  }
};


exports.getProductBySlugCategory = async (req, res) => {
  try {
    const { slug } = req.params;
    const { 
      page = 1, 
      limit = 8, 
      sortBy = 'createdAt',
      sortOrder = 'desc',
      minPrice,
      maxPrice,
      color,
      size 
    } = req.query;

    // 1. Tìm category
    const category = await Category.findOne({ slug });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    // 2. Filter cho product
    const productFilter = { 
      categoryId: category._id,
      status: 'active'
    };

    // 3. Lấy products (chỉ sort theo các field cơ bản, không sort theo price ở đây)
    const products = await Product.find(productFilter)
      .populate('categoryId', 'name slug')
      .sort(sortBy !== 'price' ? { [sortBy]: sortOrder === 'desc' ? -1 : 1 } : {})
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    // 4. Ghép variants
    const productsWithVariants = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id });

        // chỉ lấy variant nào còn ít nhất 1 size có stock > 0
        const validVariants = variants.filter(v => 
          v.sizes.some(s => s.stock > 0)
        );

        // lấy 5 màu khác nhau
        const uniqueColorVariants = [];
        const seenColors = new Set();
        for (const variant of validVariants) {
          if (!seenColors.has(variant.color) && uniqueColorVariants.length < 5) {
            uniqueColorVariants.push(variant);
            seenColors.add(variant.color);
          }
        }

        // tìm size có giá thấp nhất
        let minPriceVariant = null;
        validVariants.forEach(variant => {
          variant.sizes.forEach(s => {
            const finalPrice = s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price;
            if (!minPriceVariant || finalPrice < minPriceVariant.finalPrice) {
              minPriceVariant = {
                ...s.toObject(),
                variantId: variant._id,
                finalPrice
              };
            }
          });
        });

        // tất cả màu
        const availableColors = [...new Set(validVariants.map(v => v.color).filter(Boolean))];
        // tất cả size
        const availableSizes = [...new Set(validVariants.flatMap(v => v.sizes.map(s => s.size)).filter(Boolean))];

        return {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          shortDescription: product.shortDescription,
          category: product.categoryId,
          rating: product.rating,
          price: minPriceVariant?.price || 0,
          discountPrice: minPriceVariant?.discountPrice,
          onSale: minPriceVariant?.onSale || false,
          finalPrice: minPriceVariant?.finalPrice || 0,   //  thêm finalPrice để sort
          colorVariants: uniqueColorVariants.map(v => ({
            color: v.color,
            colorCode: v.colorCode,
            images: v.images,
            sizes: v.sizes.map(s => ({
              size: s.size,
              price: s.price,
              discountPrice: s.discountPrice,
              stock: s.stock
            }))
          })),
          availableColors,
          availableSizes,
          totalStock: validVariants.reduce((sum, v) => 
            sum + v.sizes.reduce((sSum, s) => sSum + s.stock, 0), 0)
        };
      })
    );

    // 5. Apply filter (minPrice, maxPrice, color, size)
    let filteredProducts = productsWithVariants;

    if (minPrice || maxPrice) {
      filteredProducts = filteredProducts.filter(product => {
        const productPrice = product.finalPrice;
        if (minPrice && productPrice < parseInt(minPrice)) return false;
        if (maxPrice && productPrice > parseInt(maxPrice)) return false;
        return true;
      });
    }

    if (color) {
      filteredProducts = filteredProducts.filter(product => 
        product.availableColors.includes(color)
      );
    }

    if (size) {
      filteredProducts = filteredProducts.filter(product => 
        product.availableSizes.includes(size)
      );
    }

    //  6. Sort lại theo price nếu cần
    if (sortBy === 'price') {
      filteredProducts = [...filteredProducts].sort((a, b) => {
        return sortOrder === 'desc' 
          ? b.finalPrice - a.finalPrice 
          : a.finalPrice - b.finalPrice;
      });
    }

    // 7. Pagination thủ công (sau khi sort và filter)
    const total = await Product.countDocuments(productFilter);
    const paginatedProducts = filteredProducts.slice(
      (page - 1) * limit,
      page * limit
    );

    res.json({
      products: paginatedProducts,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        total,
        limit: parseInt(limit)
      },
      category: {
        _id: category._id,
        name: category.name,
        slug: category.slug
      }
    });

  } catch (error) {
    console.error('Error fetching category products:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getProductDetailsBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    // 1. Tìm product theo slug
    const product = await Product.findOne({ slug })
      .populate("categoryId", "name slug");
    if (!product) {
      return res.status(404).json({ message: "Không tìm thấy sản phẩm" });
    }

    // 2. Lấy tất cả variants của product
    const variants = await ProductVariant.find({ productId: product._id });

    if (!variants || variants.length === 0) {
      return res.json({
        ...product.toObject(),
        variants: [],
        availableColors: [],
        availableSizes: [],
        colorSizeMap: {},  
        minPrice: 0,
        maxPrice: 0,
        totalStock: 0
      });
    }

    // 3. Tính toán thông tin tổng hợp
    const availableColors = [...new Set(variants.map(v => v.color).filter(Boolean))];
    const availableSizes = [...new Set(
      variants.flatMap(v => v.sizes.map(s => s.size)).filter(Boolean)
    )];

    let minPrice = Infinity;
    let maxPrice = 0;
    let totalStock = 0;

    // 👇 tạo mapping color -> sizes khả dụng
    const colorSizeMap = {};

    variants.forEach(variant => {
      // lấy tất cả size khả dụng của màu này
      const sizesForColor = variant.sizes
        .filter(s => s.stock > 0) // chỉ lấy size còn hàng
        .map(s => s.size);

      colorSizeMap[variant.color] = [
        ...(colorSizeMap[variant.color] || []),
        ...sizesForColor
      ];

      // tính toán giá & stock
      variant.sizes.forEach(s => {
        const finalPrice = s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price;
        if (finalPrice < minPrice) minPrice = finalPrice;
        if (finalPrice > maxPrice) maxPrice = finalPrice;
        totalStock += s.stock;
      });
    });

    // loại bỏ size trùng trong map
    Object.keys(colorSizeMap).forEach(color => {
      colorSizeMap[color] = [...new Set(colorSizeMap[color])];
    });

    const productData = {
      ...product.toObject(),
      variants: variants.map(v => ({
        _id: v._id,
        color: v.color,
        colorCode: v.colorCode,
        images: v.images,
        sizes: v.sizes.map(s => ({
          size: s.size,
          price: s.price,
          discountPrice: s.discountPrice,
          stock: s.stock,
          finalPrice: s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price
        }))
      })),
      availableColors,
      availableSizes,
      colorSizeMap,   
      minPrice: minPrice === Infinity ? 0 : minPrice,
      maxPrice,
      totalStock
    };

    res.json(productData);

  } catch (err) {
    console.error("Error fetching product:", err);
    res.status(500).json({ message: "Lỗi server", error: err.message });
  }
};


exports.searchProducts = async (req, res) => {
  try {
    const { 
      q,
      page = 1, 
      limit = 20,
      sortBy = 'relevance', // relevance, price, newest, oldest
      sortOrder = 'desc',
      minPrice,
      maxPrice,
      color,
      size,
      category
    } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({ 
        message: 'Search query is required',
        products: [],
        pagination: {
          currentPage: 1,
          totalPages: 0,
          total: 0,
          limit: parseInt(limit)
        }
      });
    }

    const searchTerm = q.trim();
    
    // 1. Tìm kiếm products theo name, shortDescription, tags, brand
    const searchFilter = {
      status: 'active',
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { shortDescription: { $regex: searchTerm, $options: 'i' } },
        { brand: { $regex: searchTerm, $options: 'i' } },
        { tags: { $in: [new RegExp(searchTerm, 'i')] } }
      ]
    };

    // 2. Filter theo category nếu có
    if (category) {
      const categoryDoc = await Category.findOne({ slug: category });
      if (categoryDoc) {
        searchFilter.categoryId = categoryDoc._id;
      }
    }

    // 3. Lấy products (không sort theo price ở đây)
    let sortOption = {};
    if (sortBy === 'newest') {
      sortOption = { createdAt: -1 };
    } else if (sortBy === 'oldest') {
      sortOption = { createdAt: 1 };
    } else if (sortBy === 'relevance') {
      // Sort by relevance: exact match in name first, then partial match
      sortOption = { name: 1 };
    }

    const products = await Product.find(searchFilter)
      .populate('categoryId', 'name slug')
      .sort(sortOption);

    // 4. Ghép variants và tính giá
    const productsWithVariants = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id });

        // chỉ lấy variant có stock > 0
        const validVariants = variants.filter(v => 
          v.sizes.some(s => s.stock > 0)
        );

        if (validVariants.length === 0) {
          return null; // Loại bỏ product không có variant khả dụng
        }

        // lấy 5 màu khác nhau cho hiển thị
        const uniqueColorVariants = [];
        const seenColors = new Set();
        for (const variant of validVariants) {
          if (!seenColors.has(variant.color) && uniqueColorVariants.length < 5) {
            uniqueColorVariants.push(variant);
            seenColors.add(variant.color);
          }
        }

        // tìm giá thấp nhất
        let minPriceVariant = null;
        let maxPriceVariant = null;
        validVariants.forEach(variant => {
          variant.sizes.forEach(s => {
            const finalPrice = s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price;
            const originalPrice = s.price;
            
            if (!minPriceVariant || finalPrice < minPriceVariant.finalPrice) {
              minPriceVariant = {
                ...s.toObject(),
                variantId: variant._id,
                finalPrice,
                originalPrice,
                discountPercentage: s.discountPrice ? Math.round((1 - s.discountPrice / s.price) * 100) : 0
              };
            }
            
            if (!maxPriceVariant || finalPrice > maxPriceVariant.finalPrice) {
              maxPriceVariant = {
                ...s.toObject(),
                finalPrice,
                originalPrice
              };
            }
          });
        });

        // tất cả màu và size
        const availableColors = [...new Set(validVariants.map(v => v.color).filter(Boolean))];
        const availableSizes = [...new Set(validVariants.flatMap(v => v.sizes.map(s => s.size)).filter(Boolean))];

        // Tính relevance score
        let relevanceScore = 0;
        const lowerSearchTerm = searchTerm.toLowerCase();
        const lowerName = product.name.toLowerCase();
        
        if (lowerName === lowerSearchTerm) relevanceScore += 100; // exact match
        else if (lowerName.startsWith(lowerSearchTerm)) relevanceScore += 50; // starts with
        else if (lowerName.includes(lowerSearchTerm)) relevanceScore += 25; // contains

        if (product.brand && product.brand.toLowerCase().includes(lowerSearchTerm)) relevanceScore += 10;
        if (product.tags && product.tags.some(tag => tag.toLowerCase().includes(lowerSearchTerm))) relevanceScore += 5;

        return {
          _id: product._id,
          name: product.name,
          slug: product.slug,
          shortDescription: product.shortDescription,
          brand: product.brand,
          category: product.categoryId,
          rating: product.rating,
          price: minPriceVariant?.originalPrice || 0,
          discountPrice: minPriceVariant?.discountPrice,
          finalPrice: minPriceVariant?.finalPrice || 0,
          maxPrice: maxPriceVariant?.finalPrice || 0,
          discountPercentage: minPriceVariant?.discountPercentage || 0,
          onSale: minPriceVariant?.discountPrice > 0,
          images: uniqueColorVariants.length > 0 ? uniqueColorVariants[0].images : [],
          colors: availableColors.slice(0, 5), // Limit to 5 colors for display
          colorVariants: uniqueColorVariants.map(v => ({
            color: v.color,
            colorCode: v.colorCode,
            images: v.images
          })),
          availableColors,
          availableSizes,
          totalStock: validVariants.reduce((sum, v) => 
            sum + v.sizes.reduce((sSum, s) => sSum + s.stock, 0), 0),
          relevanceScore
        };
      })
    );

    // 5. Loại bỏ products null và apply filters
    let filteredProducts = productsWithVariants.filter(p => p !== null);

    // Filter theo price
    if (minPrice || maxPrice) {
      filteredProducts = filteredProducts.filter(product => {
        const productPrice = product.finalPrice;
        if (minPrice && productPrice < parseInt(minPrice)) return false;
        if (maxPrice && productPrice > parseInt(maxPrice)) return false;
        return true;
      });
    }

    // Filter theo color
    if (color) {
      filteredProducts = filteredProducts.filter(product => 
        product.availableColors.includes(color)
      );
    }

    // Filter theo size
    if (size) {
      filteredProducts = filteredProducts.filter(product => 
        product.availableSizes.includes(size)
      );
    }

    // 6. Sort products
    if (sortBy === 'price') {
      filteredProducts = filteredProducts.sort((a, b) => {
        return sortOrder === 'desc' 
          ? b.finalPrice - a.finalPrice 
          : a.finalPrice - b.finalPrice;
      });
    } else if (sortBy === 'relevance') {
      filteredProducts = filteredProducts.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }

    // 7. Pagination
    const total = filteredProducts.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedProducts = filteredProducts.slice(startIndex, endIndex);

    // 8. Search suggestions (optional)
    const suggestions = [];
    if (paginatedProducts.length === 0) {
      const suggestionProducts = await Product.find({
        status: 'active',
        name: { $regex: searchTerm.slice(0, -1), $options: 'i' }
      }).limit(5);
      
      suggestions.push(...suggestionProducts.map(p => p.name));
    }

    res.json({
      query: searchTerm,
      products: paginatedProducts,
      suggestions,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        total,
        limit: parseInt(limit),
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: {
        appliedFilters: {
          minPrice: minPrice ? parseInt(minPrice) : null,
          maxPrice: maxPrice ? parseInt(maxPrice) : null,
          color,
          size,
          category
        },
        availableFilters: {
          priceRange: {
            min: Math.min(...filteredProducts.map(p => p.finalPrice)),
            max: Math.max(...filteredProducts.map(p => p.finalPrice))
          },
          colors: [...new Set(filteredProducts.flatMap(p => p.availableColors))],
          sizes: [...new Set(filteredProducts.flatMap(p => p.availableSizes))]
        }
      }
    });

  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({ 
      message: 'Internal server error',
      error: error.message 
    });
  }
};


exports.getAllProducts = async (req, res) => {
  try {
    const products = await Product.find();

    const productsWithVariants = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id });

        const defaultVariant =
          variants.find((v) => v.onSale) || variants[0] || null;

        return {
          ...product.toObject(),
          variants,
          defaultVariant,
          variantsCount: variants.length,
        };
      })
    );

    res.status(200).json({
      status: "success",
      message: "Lấy danh sách sản phẩm thành công",
      data: productsWithVariants,
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Lỗi khi lấy danh sách sản phẩm",
      data: null,
      error: {
        code: 500,
        details: err.message,
      },
    });
  }
};

exports.getAllProductsWithDefaultVariant = async (req, res) => {
  try {
    // Lấy tất cả product
    const products = await Product.find();

    // Với mỗi product, lấy variant đầu tiên hoặc variant đang onSale
    const productsWithDefaultVariant = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id });

        const defaultVariant =
          variants.find((v) => v.onSale) || variants[0] || null;

        return {
          ...product.toObject(),
          defaultVariant,
          variantsCount: variants.length,
        };
      })
    );

    res.status(200).json({
      status: "success",
      message: "Lấy danh sách sản phẩm kèm variant đầu tiên thành công",
      data: productsWithDefaultVariant,
      error: null,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Lỗi khi lấy danh sách sản phẩm với variant",
      data: null,
      error: {
        code: 500,
        details: err.message,
      },
    });
  }
};
