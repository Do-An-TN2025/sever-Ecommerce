const Product = require("../models/Product");
const Category = require("../models/Category");
const ProductVariant = require("../models/ProductVariant");
const mlService = require("../services/mlRecommenderService");
const Order = require("../models/Order");
const ProductReview = require('../models/ProductReview');
const ProductRecentlyViewed = require('../models/ProductRecentlyViewed');

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
    // First find the product to ensure it exists and to get its id
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Không tìm thấy sản phẩm" });

    // Delete all variants belonging to this product
    await ProductVariant.deleteMany({ productId: product._id });

    // Then delete the product itself
    await Product.findByIdAndDelete(req.params.id);

    res.json({ message: "Xóa sản phẩm và các variant liên quan thành công" });
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

    // Fetch all base products matching the productFilter (we will apply
    // variant/price/color/size filters in-memory and then paginate the final list).
    // Note: for very large categories you may want to add a sensible cap or
    // move some filters to DB-level to avoid O(N) memory usage.
    const products = await Product.find(productFilter)
      .populate('categoryId', 'name slug')
      .sort(baseSort)
      .lean();

    // 3. Build variants data for all matched products
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

    // 6. Tổng sau khi áp dụng các filter phụ (minPrice/color/size)
    const totalAfterFilter = filteredProducts.length;

    // 7. Pagination thủ công sau filter
    const start = (PAGE - 1) * LIMIT;
    const end = start + LIMIT;
    const paginatedProducts = filteredProducts.slice(start, end);

    res.json({
      products: paginatedProducts,
      pagination: {
        currentPage: PAGE,
        totalPages: Math.ceil(totalAfterFilter / LIMIT),
        total: totalAfterFilter,
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

    // --- Reviews: summary + recent reviews ---
    let reviewsSummary = { average: 0, count: 0, breakdown: { 1:0,2:0,3:0,4:0,5:0 } };
    let recentReviews = [];
    try {
      const stats = await ProductReview.aggregate([
        { $match: { productId: product._id, approved: true } },
        { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]);
      if (stats && stats.length > 0) {
        reviewsSummary.average = stats[0].avgRating ? Number(stats[0].avgRating.toFixed(2)) : 0;
        reviewsSummary.count = stats[0].count || 0;
      }
      const breakdown = await ProductReview.aggregate([
        { $match: { productId: product._id, approved: true } },
        { $group: { _id: '$rating', count: { $sum: 1 } } }
      ]);
      (breakdown || []).forEach(b => { const k = Number(b._id); if (k>=1 && k<=5) reviewsSummary.breakdown[k] = b.count; });

      recentReviews = await ProductReview.find({ productId: product._id, approved: true })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('userId', 'firstName lastName avatar')
        .populate('adminReply.adminId', 'firstName lastName avatar')
        .lean();
    } catch (e) {
      console.error('Error loading product reviews for details:', e && e.message ? e.message : e);
      reviewsSummary = { average: 0, count: 0, breakdown: {1:0,2:0,3:0,4:0,5:0} };
      recentReviews = [];
    }

    // Fallback: if there are no *approved* reviews but the product document
    // indicates there are reviews (product.rating.count > 0), use product.rating
    // as the summary and attempt to load reviews without the `approved` filter
    // (useful when reviews exist but haven't been marked `approved` yet).
    // This avoids showing an empty reviewsSummary when product.rating shows data.
    if (reviewsSummary.count === 0 && product.rating && product.rating.count && product.rating.count > 0) {
      try {
        reviewsSummary = {
          average: typeof product.rating.average === 'number'
            ? Number(product.rating.average.toFixed ? product.rating.average.toFixed(2) : product.rating.average)
            : Number((product.rating.average || 0)),
          count: product.rating.count,
          breakdown: reviewsSummary.breakdown
        };
      } catch (e) {
        // fallback if toFixed not available or other issue
        reviewsSummary = { average: product.rating.average || 0, count: product.rating.count, breakdown: reviewsSummary.breakdown };
      }

      try {
        const fallbackReviews = await ProductReview.find({ productId: product._id })
          .sort({ createdAt: -1 })
          .limit(5)
          .populate('userId', 'firstName lastName avatar')
          .populate('adminReply.adminId', 'firstName lastName avatar')
          .lean();
        if (Array.isArray(fallbackReviews) && fallbackReviews.length > 0) {
          recentReviews = fallbackReviews;
        }
      } catch (e) {
        console.error('Error loading fallback product reviews:', e && e.message ? e.message : e);
      }
    }

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
      totalStock,
      reviewsSummary,
      recentReviews: recentReviews.map(r => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment || r.content || null,
        user: r.userId ? { _id: r.userId._id, firstName: r.userId.firstName, lastName: r.userId.lastName, avatar: r.userId.avatar } : null,
        createdAt: r.createdAt,
        adminReply: r.adminReply ? {
          message: r.adminReply.message || null,
          repliedAt: r.adminReply.repliedAt || null,
          admin: r.adminReply.adminId ? {
            _id: r.adminReply.adminId._id || r.adminReply.adminId,
            firstName: r.adminReply.adminId.firstName,
            lastName: r.adminReply.adminId.lastName,
            avatar: r.adminReply.adminId.avatar
          } : null
        } : null
      }))
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

exports.getVariantDetails = async (req, res) => {
  try {
    const { variantId, size } = req.query;

    if (!variantId) {
      return res.status(400).json({ message: "Thiếu variantId" });
    }

    const variant = await ProductVariant.findById(variantId).lean();
    if (!variant) {
      return res.status(404).json({ message: "Không tìm thấy variant" });
    }

    const product = await Product.findById(variant.productId)
      .populate("categoryId", "name slug")
      .lean();

    if (!product) {
      return res.status(404).json({ message: "Không tìm thấy sản phẩm gốc" });
    }

    const sizeInfo = size
      ? variant.sizes.find((s) => s.size.toLowerCase() === size.toLowerCase())
      : null;

    const formattedSizes = variant.sizes.map((s) => ({
      size: s.size,
      price: s.price,
      discountPrice: s.discountPrice,
      stock: s.stock,
      finalPrice:
        s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price,
      onSale: s.onSale,
    }));

    const response = {
      product: {
        _id: product._id,
        name: product.name,
        slug: product.slug,
        shortDescription: product.shortDescription,
        brand: product.brand,
        category: product.categoryId,
        rating: product.rating,
      },
      variant: {
        _id: variant._id,
        color: variant.color,
        colorCode: variant.colorCode,
        images: variant.images,
        status: variant.status,
        sizes: formattedSizes,
      },
      selectedSize: sizeInfo
        ? {
            size: sizeInfo.size,
            price: sizeInfo.price,
            discountPrice: sizeInfo.discountPrice,
            stock: sizeInfo.stock,
            finalPrice:
              sizeInfo.discountPrice && sizeInfo.discountPrice > 0
                ? sizeInfo.discountPrice
                : sizeInfo.price,
            onSale: sizeInfo.onSale,
          }
        : null,
    };

    return res.status(200).json(response);
  } catch (err) {
    console.error("❌ Lỗi khi lấy chi tiết variant:", err);
    return res.status(500).json({
      message: "Lỗi server khi lấy chi tiết variant",
      error: err.message,
    });
  }
};

exports.getAllProducts = async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });

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

// GET /api/products/all?key=quần áo&page=1&limit=20
// Return all products (paginated) and if `key` provided, filter products that match any keyword
exports.getAllProductsFiltered = async (req, res) => {
  try {
    const { key, page = 1, limit = 20 } = req.query;
    const PAGE = Math.max(1, parseInt(page));
    const LIMIT = Math.max(1, Math.min(100, parseInt(limit)));

    const filter = { status: 'active' };

    if (key && String(key).trim().length > 0) {
      // split by spaces or commas, remove empties
      const terms = String(key).split(/[ ,]+/).map(t => t.trim()).filter(Boolean);
      if (terms.length > 0) {
        const regexes = terms.map(t => new RegExp(t, 'i'));
        filter.$or = [
          { name: { $in: regexes } },
          { shortDescription: { $in: regexes } },
          { brand: { $in: regexes } },
          { tags: { $in: regexes } }
        ];
      }
    }

    const skip = (PAGE - 1) * LIMIT;
    const products = await Product.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(LIMIT)
      .lean();

    const total = await Product.countDocuments(filter);

    // load variants for returned products
    const productIds = products.map(p => p._id);
    const variants = await ProductVariant.find({ productId: { $in: productIds } }).lean();
    const variantsByProduct = variants.reduce((acc, v) => {
      const k = String(v.productId);
      (acc[k] = acc[k] || []).push(v);
      return acc;
    }, {});

    const results = products.map(p => {
      const pvars = variantsByProduct[String(p._id)] || [];
      const defaultVariant = pvars.find(v => v.onSale) || pvars[0] || null;
      return {
        ...p,
        variants: pvars,
        defaultVariant,
        variantsCount: pvars.length
      };
    });

    return res.status(200).json({
      status: 'success',
      message: 'Lấy sản phẩm thành công',
      data: results,
      meta: { total, page: PAGE, limit: LIMIT }
    });
  } catch (err) {
    console.error('getAllProductsFiltered error', err);
    return res.status(500).json({ status: 'error', message: 'Lỗi server', error: err.message });
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

exports.mlRecommend = async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 12;
    const recs = await mlService.getCfRecommendationsForUser(req.user?.id, limit);
    return res.json({ recommendations: recs });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Error getting ML recommendations" });
  }
};

exports.getBestSellers = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 6));
    const days = parseInt(req.query.days) || 90;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Aggregate order items to compute sold quantities per product
    const agg = await Order.aggregate([
      { $match: { orderStatus: { $in: ["delivered", "completed"] }, createdAt: { $gte: since } } },
      { $unwind: "$items" },
      { $group: {
        _id: "$items.productId",
        soldQuantity: { $sum: "$items.quantity" },
        lastSoldAt: { $max: "$createdAt" }
      } },
      { $sort: { soldQuantity: -1, lastSoldAt: -1 } },
      { $limit: limit }
    ]);

    const productIds = agg.map(a => a._id).filter(Boolean);
    if (!productIds.length) return res.json({ products: [] });

    const products = await Product.find({ _id: { $in: productIds } })
      .select('name slug shortDescription brand categoryId')
      .lean();

    // Get variants to compute min final price and an image
    const variants = await ProductVariant.find({ productId: { $in: productIds } }).lean();
    const variantsByProduct = {};
    variants.forEach(v => {
      const pid = String(v.productId);
      if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
      variantsByProduct[pid].push(v);
    });

    // Map products preserving order from agg
    const productsMap = new Map(products.map(p => [String(p._id), p]));
    const result = agg.map(a => {
      const pid = String(a._id);
      const p = productsMap.get(pid);
      if (!p) return null;

      // compute min final price across variants
      const pvars = variantsByProduct[pid] || [];
      let minFinal = Infinity;
      let image = [];
      pvars.forEach(v => {
        (v.sizes || []).forEach(s => {
          const fp = (s.discountPrice && s.discountPrice > 0) ? s.discountPrice : s.price;
          if (fp < minFinal) minFinal = fp;
        });
        if ((!image || image.length === 0) && Array.isArray(v.images) && v.images.length) image = v.images;
      });

      return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        brand: p.brand,
        categoryId: p.categoryId,
        images: image,
        finalPrice: minFinal === Infinity ? 0 : minFinal,
        soldQuantity: a.soldQuantity,
        lastSoldAt: a.lastSoldAt
      };
    }).filter(Boolean);

    return res.json({ products: result });
  } catch (err) {
    console.error('getBestSellers error', err);
    return res.status(500).json({ message: 'Internal server error', error: err.message });
  }
};

exports.getNewProducts = async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 6));

    const products = await Product.find({ status: 'active' })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    if (!products || products.length === 0) return res.json({ products: [] });

    const productIds = products.map(p => p._id);
    const variants = await ProductVariant.find({ productId: { $in: productIds } }).lean();
    const variantsByProduct = {};
    variants.forEach(v => {
      const pid = String(v.productId);
      if (!variantsByProduct[pid]) variantsByProduct[pid] = [];
      variantsByProduct[pid].push(v);
    });

    const result = products.map(p => {
      const pid = String(p._id);
      const pvars = variantsByProduct[pid] || [];
      let minFinal = Infinity;
      let image = [];
      pvars.forEach(v => {
        (v.sizes || []).forEach(s => {
          const fp = (s.discountPrice && s.discountPrice > 0) ? s.discountPrice : s.price;
          if (fp < minFinal) minFinal = fp;
        });
        if ((!image || image.length === 0) && Array.isArray(v.images) && v.images.length) image = v.images;
      });

      return {
        _id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        brand: p.brand,
        categoryId: p.categoryId,
        images: image,
        finalPrice: minFinal === Infinity ? 0 : minFinal,
        createdAt: p.createdAt
      };
    });

    return res.json({ products: result });
  } catch (err) {
    console.error('getNewProducts error', err);
    return res.status(500).json({ message: 'Internal server error', error: err.message });
  }
};


exports.getRecentlyViewedProducts = async (req, res) => {
  try {
    // 1) Parse incoming slugs (body or query). Accept array or JSON/stringified array or comma list
    let slugs = [];
    if (Array.isArray(req.body?.slugs)) slugs = req.body.slugs;
    else if (req.query?.slugs) {
      const raw = req.query.slugs;
      if (Array.isArray(raw)) slugs = raw;
      else if (typeof raw === 'string') {
        try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) slugs = parsed; else slugs = raw.split(',').map(s => s.trim()).filter(Boolean); }
        catch { slugs = raw.split(',').map(s => s.trim()).filter(Boolean); }
      }
    }

    if (!Array.isArray(slugs)) return res.status(400).json({ message: 'slugs must be an array' });

    const uniqSlugs = [...new Set(slugs.map(s => String(s).trim()).filter(Boolean))];
    if (uniqSlugs.length === 0) return res.json({ products: [] });

    // 2) Load products and variants in bulk
    const products = await Product.find({ slug: { $in: uniqSlugs }, status: 'active' })
      .populate('categoryId', 'name slug')
      .lean();
    if (!products.length) return res.json({ products: [] });

    const productIds = products.map(p => p._id);
    const variants = await ProductVariant.find({ productId: { $in: productIds } }).lean();

    const variantsByProduct = variants.reduce((acc, v) => {
      const k = String(v.productId);
      (acc[k] = acc[k] || []).push(v);
      return acc;
    }, {});

    const prodBySlug = products.reduce((acc, p) => (acc[p.slug] = p, acc), {});

    // 3) Persist recently viewed for this user/session — only if we have a userId or sessionId
    (async () => {
      try {
        const userId = req.user?._id || req.user?.id || null;
        // Always persist: fallback to shared 'public' when no sessionId provided
        const sessionId = req.body?.sessionId || req.query?.sessionId || req.cookies?.sessionId || 'public';
        const key = userId ? { userId } : { sessionId };
        const items = uniqSlugs.map(s => ({ slug: s, viewedAt: new Date() }));
        if (!items.length) return;

        // Previously we updated a single per-user/session document.
        // Change behavior: create a new document for EACH API call so you can
        // track each request separately (as requested).
        await ProductRecentlyViewed.create({
          ...(userId ? { userId } : { sessionId }),
          products: items,
          createdAt: new Date()
        });

      } catch (e) {
        console.error('Error saving recently viewed (non-fatal):', e);
      }
    })();

    // 4) Build response (preserve order of uniqSlugs)
    const result = [];
    for (const slug of uniqSlugs) {
      const p = prodBySlug[slug];
      if (!p) continue;

      const pVars = variantsByProduct[String(p._id)] || [];
      const valid = pVars.filter(v => Array.isArray(v.sizes) && v.sizes.some(sz => (sz.stock || 0) > 0));
      if (!valid.length) continue;

      let minFinal = Infinity;
      valid.forEach(v => v.sizes.forEach(sz => {
        const fp = (sz.discountPrice && sz.discountPrice > 0) ? sz.discountPrice : sz.price;
        if (fp < minFinal) minFinal = fp;
      }));

      const vWithImg = valid.find(v => Array.isArray(v.images) && v.images.length > 0);
      const images = vWithImg ? vWithImg.images : [];

      result.push({
        _id: p._id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        images,
        finalPrice: minFinal === Infinity ? 0 : minFinal,
        categoryId: p.categoryId
      });
    }

    return res.json({ products: result });
  } catch (err) {
    console.error('getRecentlyViewedProducts error', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
};








