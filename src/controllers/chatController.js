const Product = require("../models/Product");
const Category = require("../models/Category");
const ProductVariant = require("../models/ProductVariant");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
const API_KEY = process.env.GOOGLE_API_KEY;
const CHAT_DEBUG = process.env.CHAT_DEBUG === '1';

let _cachedMeta = { ts: 0, categories: [], brands: [] };
const META_TTL = 60_000; // 60s cache

let genAI = null;
if (API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(API_KEY);
  } catch (e) {
    console.warn("Init Gemini failed:", e.message);
  }
}

async function loadMeta() {
  const now = Date.now();
  if (now - _cachedMeta.ts < META_TTL) return _cachedMeta;
  const categories = await Category.find({}, 'slug name').lean();
  const brands = await Product.distinct('brand');
  _cachedMeta = { ts: now, categories, brands: brands.filter(Boolean) };
  return _cachedMeta;
}

// ---------- Parsing helpers ----------
const COLOR_ALIASES = {
  'đen': ['đen','black','đen tuyền'],
  'trắng': ['trắng','white'],
  'đỏ': ['đỏ','red'],
  'xanh dương': ['xanh dương','xanh lam','blue'],
  'xanh lá': ['xanh lá','green'],
  'vàng': ['vàng','yellow','gold'],
  'nâu': ['nâu','brown'],
  'xám': ['xám','gray','grey','ghi'],
  'tím': ['tím','purple','violet'],
  'hồng': ['hồng','pink'],
  'cam': ['cam','orange']
};

function normalizeColor(textLower) {
  for (const base in COLOR_ALIASES) {
    if (COLOR_ALIASES[base].some(a => textLower.includes(a))) return base;
  }
  return null;
}

function extractPrices(textLower) {
  // Hỗ trợ: "dưới 300k", "khoảng 200k-400k", "từ 500 đến 1 triệu", ">= 150k", "~300k"
  const unitFactor = (numStr, unit) => {
    let n = Number(numStr);
    if (isNaN(n)) return null;
    if (!unit) return n;
    unit = unit.trim();
    if (['k','ngàn','nghìn','k.'].includes(unit)) return n * 1_000;
    if (['tr','triệu'].includes(unit)) return n * 1_000_000;
    if (['trăm'].includes(unit)) return n * 100;
    return n;
  };

  // Range patterns
  let minPrice = null, maxPrice = null;
  const rangeRegex = /(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)\s*(?:-|đến|to|~|>|<|>=|<=)?\s*(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)/;
  const singleRegex = /(trên|từ|>=|>|dưới|<=|<|~)?\s*(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)/;

  const rangeMatch = textLower.match(rangeRegex);
  if (rangeMatch) {
    const v1 = unitFactor(rangeMatch[1].replace(/[.,]/g,''), rangeMatch[3]);
    const v2 = unitFactor(rangeMatch[4].replace(/[.,]/g,''), rangeMatch[6]);
    if (v1 && v2) {
      minPrice = Math.min(v1, v2);
      maxPrice = Math.max(v1, v2);
      return { minPrice, maxPrice };
    }
  }

  // directional single
  const dirMatch = textLower.match(singleRegex);
  if (dirMatch) {
    const dir = dirMatch[1];
    const val = unitFactor(dirMatch[2].replace(/[.,]/g,''), dirMatch[4]);
    if (val) {
      if (!dir || dir === '~') {
        // around number => +/- 15%
        minPrice = Math.round(val * 0.85);
        maxPrice = Math.round(val * 1.15);
      } else if (['dưới','<','<='].includes(dir)) {
        maxPrice = val;
      } else if (['trên','từ','>','>='].includes(dir)) {
        minPrice = val;
      }
    }
  }
  return { minPrice, maxPrice };
}

function extractSize(textLower) {
  const m = textLower.match(/\b(2xl|3xl|xxl|xl|xs|s|m|l)\b/);
  return m ? m[1].toUpperCase() : null;
}

async function semanticCategoryBrand(textLower) {
  const { categories, brands } = await loadMeta();
  let foundCategory = null;
  categories.forEach(c => {
    const nameLower = c.name.toLowerCase();
    if (!foundCategory && (textLower.includes(nameLower) || textLower.includes(c.slug))) {
      foundCategory = c.slug;
    }
  });
  let foundBrand = null;
  brands.forEach(b => {
    if (!foundBrand && b && textLower.includes(b.toLowerCase())) {
      foundBrand = b;
    }
  });
  return { categorySlug: foundCategory, brand: foundBrand };
}

// ---------- Gemini parse ----------
async function callGeminiForFilters(userMessage) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const systemInstruction = `
Bạn là parser. Chỉ trả JSON hợp lệ duy nhất theo schema:
{
 "intent": "search_products" | "greeting" | "other",
 "keywords": string[] | null,
 "categorySlug": string | null,
 "brand": string | null,
 "color": string | null,
 "size": string | null,
 "minPrice": number | null,
 "maxPrice": number | null,
 "sortBy": "price" | "relevance" | "discount" | null,
 "sortOrder": "asc" | "desc" | null
}
- Chuẩn hóa màu tiếng Việt không dấu phụ (ví dụ: đen, trắng, đỏ, xanh dương, xanh lá ...).
- Chuyển đơn vị giá: k/ngàn/nghìn *1000, triệu/tr *1_000_000.
- Nếu không chắc -> null.
`;
    const prompt = `Người dùng: "${userMessage}"\nJSON:`;
    const result = await model.generateContent([systemInstruction, prompt]);
    const raw = (result?.response?.text?.() || '').trim();
    if (CHAT_DEBUG) console.log("Gemini raw:", raw);
    const jsonMatch = raw.match(/\{[\s\S]*\}$/m);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    if (CHAT_DEBUG) console.warn("Gemini parse fail:", e.message);
    return null;
  }
}

// ---------- Fallback parse ----------
async function fallbackParse(userMessage) {
  const lower = userMessage.toLowerCase();
  const color = normalizeColor(lower);
  const { minPrice, maxPrice } = extractPrices(lower);
  const size = extractSize(lower);
  const { categorySlug, brand } = await semanticCategoryBrand(lower);
  const keywords = userMessage
    .split(/[\s,./]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 && !/^\d+$/.test(w));

  return {
    intent: 'search_products',
    keywords: keywords.length ? keywords : null,
    categorySlug: categorySlug || null,
    brand: brand || null,
    color,
    size,
    minPrice: minPrice || null,
    maxPrice: maxPrice || null,
    sortBy: null,
    sortOrder: null
  };
}

// ---------- Product query & ranking ----------
function computeVariantFinalPrice(sizeObj) {
  if (sizeObj.discountPrice !== undefined && sizeObj.discountPrice !== null && sizeObj.discountPrice > 0) {
    return sizeObj.discountPrice;
  }
  return sizeObj.price;
}

function scoreProduct(p, filters) {
  let score = 0;
  // Text relevance: each keyword in name +15, in shortDescription +6, brand +10
  if (filters.keywords) {
    const nameLower = (p.name || '').toLowerCase();
    const descLower = (p.shortDescription || '').toLowerCase();
    const brandLower = (p.brand || '').toLowerCase();
    filters.keywords.forEach(k => {
      const kw = k.toLowerCase();
      if (nameLower.includes(kw)) score += 15;
      if (descLower.includes(kw)) score += 6;
      if (brandLower.includes(kw)) score += 10;
    });
  }

  // Color exact variant match
  if (filters.color && p._matching.colorMatched) score += 25;
  // Size match
  if (filters.size && p._matching.sizeMatched) score += 20;
  // Discount boost
  if (p._matching.discountPercent >= 30) score += 12;
  else if (p._matching.discountPercent >= 15) score += 6;
  else if (p._matching.discountPercent >= 5) score += 2;

  // Price fit: closer to middle of range
  if (filters.minPrice || filters.maxPrice) {
    const min = filters.minPrice || p._matching.finalPrice;
    const max = filters.maxPrice || p._matching.finalPrice;
    const mid = (min + max) / 2;
    const diff = Math.abs(p._matching.finalPrice - mid);
    const span = (max - min) || mid || 1;
    const closeness = 1 - (diff / span);
    score += Math.max(0, closeness * 20); // up to +20
  }

  return score;
}

async function queryProducts(filters) {
  const {
    keywords,
    categorySlug,
    brand,
    color,
    size,
    minPrice,
    maxPrice,
    sortBy,
    sortOrder = 'desc'
  } = filters;

  const productFilter = { status: 'active' };
  if (categorySlug) {
    const cat = await Category.findOne({ slug: categorySlug });
    if (cat) productFilter.categoryId = cat._id;
  }
  if (brand) {
    productFilter.brand = new RegExp(`^${brand}$`, 'i');
  }
  if (keywords && keywords.length) {
    productFilter.$or = [
      { name: { $regex: keywords.join('|'), $options: 'i' } },
      { shortDescription: { $regex: keywords.join('|'), $options: 'i' } },
      { brand: { $regex: keywords.join('|'), $options: 'i' } },
      { tags: { $in: keywords.map(k => new RegExp(k, 'i')) } }
    ];
  }

  const products = await Product.find(productFilter)
    .populate('categoryId', 'name slug')
    .lean();

  if (!products.length) return [];

  // Preload variants for all products
  const productIds = products.map(p => p._id);
  const variants = await ProductVariant.find({ productId: { $in: productIds } }).lean();

  const variantsByProduct = variants.reduce((acc, v) => {
    (acc[v.productId] = acc[v.productId] || []).push(v);
    return acc;
  }, {});

  const enriched = [];

  for (const product of products) {
    const pv = (variantsByProduct[product._id] || []).filter(v =>
      Array.isArray(v.sizes) && v.sizes.some(s => (s.stock || 0) > 0)
    );
    if (!pv.length) continue;

    // Determine best variant based on requested color/size first else cheapest
    let candidateVariants = pv;

    let colorMatchedVariant = null;
    if (color) {
      // normalize compare (lower)
      colorMatchedVariant = candidateVariants.find(v =>
        (v.color || '').toLowerCase() === color.toLowerCase()
      );
      if (colorMatchedVariant) candidateVariants = [colorMatchedVariant];
    }

    let selectedVariant = null;
    let selectedSizeObj = null;
    let sizeMatched = false;

    // If size requested, try match inside candidate variants
    if (size) {
      for (const v of candidateVariants) {
        const wanted = (v.sizes || []).find(s => s.size?.toUpperCase() === size.toUpperCase() && s.stock > 0);
        if (wanted) {
          selectedVariant = v;
          selectedSizeObj = wanted;
          sizeMatched = true;
          break;
        }
      }
    }

    if (!selectedVariant) {
      // pick cheapest final price size among candidateVariants
      candidateVariants.forEach(v => {
        (v.sizes || []).forEach(s => {
          if ((s.stock || 0) <= 0) return;
            const finalPrice = computeVariantFinalPrice(s);
            if (!selectedVariant ||
                finalPrice < computeVariantFinalPrice(selectedSizeObj)) {
              selectedVariant = v;
              selectedSizeObj = s;
            }
        });
      });
    }

    if (!selectedVariant || !selectedSizeObj) continue;

    const finalPrice = computeVariantFinalPrice(selectedSizeObj);
    if (minPrice && finalPrice < minPrice) continue;
    if (maxPrice && finalPrice > maxPrice) continue;

    // discount percent
    const discountPercent = selectedSizeObj.discountPrice && selectedSizeObj.price
      ? Math.round((1 - selectedSizeObj.discountPrice / selectedSizeObj.price) * 100)
      : 0;

    const availableColors = [...new Set(pv.map(v => v.color).filter(Boolean))];
    const availableSizes = [...new Set(pv.flatMap(v => (v.sizes || []).map(s => s.size)).filter(Boolean))];

    enriched.push({
      _id: product._id,
      name: product.name,
      slug: product.slug,
      brand: product.brand,
      category: product.categoryId,
      variant: {
        variantId: selectedVariant._id,
        color: selectedVariant.color,
        colorCode: selectedVariant.colorCode,
        images: selectedVariant.images,
        chosenSize: {
          size: selectedSizeObj.size,
            price: selectedSizeObj.price,
          discountPrice: selectedSizeObj.discountPrice,
          finalPrice
        },
        sizes: (selectedVariant.sizes || [])
          .filter(s => (s.stock || 0) > 0)
          .map(s => ({
            size: s.size,
            stock: s.stock,
            price: s.price,
            discountPrice: s.discountPrice,
            finalPrice: computeVariantFinalPrice(s)
          }))
      },
      finalPrice,
      originalPrice: selectedSizeObj.price,
      discountPrice: selectedSizeObj.discountPrice,
      discountPercent,
      availableColors,
      availableSizes,
      _matching: {
        finalPrice,
        colorMatched: !!colorMatchedVariant,
        sizeMatched,
        discountPercent,
      }
    });
  }

  // Score & sort
  enriched.forEach(p => {
    p._score = scoreProduct(p, filters);
  });

  if (sortBy === 'price') {
    enriched.sort((a, b) =>
      sortOrder === 'asc'
        ? a.finalPrice - b.finalPrice
        : b.finalPrice - a.finalPrice
    );
  } else if (sortBy === 'discount') {
    enriched.sort((a, b) =>
      sortOrder === 'asc'
        ? a.discountPercent - b.discountPercent
        : b.discountPercent - a.discountPercent
    );
  } else {
    // relevance (default) => score desc then price asc
    enriched.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.finalPrice - b.finalPrice;
    });
  }

  return enriched.slice(0, 30).map(p => {
    // clean internal
    const { _matching, _score, ...rest } = p;
    return {
      ...rest,
      relevanceScore: _score,
      match: {
        colorMatched: _matching.colorMatched,
        sizeMatched: _matching.sizeMatched
      }
    };
  });
}

// ---------- Main handler ----------
exports.chatSearch = async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ message: "messages required" });
    }
    const userMessage = messages[messages.length - 1].content || '';
    if (!userMessage.trim()) {
      return res.status(400).json({ message: "empty user message" });
    }

    let aiParsed = await callGeminiForFilters(userMessage);
    if (!aiParsed) {
      aiParsed = await fallbackParse(userMessage);
    } else {
      // Bổ sung category/brand nếu AI bỏ sót
      const lower = userMessage.toLowerCase();
      const { categorySlug, brand } = await semanticCategoryBrand(lower);
      if (!aiParsed.categorySlug && categorySlug) aiParsed.categorySlug = categorySlug;
      if (!aiParsed.brand && brand) aiParsed.brand = brand;
      // Normalize color
      if (aiParsed.color) {
        const norm = normalizeColor(aiParsed.color.toLowerCase());
        aiParsed.color = norm || aiParsed.color;
      }
      // Extract prices if missing
      if (!aiParsed.minPrice && !aiParsed.maxPrice) {
        const { minPrice, maxPrice } = extractPrices(lower);
        if (minPrice) aiParsed.minPrice = minPrice;
        if (maxPrice) aiParsed.maxPrice = maxPrice;
      }
      if (aiParsed.size) aiParsed.size = aiParsed.size.toUpperCase();
    }

    const products = await queryProducts(aiParsed);

    let reply;
    if (!products.length) {
      reply = "Không tìm thấy sản phẩm phù hợp. Bạn có thể mô tả rõ hơn về loại, màu, size hoặc khoảng giá?";
    } else {
      const top = products.slice(0, 5).map(p => p.name).join(", ");
      reply = `Tìm thấy ${products.length} sản phẩm. Ví dụ: ${top}. Bạn muốn lọc thêm màu, size hay mức giá?`;
    }

    res.json({
      reply,
      filters: aiParsed,
      products,
      metrics: {
        returned: products.length
      }
    });
  } catch (err) {
    console.error("chatSearch error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};