const OrderCounter = require('../models/OrderCounter');

async function generateOrderCode() {
  try {
    // date parts for display
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);

    // key for storage in DB: YYYYMMDD
    const dateKey = `${now.getFullYear()}${mm}${dd}`;

    // Use Mongoose model findOneAndUpdate with { new: true, upsert: true }
    // This returns the updated document; seq increments atomically in the database.
    const updated = await OrderCounter.findOneAndUpdate(
      { date: dateKey },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();

    const seq = (updated && updated.seq) ? updated.seq : 1;
    const seqStr = String(seq).padStart(2, '0');

    // Use hyphens instead of slashes to avoid unsafe characters for payment gateways
    return `ORD-${dd}-${mm}-${yy}-${seqStr}`;
  } catch (err) {
    // fallback: deterministic-ish code using timestamp
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const rand = Math.floor(Math.random() * 90) + 10;
    return `ORD-${dd}/${mm}/${yy}-${rand}`;
  }
}

module.exports = {
  generateOrderCode
};