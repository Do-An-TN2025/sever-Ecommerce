const Product = require("../models/Product");
const Category = require("../models/Category");
const ProductVariant = require("../models/ProductVariant");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest";
const CHAT_DEBUG = process.env.CHAT_DEBUG === "1";

let genAI = null;
if (API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(API_KEY);
  } catch (e) {
    console.warn("Init Gemini failed:", e.message);
  }
}

// ---- Meta cache (category + brand) ----
const META_TTL = 60_000;
let _metaCache = { ts: 0, categories: [], brands: [] };
async function loadMeta() {
  const now = Date.now();
  if (now - _metaCache.ts < META_TTL) return _metaCache;
  const categories = await Category.find({}, "slug name").lean();
  const brands = (await Product.distinct("brand")).filter(Boolean);
  _metaCache = { ts: now, categories, brands };
  return _metaCache;
}

// ---- Constants / helpers ----
const COLOR_ALIASES = {
  "đen": ["đen", "black", "đen tuyền"],
  "trắng": ["trắng", "white"],
  "đỏ": ["đỏ", "red"],
  "xanh dương": ["xanh dương", "xanh lam", "blue"],
  "xanh lá": ["xanh lá", "green"],
  "vàng": ["vàng", "yellow", "gold"],
  "nâu": ["nâu", "brown"],
  "xám": ["xám", "gray", "grey", "ghi", "silver"],
  "tím": ["tím", "purple", "violet"],
  "hồng": ["hồng", "pink"],
  "cam": ["cam", "orange"]
};

const STOPWORDS = new Set([
  "tìm","tim","sản","san","phẩm","pham","cần","can","mua","giúp","giup","cho","có","co",
  "màu","mau","cần","cần","tôi","toi","mình","minh","xin","vui","lòng","long","loại","loai",
  "cần","muốn","mua","giá","gia","cái","chiếc","hãng","hang","cái","mẫu","mau"
]);

function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeColor(sentenceLower) {
  for (const base in COLOR_ALIASES) {
    if (COLOR_ALIASES[base].some(a => sentenceLower.includes(a))) return base;
  }
  return null;
}

function extractSize(textLower) {
  const m = textLower.match(/\b(3xl|2xl|xxl|xl|xs|s|m|l)\b/);
  return m ? m[1].toUpperCase() : null;
}

function extractPrices(textLower) {
  // hỗ trợ: dưới 300k, 200k-400k, từ 500 đến 1 triệu, ~300k, <=150k
  const unitFactor = (n, u) => {
    let num = Number(n.replace(/[.,]/g, ""));
    if (isNaN(num)) return null;
    if (!u) return num;
    u = u.trim();
    if (["k","ngàn","nghìn","k."].includes(u)) return num * 1_000;
    if (["tr","triệu"].includes(u)) return num * 1_000_000;
    if (["trăm"].includes(u)) return num * 100;
    return num;
  };
  let minPrice = null, maxPrice = null;
  const rangeR = /(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)\s*(?:-|đến|to|>|<|>=|<=|~)\s*(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)/;
  const singleR = /(dưới|trên|từ|>=|<=|>|<|~)?\s*(\d+(?:[.,]\d+)?)(\s?(k|ngàn|nghìn|tr|triệu|trăm)?)/;
  const rangeM = textLower.match(rangeR);
  if (rangeM) {
    const v1 = unitFactor(rangeM[1], rangeM[3]);
    const v2 = unitFactor(rangeM[4], rangeM[6]);
    if (v1 && v2) {
      minPrice = Math.min(v1, v2);
      maxPrice = Math.max(v1, v2);
      return { minPrice, maxPrice };
    }
  }
  const sM = textLower.match(singleR);
  if (sM) {
    const dir = sM[1];
    const val = unitFactor(sM[2], sM[4]);
    if (val) {
      if (!dir || dir === "~") {
        minPrice = Math.round(val * 0.85);
        maxPrice = Math.round(val * 1.15);
      } else if (["dưới","<","<="].includes(dir)) {
        maxPrice = val;
      } else if (["trên","từ",">",">="].includes(dir)) {
        minPrice = val;
      }
    }
  }
  return { minPrice, maxPrice };
}

async function semanticCategoryBrand(textLower) {
  const { categories, brands } = await loadMeta();
  let categorySlug = null;
  for (const c of categories) {
    const n = c.name.toLowerCase();
    if (textLower.includes(n) || textLower.includes(c.slug)) {
      categorySlug = c.slug; break;
    }
  }
  let brand = null;
  for (const b of brands) {
    if (textLower.includes(b.toLowerCase())) { brand = b; break; }
  }
  return { categorySlug, brand };
}

// ---- Gemini parsing ----
async function callGeminiForFilters(userMessage) {
  if (!genAI) return null;
  try {
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    const systemInstruction = `
Bạn là bộ phân tích. Chỉ trả JSON hợp lệ:
{
 "intent":"search_products"|"greeting"|"other",
 "keywords": string[]|null,
 "categorySlug": string|null,
 "brand": string|null,
 "color": string|null,
 "size": string|null,
 "minPrice": number|null,
 "maxPrice": number|null,
 "sortBy":"price"|"relevance"|"discount"|null,
 "sortOrder":"asc"|"desc"|null
}
Chuyển k/ngàn/nghìn= *1000, triệu/tr = *1_000_000. Màu tiếng Việt chuẩn (đen, trắng...). Không thêm giải thích.`;
    const prompt = `Người dùng: "${userMessage}"\nJSON:`;
    const r = await model.generateContent([systemInstruction, prompt]);
    const raw = (r?.response?.text?.() || "").trim();
    if (CHAT_DEBUG) console.log("Gemini raw:", raw);
    const match = raw.match(/\{[\s\S]*\}$/m);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    if (CHAT_DEBUG) console.warn("Gemini parse error:", e.message);
    return null;
  }
}

// ---- Fallback parse ----
async function fallbackParse(userMessage) {
  const lower = userMessage.toLowerCase();
  const color = normalizeColor(lower);
  const { minPrice, maxPrice } = extractPrices(lower);
  const size = extractSize(lower);
  const { categorySlug, brand } = await semanticCategoryBrand(lower);

  let tokens = userMessage.split(/[\s,./]+/).map(t => t.trim()).filter(Boolean);
  tokens = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()));
  if (color) {
    const aliasSet = new Set(COLOR_ALIASES[color]);
    tokens = tokens.filter(t => !aliasSet.has(t.toLowerCase()));
  }
  const keywords = tokens.filter(t => t.length > 2 && !/^\d+$/.test(t));

  return {
    intent: "search_products",
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

// ---- Pricing / scoring ----
function finalSizePrice(sizeObj) {
  if (sizeObj.discountPrice !== undefined && sizeObj.discountPrice !== null && sizeObj.discountPrice > 0) {
    return sizeObj.discountPrice;
  }
  return sizeObj.price;
}

function scoreProduct(p, filters) {
  let score = 0;
  const m = p._matching;
  // keyword score
  if (filters.keywords) {
    const nameL = (p.name || "").toLowerCase();
    const descL = (p.shortDescription || "").toLowerCase();
    const brandL = (p.brand || "").toLowerCase();
    filters.keywords.forEach(k => {
      const kw = k.toLowerCase();
      if (nameL.includes(kw)) score += 15;
      if (descL.includes(kw)) score += 6;
      if (brandL.includes(kw)) score += 10;
    });
  }
  if (filters.color && m.colorMatched) score += 25;
  if (filters.size && m.sizeMatched) score += 20;
  if (m.discountPercent >= 30) score += 12;
  else if (m.discountPercent >= 15) score += 6;
  else if (m.discountPercent >= 5) score += 2;

  if (filters.minPrice || filters.maxPrice) {
    const min = filters.minPrice || m.finalPrice;
    const max = filters.maxPrice || m.finalPrice;
    const mid = (min + max) / 2;
    const diff = Math.abs(m.finalPrice - mid);
    const span = (max - min) || mid || 1;
    const closeness = 1 - (diff / span);
    score += Math.max(0, closeness * 20);
  }
  return score;
}

// ---- Query products with variant filtering ----
async function queryProducts(filters, pagination) {
  const {
    keywords, categorySlug, brand,
    color, size, minPrice, maxPrice,
    sortBy, sortOrder = "desc"
  } = filters;

  const { page = 1, limit = 30 } = pagination;
  const productFilter = { status: "active" };

  // category
  if (categorySlug) {
    const cat = await Category.findOne({ slug: categorySlug }).lean();
    if (cat) productFilter.categoryId = cat._id;
  }

  // brand
  if (brand) productFilter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");

  // color pre-filter -> find productIds from variants
  if (color) {
    const aliasList = COLOR_ALIASES[color] || [color];
    const colorRegex = new RegExp(`^(${aliasList.map(escapeRegex).join("|")})$`, "i");
    const variantColorDocs = await ProductVariant.find({ color: colorRegex }, "productId").lean();
    if (!variantColorDocs.length) return [];
    const productIds = [...new Set(variantColorDocs.map(v => v.productId))];
    productFilter._id = { $in: productIds };
  }

  // keywords
  if (keywords && keywords.length) {
    const kwRegex = keywords.map(escapeRegex).join("|");
    productFilter.$or = [
      { name: { $regex: kwRegex, $options: "i" } },
      { shortDescription: { $regex: kwRegex, $options: "i" } },
      { brand: { $regex: kwRegex, $options: "i" } },
      { tags: { $in: keywords.map(k => new RegExp(escapeRegex(k), "i")) } }
    ];
  }

  // Fetch products
  const baseProducts = await Product.find(productFilter)
    .populate("categoryId", "name slug")
    .lean();

  if (!baseProducts.length) return [];

  // Load variants for all
  const idMap = baseProducts.map(p => p._id);
  const variants = await ProductVariant.find({ productId: { $in: idMap } }).lean();
  const variantsByProduct = variants.reduce((acc, v) => {
    (acc[v.productId] = acc[v.productId] || []).push(v);
    return acc;
  }, {});

  const enriched = [];

  for (const product of baseProducts) {
    const allVariants = (variantsByProduct[product._id] || []).filter(v =>
      Array.isArray(v.sizes) && v.sizes.some(s => (s.stock || 0) > 0)
    );
    if (!allVariants.length) continue;

    // Filter candidate variants by color alias
    let candidates = allVariants;
    let colorMatchedVariant = null;
    if (color) {
      const aliasList = COLOR_ALIASES[color] || [color];
      colorMatchedVariant = candidates.find(v =>
        aliasList.includes((v.color || "").toLowerCase())
      );
      if (colorMatchedVariant) candidates = [colorMatchedVariant];
    }

    // If size requested, try to match inside chosen color set
    let selectedVariant = null;
    let selectedSize = null;
    let sizeMatched = false;

    if (size) {
      for (const v of candidates) {
        const s = (v.sizes || []).find(sz =>
          sz.size && sz.size.toUpperCase() === size.toUpperCase() && sz.stock > 0
        );
        if (s) {
          selectedVariant = v;
          selectedSize = s;
          sizeMatched = true;
          break;
        }
      }
    }

    // If not size-matched, choose cheapest final price among candidates
    if (!selectedVariant) {
      candidates.forEach(v => {
        (v.sizes || []).forEach(s => {
          if ((s.stock || 0) <= 0) return;
          const fp = finalSizePrice(s);
          if (!selectedVariant || fp < finalSizePrice(selectedSize)) {
            selectedVariant = v;
            selectedSize = s;
          }
        });
      });
    }

    if (!selectedVariant || !selectedSize) continue;

    const fp = finalSizePrice(selectedSize);
    if (minPrice && fp < minPrice) continue;
    if (maxPrice && fp > maxPrice) continue;

    const discountPercent = (selectedSize.discountPrice && selectedSize.price)
      ? Math.round((1 - selectedSize.discountPrice / selectedSize.price) * 100)
      : 0;

    const availableColors = [...new Set(allVariants.map(v => v.color).filter(Boolean))];
    const availableSizes = [
      ...new Set(
        allVariants.flatMap(v => (v.sizes || []).map(s => s.size)).filter(Boolean)
      )
    ];

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
          size: selectedSize.size,
          price: selectedSize.price,
          discountPrice: selectedSize.discountPrice,
          finalPrice: fp
        },
        sizes: (selectedVariant.sizes || [])
          .filter(s => (s.stock || 0) > 0)
          .map(s => ({
            size: s.size,
            stock: s.stock,
            price: s.price,
            discountPrice: s.discountPrice,
            finalPrice: finalSizePrice(s)
          }))
      },
      finalPrice: fp,
      originalPrice: selectedSize.price,
      discountPrice: selectedSize.discountPrice,
      discountPercent,
      availableColors,
      availableSizes,
      _matching: {
        finalPrice: fp,
        colorMatched: !!colorMatchedVariant,
        sizeMatched,
        discountPercent
      }
    });
  }

  // Score + sort
  enriched.forEach(p => { p._score = scoreProduct(p, filters); });

  if (sortBy === "price") {
    enriched.sort((a, b) => sortOrder === "asc" ? a.finalPrice - b.finalPrice : b.finalPrice - a.finalPrice);
  } else if (sortBy === "discount") {
    enriched.sort((a, b) => sortOrder === "asc" ? a.discountPercent - b.discountPercent : b.discountPercent - a.discountPercent);
  } else { // relevance default
    enriched.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return a.finalPrice - b.finalPrice;
    });
  }

  // Pagination (after ranking)
  const start = (page - 1) * limit;
  const slice = enriched.slice(start, start + limit);

  return {
    total: enriched.length,
    page,
    limit,
    products: slice.map(p => {
      const { _matching, _score, ...rest } = p;
      return {
        ...rest,
        relevanceScore: _score,
        match: {
          colorMatched: _matching.colorMatched,
          sizeMatched: _matching.sizeMatched
        }
      };
    })
  };
}

// ---- Main handler ----
exports.chatSearch = async (req, res) => {
  try {
    const { messages, page, limit, sortBy, sortOrder } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ message: "messages required" });
    }
    const userMessage = messages[messages.length - 1].content || "";
    if (!userMessage.trim()) {
      return res.status(400).json({ message: "empty user message" });
    }

    let parsed = await callGeminiForFilters(userMessage);
    if (!parsed) parsed = await fallbackParse(userMessage);

    // bổ sung nếu thiếu
    const lower = userMessage.toLowerCase();
    const { categorySlug, brand } = await semanticCategoryBrand(lower);
    if (!parsed.categorySlug && categorySlug) parsed.categorySlug = categorySlug;
    if (!parsed.brand && brand) parsed.brand = brand;

    if (parsed.color) {
      const norm = normalizeColor(parsed.color.toLowerCase());
      if (norm) parsed.color = norm;
    } else {
      // detect color if AI missed
      const autoColor = normalizeColor(lower);
      if (autoColor) parsed.color = autoColor;
    }

    if (!parsed.minPrice && !parsed.maxPrice) {
      const { minPrice, maxPrice } = extractPrices(lower);
      if (minPrice) parsed.minPrice = minPrice;
      if (maxPrice) parsed.maxPrice = maxPrice;
    }

    if (parsed.size) parsed.size = parsed.size.toUpperCase();
    if (sortBy) parsed.sortBy = sortBy;
    if (sortOrder) parsed.sortOrder = sortOrder;

    const result = await queryProducts(parsed, {
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 30))
    });

    let reply;
    if (!result.products.length) {
      reply = "Không tìm thấy sản phẩm phù hợp. Bạn mô tả rõ hơn màu, loại, size hoặc giá?";
    } else {
      const sample = result.products.slice(0, 5).map(p => p.name).join(", ");
      reply = `Có ${result.total} sản phẩm. Ví dụ: ${sample}. Muốn lọc thêm?`;
    }

    res.json({
      reply,
      filters: parsed,
      products: result.products,
      metrics: {
        total: result.total,
        page: result.page,
        limit: result.limit
      },
      debug: CHAT_DEBUG ? { userMessage } : undefined
    });
  } catch (err) {
    console.error("chatSearch error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};