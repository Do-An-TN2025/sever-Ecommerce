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

    const PAGE = parseInt(page);
    const LIMIT = parseInt(limit);

    const GENDER_GROUPS = new Set(['nam','nu','tre-em']);
    let productFilter;
    let categoryMeta;

    if (GENDER_GROUPS.has(slug)) {
      // --- Nhóm giới tính ---
      // 1. Lấy tất cả category có liên quan (tùy bạn có field nào thêm thì bổ sung)
      const catQuery = {
        $or: [
          { slug: new RegExp(`${slug}$`, 'i') },              // slug kết thúc bằng -nam / -nu / -tre-em
          { gender: slug },                                   // nếu Category có field gender
          { group: slug }                                     // nếu có field group
        ]
      };
      const relatedCategories = await Category.find(catQuery).lean();
      const categoryIds = relatedCategories.map(c => c._id);

      productFilter = {
        status: 'active',
        $or: [
          ...(categoryIds.length ? [{ categoryId: { $in: categoryIds } }] : []),
          { gender: slug },        // nếu Product có field gender
          { tags: slug }           // fallback dựa trên tags
        ]
      };

      categoryMeta = {
        _id: null,
        name: slug === 'nam' ? 'Sản phẩm Nam' : slug === 'nu' ? 'Sản phẩm Nữ' : 'Sản phẩm Trẻ em',
        slug,
        type: 'group'
      };
    } else {
      // --- Category đơn ---
      const category = await Category.findOne({ slug });
      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }
      productFilter = { 
        categoryId: category._id,
        status: 'active'
      };
      categoryMeta = {
        _id: category._id,
        name: category.name,
        slug: category.slug,
        type: 'category'
      };
    }

    // 2. Query products (áp dụng sort gốc trừ price)
    const baseSort = sortBy !== 'price'
      ? { [sortBy]: sortOrder === 'desc' ? -1 : 1 }
      : { createdAt: -1 };

    const products = await Product.find(productFilter)
      .populate('categoryId', 'name slug')
      .sort(baseSort)
      .skip((PAGE - 1) * LIMIT)
      .limit(LIMIT);

    // 3. Build variants data
    const productsWithVariants = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id }).lean();

        const validVariants = variants.filter(v => 
          Array.isArray(v.sizes) && v.sizes.some(s => (s.stock || 0) > 0)
        );

        if (!validVariants.length) {
          return {
            _id: product._id,
            name: product.name,
            slug: product.slug,
            shortDescription: product.shortDescription,
            category: product.categoryId,
            rating: product.rating,
            price: 0,
            discountPrice: 0,
            onSale: false,
            finalPrice: 0,
            colorVariants: [],
            availableColors: [],
            availableSizes: [],
            totalStock: 0
          };
        }

        // lấy 5 màu khác nhau
        const uniqueColorVariants = [];
        const seenColors = new Set();
        for (const variant of validVariants) {
          if (!seenColors.has(variant.color) && uniqueColorVariants.length < 5) {
            uniqueColorVariants.push(variant);
            seenColors.add(variant.color);
          }
        }

        // tìm size giá thấp nhất
        let minPriceVariant = null;
        validVariants.forEach(variant => {
          variant.sizes.forEach(s => {
            const fp = (s.discountPrice && s.discountPrice > 0) ? s.discountPrice : s.price;
            if (!minPriceVariant || fp < minPriceVariant.finalPrice) {
              minPriceVariant = {
                ...s,
                variantId: variant._id,
                finalPrice: fp
              };
            }
          });
        });

        const availableColors = [...new Set(validVariants.map(v => v.color).filter(Boolean))];
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
            onSale: !!(minPriceVariant?.discountPrice && minPriceVariant.discountPrice > 0),
            finalPrice: minPriceVariant?.finalPrice || 0,
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
              sum + v.sizes.reduce((sSum, s) => sSum + (s.stock || 0), 0), 0)
        };
      })
    );

    // 4. Filter phụ
    let filteredProducts = productsWithVariants;

    if (minPrice || maxPrice) {
      const minP = minPrice ? parseInt(minPrice) : null;
      const maxP = maxPrice ? parseInt(maxPrice) : null;
      filteredProducts = filteredProducts.filter(p => {
        const priceVal = p.finalPrice;
        if (minP !== null && priceVal < minP) return false;
        if (maxP !== null && priceVal > maxP) return false;
        return true;
      });
    }

    if (color) {
      filteredProducts = filteredProducts.filter(p => p.availableColors.includes(color));
    }
    if (size) {
      filteredProducts = filteredProducts.filter(p => p.availableSizes.includes(size));
    }

    // 5. Sort lại theo price nếu cần
    if (sortBy === 'price') {
      filteredProducts = [...filteredProducts].sort((a,b) => 
        sortOrder === 'desc'
          ? b.finalPrice - a.finalPrice
          : a.finalPrice - b.finalPrice
      );
    }

    // 6. Tổng (dựa theo productFilter ban đầu, không tính min/max/color/size)
    const totalBase = await Product.countDocuments(productFilter);

    // 7. Pagination thủ công sau filter
    const start = (PAGE - 1) * LIMIT;
    const end = start + LIMIT;
    const paginatedProducts = filteredProducts.slice(start, end);

    res.json({
      products: paginatedProducts,
      pagination: {
        currentPage: PAGE,
        totalPages: Math.ceil(totalBase / LIMIT),
        total: totalBase,
        limit: LIMIT,
        returned: paginatedProducts.length,
        afterFilterCount: filteredProducts.length
      },
      category: categoryMeta
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
      sortBy = 'relevance',
      sortOrder = 'desc',
      minPrice,
      maxPrice,
      color,
      size,
      category,
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
    const searchTerms = searchTerm.split(/\s+/).filter(term => term.length > 0);
    const regexPatterns = searchTerms.map(term => new RegExp(term, 'i'));

    const searchFilter = {
      status: 'active',
      $or: [
        { name: { $regex: searchTerm, $options: 'i' } },
        { shortDescription: { $regex: searchTerm, $options: 'i' } },
        { brand: { $regex: searchTerm, $options: 'i' } },
        { tags: { $in: regexPatterns } },
        
        ...searchTerms.map(term => ({
          name: { $regex: term, $options: 'i' }
        })),
        ...searchTerms.map(term => ({
          shortDescription: { $regex: term, $options: 'i' }
        })),
        ...searchTerms.map(term => ({
          brand: { $regex: term, $options: 'i' }
        }))
      ]
    };

    if (category) {
      const categoryDoc = await Category.findOne({ slug: category });
      if (categoryDoc) {
        searchFilter.categoryId = categoryDoc._id;
      }
    }
    let products = await Product.find(searchFilter)
      .populate('categoryId', 'name slug');

    // 4. Tính relevance score chi tiết hơn
    const productsWithRelevance = await Promise.all(
      products.map(async (product) => {
        const variants = await ProductVariant.find({ productId: product._id });
        const validVariants = variants.filter(v => 
          v.sizes.some(s => s.stock > 0)
        );

        if (validVariants.length === 0) {
          return null;
        }

        // Tính relevance score chi tiết
        let relevanceScore = 0;
        const lowerSearchTerm = searchTerm.toLowerCase();
        const lowerName = product.name.toLowerCase();
        const lowerDescription = product.shortDescription?.toLowerCase() || '';
        const lowerBrand = product.brand?.toLowerCase() || '';

        // Exact match - điểm cao nhất
        if (lowerName === lowerSearchTerm) relevanceScore += 100;
        else if (lowerName.startsWith(lowerSearchTerm)) relevanceScore += 80;
        else if (lowerName.includes(lowerSearchTerm)) relevanceScore += 60;

        // Match từng từ trong search term
        searchTerms.forEach(term => {
          const lowerTerm = term.toLowerCase();
          
          // Trong name
          if (lowerName === lowerTerm) relevanceScore += 40;
          else if (lowerName.includes(lowerTerm)) relevanceScore += 20;
          
          // Trong description
          if (lowerDescription.includes(lowerTerm)) relevanceScore += 10;
          
          // Trong brand
          if (lowerBrand.includes(lowerTerm)) relevanceScore += 15;
        });

        // Match trong tags
        if (product.tags) {
          product.tags.forEach(tag => {
            const lowerTag = tag.toLowerCase();
            if (lowerTag === lowerSearchTerm) relevanceScore += 30;
            else if (lowerTag.includes(lowerSearchTerm)) relevanceScore += 15;
            
            searchTerms.forEach(term => {
              if (lowerTag.includes(term.toLowerCase())) relevanceScore += 8;
            });
          });
        }

        // Ưu tiên products có nhiều từ khớp hơn
        const matchedTerms = searchTerms.filter(term => 
          lowerName.includes(term.toLowerCase()) ||
          lowerDescription.includes(term.toLowerCase()) ||
          lowerBrand.includes(term.toLowerCase())
        );
        
        if (matchedTerms.length === searchTerms.length) {
          relevanceScore += 25; // Tất cả từ đều khớp
        } else if (matchedTerms.length > 0) {
          relevanceScore += (matchedTerms.length * 10); // Một số từ khớp
        }

        // Phần còn lại của logic xử lý variants và price giữ nguyên...
        const uniqueColorVariants = [];
        const seenColors = new Set();
        for (const variant of validVariants) {
          if (!seenColors.has(variant.color) && uniqueColorVariants.length < 5) {
            uniqueColorVariants.push(variant);
            seenColors.add(variant.color);
          }
        }

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

        const availableColors = [...new Set(validVariants.map(v => v.color).filter(Boolean))];
        const availableSizes = [...new Set(validVariants.flatMap(v => v.sizes.map(s => s.size)).filter(Boolean))];

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
          colors: availableColors.slice(0, 5),
          colorVariants: uniqueColorVariants.map(v => ({
            color: v.color,
            colorCode: v.colorCode,
            images: v.images
          })),
          availableColors,
          availableSizes,
          totalStock: validVariants.reduce((sum, v) => 
            sum + v.sizes.reduce((sSum, s) => sSum + s.stock, 0), 0),
          relevanceScore,
          searchMatchDetails: {
            nameMatches: searchTerms.filter(term => 
              product.name.toLowerCase().includes(term.toLowerCase())
            ).length,
            totalSearchTerms: searchTerms.length
          }
        };
      })
    );

    // 5. Loại bỏ products null và apply filters
    let filteredProducts = productsWithRelevance
      .filter(p => p !== null)
      .filter(p => p.relevanceScore > 0); // Chỉ lấy products có relevance score > 0

    // Filter theo price, color, size (giữ nguyên)
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

    // 6. Sort products với ưu tiên relevance
    if (sortBy === 'price') {
      filteredProducts.sort((a, b) => {
        return sortOrder === 'desc' 
          ? b.finalPrice - a.finalPrice 
          : a.finalPrice - b.finalPrice;
      });
    } else {
      filteredProducts.sort((a, b) => {
        // Ưu tiên products match tất cả từ khóa
        const aAllTerms = a.searchMatchDetails.nameMatches === a.searchMatchDetails.totalSearchTerms;
        const bAllTerms = b.searchMatchDetails.nameMatches === b.searchMatchDetails.totalSearchTerms;
        
        if (aAllTerms && !bAllTerms) return -1;
        if (!aAllTerms && bAllTerms) return 1;
        return b.relevanceScore - a.relevanceScore;
      });
    }

    // 7. Pagination
    const total = filteredProducts.length;
    const totalPages = Math.ceil(total / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedProducts = filteredProducts.slice(startIndex, endIndex);

    // 8. Search suggestions cải tiến
    const suggestions = [];
    if (paginatedProducts.length === 0) {
      // Thử tìm với ít từ hơn
      if (searchTerms.length > 1) {
        const simplerQuery = searchTerms.slice(0, -1).join(' ');
        const suggestionProducts = await Product.find({
          status: 'active',
          $or: [
            { name: { $regex: simplerQuery, $options: 'i' } },
            { shortDescription: { $regex: simplerQuery, $options: 'i' } }
          ]
        }).limit(3);
        
        if (suggestionProducts.length > 0) {
          suggestions.push(`Thử tìm với: "${simplerQuery}"`);
        }
      }
      
      const relatedProducts = await Product.find({
        status: 'active',
        $or: searchTerms.map(term => ({
          name: { $regex: term, $options: 'i' }
        }))
      }).limit(2);
      
      suggestions.push(...relatedProducts.map(p => p.name));
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
        availableFilters: filteredProducts.length > 0 ? {
          priceRange: {
            min: Math.min(...filteredProducts.map(p => p.finalPrice)),
            max: Math.max(...filteredProducts.map(p => p.finalPrice))
          },
          colors: [...new Set(filteredProducts.flatMap(p => p.availableColors))],
          sizes: [...new Set(filteredProducts.flatMap(p => p.availableSizes))]
        } : null
      },
      searchMetrics: {
        totalFound: total,
        searchTerms: searchTerms.length,
        matchingStrategy: searchTerms.length > 1 ? 'multi-term' : 'single-term'
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
