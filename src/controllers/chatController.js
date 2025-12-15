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

const GENERIC_WORDS = new Set([
  "áo","ao","quần","quan","đồ","do","basic",
  "giày","giay","sandal","phụ","kien","thời","trang","thoi","trending","local","brand"

]);

// ---- Constants / helpers ----
const COLOR_ALIASES = {
  "black": ["đen", "black", "đen tuyền"],
  "white": ["trắng", "white"],
  "red": ["đỏ", "red"],
  "blue": ["xanh dương", "xanh lam", "blue"],
  "green": ["xanh lá", "green"],
  "yellow": ["vàng", "yellow", "gold"],
  "brown": ["nâu", "brown"],
  "gray": ["xám", "gray", "grey", "ghi", "silver"],
  "purple": ["tím", "purple", "violet"],
  "pink": ["hồng", "pink"],
  "orange": ["cam", "orange"],
  "navy" : ["xanh dương", "navy"] 
};

const STOPWORDS = new Set([
  "tìm","tim","sản","san","phẩm","pham","cần","can","mua","giúp","giup","cho","có","co",
  "màu","mau","cần","cần","tôi","toi","mình","minh","xin","vui","lòng","long","loại","loai",
  "cần","muốn","mua","giá","gia","cái","chiếc","hãng","hang","cái","mẫu","mau"
]);

function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeText(str) {
  return stripDiacritics(str).toLowerCase();
} 

// Cập nhật COLOR_ALIASES thành dạng gồm cả không dấu tự động
Object.keys(COLOR_ALIASES).forEach(base => {
  const arr = COLOR_ALIASES[base];
  const extra = new Set(arr.map(a => stripDiacritics(a)));
  extra.forEach(e => { if (!arr.includes(e)) arr.push(e); });
  // thêm base không dấu
  const baseNo = stripDiacritics(base);
  if (!arr.includes(baseNo)) arr.push(baseNo);
});

// Hàm màu mới: kiểm tra cả có dấu & không dấu
function normalizeColor(sentenceLower) {
  const sentenceNo = normalizeText(sentenceLower);
  for (const base in COLOR_ALIASES) {
    const aliases = COLOR_ALIASES[base];
    if (aliases.some(a => {
      const aLow = a.toLowerCase();
      return sentenceLower.includes(aLow) || sentenceNo.includes(normalizeText(aLow));
    })) {
      return base; // luôn trả về base có dấu chuẩn
    }
  }
  return null;
}

function normalizeSizeToken(tok) {
  if (!tok) return tok;
  const t = tok.toString().trim().toUpperCase();
  if (t === 'XXL') return '2XL';
  if (t === 'XLL') return 'XL';
  return t;
}

function extractSizes(textLower) {
  const matches = textLower.match(/\b(3xl|2xl|xxl|xl|xs|s|m|l)\b/gi);
  if (!matches) return null;
  const normalized = [...new Set(matches.map(m => normalizeSizeToken(m)))];
  return normalized.length === 1 ? normalized[0] : normalized;
}

function extractPrices(textLower) {

  const unitFactor = (n, u) => {
    let num = Number(n.replace(/[.,]/g, ""));
    if (isNaN(num)) return null;
    // If no explicit unit and small number (e.g. "300"), assume thousands (300 -> 300_000)
    if (!u) {
      if (num < 1000) return num * 1_000;
      return num;
    }
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
      // If user says e.g. "giá 300" interpret 300 as 300k (handled above) and
      // apply a default range: min = value, max = value * 1.3 (about +30%).
      // If user used directional words use them strictly.
      if (!dir || dir === "~") {
        minPrice = Math.round(val);
        maxPrice = Math.round(val * 1.3);
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
  const size = extractSizes(lower);
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

  function emptyResult() {
    return { total: 0, page, limit, products: [] };
  }

  // category
  if (categorySlug) {
    const cat = await Category.findOne({ slug: categorySlug }).lean();
    if (cat) productFilter.categoryId = cat._id;
  }

  // brand
  if (brand) productFilter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");

  // color pre-filter
  if (color) {
    const aliasList = COLOR_ALIASES[color] || [color];
    const colorRegex = new RegExp(`^(${aliasList.map(escapeRegex).join("|")})$`, "i");
    const variantColorDocs = await ProductVariant.find({ color: colorRegex }, "productId").lean();
    if (!variantColorDocs.length) return emptyResult();
    const productIds = [...new Set(variantColorDocs.map(v => v.productId))];
    productFilter._id = { $in: productIds };
  }

  // keywords: require each token to match somewhere (AND semantics)
  if (keywords && keywords.length) {
    productFilter.$and = keywords.map(k => {
      const r = new RegExp(escapeRegex(k), "i");
      return {
        $or: [
          { name: r },
          { shortDescription: r },
          { brand: r },
          { tags: { $in: [r] } }
        ]
      };
    });
  }

  let baseProducts = await Product.find(productFilter)
    .populate("categoryId", "name slug")
    .lean();

  // If strict filter yields nothing, try a looser fallback search (OR across keywords)
  if ((!baseProducts || !baseProducts.length) && keywords && keywords.length) {
    const orClauses = [];
    for (const k of keywords) {
      const r = new RegExp(escapeRegex(k), "i");
      orClauses.push({ name: r });
      orClauses.push({ shortDescription: r });
      orClauses.push({ brand: r });
      orClauses.push({ tags: { $in: [r] } });
    }
    const looserFilter = { status: "active", $or: orClauses };
    if (productFilter._id) looserFilter._id = productFilter._id; // preserve pre-filtered IDs (color filter)
    if (productFilter.categoryId) looserFilter.categoryId = productFilter.categoryId;
    if (productFilter.brand) looserFilter.brand = productFilter.brand;

    baseProducts = await Product.find(looserFilter)
      .populate("categoryId", "name slug")
      .limit(200)
      .lean();
  }

  if (!baseProducts || !baseProducts.length) return emptyResult();

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
      const requested = Array.isArray(size) ? size.map(s => normalizeSizeToken(s)) : [normalizeSizeToken(size)];
      for (const v of candidates) {
        const s = (v.sizes || []).find(sz =>
          sz.size && requested.includes(normalizeSizeToken(sz.size)) && sz.stock > 0
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
  

  // ---- DISTINCTIVE KEYWORD FILTER ----
  const importantKeywords = (filters.keywords || []).filter(k => !GENERIC_WORDS.has(normalizeText(k)));
  if (importantKeywords.length) {
    for (let i = enriched.length - 1; i >= 0; i--) {
      const p = enriched[i];
      const nameN = normalizeText(p.name || "");
      const descN = normalizeText(p.shortDescription || "");
      const brandN = normalizeText(p.brand || "");
      const tagsN = (p.tags || []).map(t => normalizeText(t||""));
      const allMatch = importantKeywords.every(mk => {
        const mkN = normalizeText(mk);
        return nameN.includes(mkN) || descN.includes(mkN) || brandN.includes(mkN) ||
               tagsN.some(t => t.includes(mkN));
      });
      if (!allMatch) enriched.splice(i,1);
    }
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

// OPTIONAL: suy luận category từ keyword nếu missing
async function inferCategoryFromKeywords(parsed) {
  if (parsed.categorySlug) return parsed;
  if (parsed.keywords?.some(k => k.toLowerCase().includes("polo"))) {
    parsed.categorySlug = "ao-polo-nam"; // đổi cho phù hợp DB thực tế
  }
  return parsed;
}

// Làm sạch keywords (dùng cho kết quả Gemini)
function cleanParsedKeywords(parsed) {
  if (!Array.isArray(parsed.keywords)) return;
  const color = parsed.color;
  let aliases = [];
  if (color && COLOR_ALIASES[color]) {
    aliases = COLOR_ALIASES[color].map(a => normalizeText(a));
  }
  const seen = new Set();
  parsed.keywords = parsed.keywords
    .map(k => k.trim())
    .filter(Boolean)
    .filter(k => {
      const norm = normalizeText(k);
      if (STOPWORDS.has(norm)) return false;
      if (GENERIC_WORDS.has(norm)) return false;
      if (color && aliases.includes(norm)) return false; // loại token màu
      if (norm.length < 3) return false;
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
  if (!parsed.keywords.length) parsed.keywords = null;
}


// Cache màu variant động
let _variantColorCache = { ts:0, colors:[] };
async function loadVariantColors() {
  const now = Date.now();
  if (now - _variantColorCache.ts < 5 * 60_000 && _variantColorCache.colors.length) return _variantColorCache.colors;
  const list = await ProductVariant.distinct("color");
  _variantColorCache = { ts: now, colors: (list||[]).filter(Boolean).map(c => c.toLowerCase()) };
  return _variantColorCache.colors;
}

// Dynamic detect nếu alias không ra
async function dynamicColorDetect(messageLower) {
  const colors = await loadVariantColors();
  const noDiac = normalizeText(messageLower);
  // ưu tiên token sau từ "màu"
  const afterColor = messageLower.split(/\bmàu\b/i)[1];
  if (afterColor) {
    const token = afterColor.trim().split(/\s+/)[0]?.toLowerCase();
    if (token && colors.includes(token)) return token;
  }
  // fallback: tìm bất kỳ màu trong câu
  for (const c of colors) {
    if (messageLower.includes(c) || noDiac.includes(normalizeText(c))) return c;
  }
  return null;
}

// Merge filters từ context với parsed mới
function mergeFilters(prev, next) {
  if (!prev) return next;
  const merged = { ...prev };

  // Keywords: nếu next có keywords khác null & length >0 -> union (loại trùng)
  if (next.keywords && next.keywords.length) {
    const set = new Set([...(prev.keywords||[]), ...next.keywords]);
    merged.keywords = [...set];
  }
  // Nếu next không có keywords nhưng prev có -> giữ lại
  if (!next.keywords && prev.keywords) merged.keywords = prev.keywords;

  // Category: giữ cũ nếu next không cung cấp
  if (next.categorySlug) merged.categorySlug = next.categorySlug;

  // Brand
  if (next.brand) merged.brand = next.brand;

  // Color: thay thế nếu next.color có
  if (next.color) merged.color = next.color;

  // Size
  if (next.size) merged.size = next.size;

  // Giá mới override từng phần
  if (next.minPrice != null) merged.minPrice = next.minPrice;
  if (next.maxPrice != null) merged.maxPrice = next.maxPrice;

  // Sort
  if (next.sortBy) merged.sortBy = next.sortBy;
  if (next.sortOrder) merged.sortOrder = next.sortOrder;

  // Intent giữ là search_products
  merged.intent = "search_products";

  return merged;
}

// Điều chỉnh cleanParsedKeywords để dùng lại bên merge
function cleanParsedKeywordsInPlace(parsed) {
  if (!Array.isArray(parsed.keywords)) return;
  const color = parsed.color;
  let aliases = [];
  if (color && COLOR_ALIASES[color]) {
    aliases = COLOR_ALIASES[color].map(a => normalizeText(a));
  }
  const seen = new Set();
  parsed.keywords = parsed.keywords
    .map(k => k.trim())
    .filter(Boolean)
    .filter(k => {
      const norm = normalizeText(k);
      if (STOPWORDS.has(norm)) return false;
      if (GENERIC_WORDS.has(norm)) return false;
      if (color && aliases.includes(norm)) return false;
      if (norm.length < 3) return false;
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
  if (!parsed.keywords.length) parsed.keywords = null;
}

// ---- Main handler (thay phần exports.chatSearch hiện tại) ----
exports.chatSearch = async (req, res) => {
  try {
    const { messages, page, limit, sortBy, sortOrder, contextFilters } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ message: "messages required" });
    }
    const userMessage = messages[messages.length - 1].content || "";
    if (!userMessage.trim()) {
      return res.status(400).json({ message: "empty user message" });
    }

    // Parse câu mới
    let parsed = await callGeminiForFilters(userMessage);
    if (!parsed) parsed = await fallbackParse(userMessage);

    const lower = userMessage.toLowerCase();
    const { categorySlug, brand } = await semanticCategoryBrand(lower);
    if (!parsed.categorySlug && categorySlug) parsed.categorySlug = categorySlug;
    if (!parsed.brand && brand) parsed.brand = brand;

    // Màu (alias)
    if (parsed.color) {
      const norm = normalizeColor(parsed.color.toLowerCase());
      if (norm) parsed.color = norm;
    } else {
      let autoColor = normalizeColor(lower);
      if (!autoColor) {
        // dynamic color (navy ...)
        const dyn = await dynamicColorDetect(lower);
        if (dyn) autoColor = dyn;
      }
      if (autoColor) parsed.color = autoColor;
    }

    // Dọn keywords trước khi merge
    cleanParsedKeywordsInPlace(parsed);

    // Merge với contextFilters nếu có
    let merged = mergeFilters(contextFilters, parsed);

    // Sau merge nếu chưa có min/max thì thử trích từ câu mới
    if (!merged.minPrice && !merged.maxPrice) {
      const { minPrice, maxPrice } = extractPrices(lower);
      if (minPrice) merged.minPrice = minPrice;
      if (maxPrice) merged.maxPrice = maxPrice;
    }

    if (merged.size) {
      if (Array.isArray(merged.size)) merged.size = merged.size.map(s => normalizeSizeToken(s));
      else merged.size = normalizeSizeToken(merged.size);
    }
    if (sortBy) merged.sortBy = sortBy;
    if (sortOrder) merged.sortOrder = sortOrder;

    await inferCategoryFromKeywords(merged);

    if (CHAT_DEBUG) console.log('[CHAT_DEBUG] merged filters =>', merged);

    const result = await queryProducts(merged, {
      page: Math.max(1, Number(page) || 1),
      limit: Math.min(100, Math.max(1, Number(limit) || 30))
    });

    let reply;
    if (!result.products.length) {
      reply = "Không tìm thấy sản phẩm. Thử đổi màu / khoảng giá khác?";
    } else {
      const sample = result.products.slice(0, 5).map(p => p.name).join(", ");
      reply = `Có ${result.total} sản phẩm. Ví dụ: ${sample}. Muốn lọc thêm?`;
    }

    res.json({
      reply,
      filters: merged,         
      products: result.products,
      metrics: { total: result.total, page: result.page, limit: result.limit },
      debug: CHAT_DEBUG ? { lastMessage: userMessage } : undefined
    });
  } catch (err) {
    console.error("chatSearch error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};