
const Product = require("../models/Product");
const Category = require("../models/Category");
const ProductVariant = require("../models/ProductVariant");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

async function callGeminiForFilters(userMessage, contextProducts = []) {
  const model = genAI.getGenerativeModel({ model: MODEL });
  const systemInstruction = `
Bạn là trợ lý thương mại điện tử. Trả về JSON hợp lệ KHÔNG kèm giải thích.
Schema:
{
 "intent": "search_products" | "greeting" | "other",
 "keywords": string[] | null,
 "categorySlug": string | null,
 "brand": string | null,
 "color": string | null,
 "size": string | null,
 "minPrice": number | null,
 "maxPrice": number | null,
 "sortBy": "price" | "relevance" | "createdAt" | null,
 "sortOrder": "asc" | "desc" | null
}
Giá trị tiền ở VNĐ nếu người dùng nói "trăm", "ngàn", "k", "triệu" hãy quy đổi số.
Nếu không chắc để null.
`;
  const prompt = `
Người dùng: "${userMessage}"
Trả JSON:`;
  const result = await model.generateContent([systemInstruction, prompt]);
  const text = result.response.text().trim();
  try {
    const firstJson = text.match(/\{[\s\S]*\}/);
    return firstJson ? JSON.parse(firstJson[0]) : null;
  } catch {
    return null;
  }
}

function fallbackParse(message) {
  const lower = message.toLowerCase();
  const num = (v) => (isNaN(v) ? null : Number(v));
  const priceMatches = lower.match(/(\d+)(?:\s?-\s?|\s?đ? đến\s?|\s?to\s?)(\d+)/);
  let minPrice = null, maxPrice = null;
  if (priceMatches) {
    minPrice = num(priceMatches[1]);
    maxPrice = num(priceMatches[2]);
  } else {
    const single = lower.match(/(\d+)(k|000)?( ?(vnđ|đ))?/);
    if (single) {
      minPrice = num(single[1]) * (single[2] === 'k' ? 1000 : 1);
    }
  }
  const colorMap = ['đen','trắng','đỏ','xanh','vàng','nâu','xám','tím','hồng','cam'];
  const color = colorMap.find(c => lower.includes(c)) || null;
  const sizeMatch = lower.match(/\b(xs|s|m|l|xl|xxl|2xl|3xl)\b/);
  return {
    intent: 'search_products',
    keywords: message.split(/\s+/).filter(w => w.length > 2),
    categorySlug: null,
    brand: null,
    color,
    size: sizeMatch ? sizeMatch[1].toUpperCase() : null,
    minPrice,
    maxPrice,
    sortBy: null,
    sortOrder: null
  };
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
    sortBy = 'relevance',
    sortOrder = 'desc'
  } = filters;

  const productFilter = { status: 'active' };

  if (categorySlug) {
    const cat = await Category.findOne({ slug: categorySlug });
    if (cat) productFilter.categoryId = cat._id;
  }

  if (brand) {
    productFilter.brand = new RegExp(brand, 'i');
  }

  if (keywords && keywords.length) {
    productFilter.$or = [
      { name: { $regex: keywords.join('|'), $options: 'i' } },
      { shortDescription: { $regex: keywords.join('|'), $options: 'i' } },
      { brand: { $regex: keywords.join('|'), $options: 'i' } },
      { tags: { $in: keywords.map(k => new RegExp(k, 'i')) } }
    ];
  }

  let products = await Product.find(productFilter)
    .populate('categoryId', 'name slug');

  // Build enriched data similar to searchProducts
  const enriched = [];
  for (const product of products) {
    const variants = await ProductVariant.find({ productId: product._id });
    const validVariants = variants.filter(v => v.sizes.some(s => s.stock > 0));
    if (!validVariants.length) continue;

    let bestVariant = null;
    validVariants.forEach(v =>
      v.sizes.forEach(s => {
        const finalPrice = s.discountPrice && s.discountPrice > 0 ? s.discountPrice : s.price;
        if (!bestVariant || finalPrice < bestVariant.finalPrice) {
          bestVariant = {
            variantId: v._id,
            size: s.size,
            price: s.price,
            discountPrice: s.discountPrice,
            finalPrice
          };
        }
      })
    );

    const availableColors = [...new Set(validVariants.map(v => v.color))];
    const availableSizes = [...new Set(validVariants.flatMap(v => v.sizes.map(s => s.size)))];

    // Filter by color / size here
    if (color && !availableColors.includes(color)) continue;
    if (size && !availableSizes.includes(size.toUpperCase())) continue;

    // Price filter
    if (minPrice && bestVariant.finalPrice < minPrice) continue;
    if (maxPrice && bestVariant.finalPrice > maxPrice) continue;

    enriched.push({
      _id: product._id,
      name: product.name,
      slug: product.slug,
      brand: product.brand,
      category: product.categoryId,
      finalPrice: bestVariant.finalPrice,
      price: bestVariant.price,
      discountPrice: bestVariant.discountPrice,
      colors: availableColors,
      sizes: availableSizes,
      images: variants[0]?.images || [],
      variantId: bestVariant.variantId
    });
  }

  // Sorting
  if (sortBy === 'price') {
    enriched.sort((a, b) =>
      sortOrder === 'asc' ? a.finalPrice - b.finalPrice : b.finalPrice - a.finalPrice
    );
  } else if (sortBy === 'createdAt') {
    // Need original product order; already unsorted => skip or re-query with sort
  } else {
    // relevance: approximate by (keyword hits)
    if (keywords && keywords.length) {
      enriched.sort((a, b) => {
        const hitsA = keywords.reduce((acc, k) =>
          acc + (a.name.toLowerCase().includes(k.toLowerCase()) ? 1 : 0), 0);
        const hitsB = keywords.reduce((acc, k) =>
          acc + (b.name.toLowerCase().includes(k.toLowerCase()) ? 1 : 0), 0);
        return hitsB - hitsA;
      });
    }
  }

  return enriched.slice(0, 20);
}

exports.chatSearch = async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: "messages required" });
    }

    const userMessage = messages[messages.length - 1].content;

    // 1. AI parse
    let aiParsed = await callGeminiForFilters(userMessage);
    // 2. Fallback
    if (!aiParsed) aiParsed = fallbackParse(userMessage);

    // Normalize numeric price if user used shorthand (e.g. 300k)
    ['minPrice','maxPrice'].forEach(k => {
      if (aiParsed[k] && aiParsed[k] < 1000) {
        // assume millions not intended -> leave
      }
    });

    // 3. Query products
    const products = await queryProducts(aiParsed);

    // 4. Build assistant reply
    let reply;
    if (!products.length) {
      reply = "Không tìm thấy sản phẩm phù hợp. Bạn có thể mô tả rõ hơn về giá, màu hoặc loại sản phẩm?";
    } else {
      const topNames = products.slice(0, 5).map(p => p.name).join(", ");
      reply = `Có ${products.length} kết quả. Gợi ý: ${topNames}. Bạn muốn lọc thêm màu, size hay khoảng giá?`;
    }

    res.json({
      reply,
      filters: aiParsed,
      products,
      rawAIParse: aiParsed
    });
  } catch (err) {
    console.error("chatSearch error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};