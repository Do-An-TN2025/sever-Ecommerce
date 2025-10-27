// ...new file...
const CFRecommendation = require("../models/CFRecommendation");
const Product = require("../models/Product");

async function getCfRecommendationsForUser(userId, limit = 12) {
  const User = require("../models/User");
  const user = await User.findById(userId).select("purchasedProducts wishlist viewedProducts").lean();
  let seeds = [];
  if (user?.purchasedProducts?.length) seeds = user.purchasedProducts.map(p => p.toString());
  else if (user?.wishlist?.length) seeds = user.wishlist.map(p => p.toString());
  else if (user?.viewedProducts?.length) seeds = user.viewedProducts.map(v => v.product && v.product.toString()).filter(Boolean);

  if (!seeds.length) {
    return Product.find().sort({ sold: -1 }).limit(limit).lean();
  }

  const docs = await CFRecommendation.find({ product: { $in: seeds } }).lean();
  const scoreMap = new Map();
  for (const d of docs) {
    for (const r of d.recommendations || []) {
      const pid = r.product.toString();
      if (seeds.includes(pid)) continue;
      scoreMap.set(pid, (scoreMap.get(pid) || 0) + r.score);
    }
  }
  const scored = Array.from(scoreMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0, limit).map(s=>s[0]);
  const prods = await Product.find({ _id: { $in: scored } }).lean();
  // preserve order
  const mapP = new Map(prods.map(p => [p._id.toString(), p]));
  return scored.map(id => mapP.get(id)).filter(Boolean);
}

module.exports = { getCfRecommendationsForUser };