// ...existing code...
const Voucher = require('../models/Voucher');
const Product = require('../models/Product');

exports.createVoucher = async (req, res) => {
  try {
    const data = req.body;
    const voucher = await Voucher.create({ ...data, createdBy: req.user.id });
    return res.status(201).json(voucher);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.applyVoucher = async (req, res) => {
  try {
    const { code, cartItems = [], orderTotal = 0 } = req.body;
    const userId = req.user?.id;

    const voucher = await Voucher.findOne({ code: (code || '').toUpperCase(), active: true });
    if (!voucher) return res.status(404).json({ message: 'Voucher không tồn tại hoặc đã vô hiệu' });

    const now = new Date();
    if (now < voucher.startAt || now > voucher.endAt) return res.status(400).json({ message: 'Voucher không còn hiệu lực' });

    if (voucher.usageLimit !== null && voucher.usedCount >= voucher.usageLimit) {
      return res.status(400).json({ message: 'Voucher đã hết lượt sử dụng' });
    }

    // per user limit check
    const userRecord = voucher.usersUsed.find(u => u.user.toString() === (userId || '').toString());
    if (userRecord && voucher.perUserLimit !== null && userRecord.count >= voucher.perUserLimit) {
      return res.status(400).json({ message: 'Bạn đã sử dụng voucher này quá số lần cho phép' });
    }

    // check min order
    if (orderTotal < (voucher.minOrderValue || 0)) {
      return res.status(400).json({ message: `Đơn hàng phải tối thiểu ${voucher.minOrderValue}` });
    }

    // Optional: áp dụng theo sản phẩm/danh mục -> tính subTotal áp dụng
    let applicableAmount = orderTotal;
    if ((voucher.applicableProducts && voucher.applicableProducts.length) ||
        (voucher.applicableCategories && voucher.applicableCategories.length)) {
      // Tính tổng các item thỏa điều kiện (giả sử cartItems có product, quantity, price, category)
      applicableAmount = 0;
      for (const item of cartItems) {
        const prodId = item.product?.toString();
        const inProducts = voucher.applicableProducts?.some(p => p.toString() === prodId);
        const inCategories = voucher.applicableCategories?.some(c => c.toString() === (item.category || '').toString());
        if (inProducts || inCategories) {
          applicableAmount += item.price * (item.quantity || 1);
        }
      }
      if (applicableAmount === 0) return res.status(400).json({ message: 'Voucher không áp dụng cho sản phẩm trong giỏ' });
    }

    // Tính tiền giảm
    let discount = 0;
    if (voucher.type === 'percent') {
      discount = (applicableAmount * voucher.value) / 100;
      if (voucher.maxDiscount) discount = Math.min(discount, voucher.maxDiscount);
    } else {
      discount = Math.min(voucher.value, applicableAmount);
    }

    const newTotal = Math.max(0, orderTotal - discount);

    return res.json({
      code: voucher.code,
      discount,
      newTotal
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.redeemVoucher = async (req, res) => {
  try {
    const { code } = req.body;
    const userId = req.user.id;
    if (!code) return res.status(400).json({ message: 'code required' });

    const voucher = await Voucher.findOne({ code: code.toUpperCase(), active: true });
    if (!voucher) return res.status(404).json({ message: 'Voucher không tồn tại' });

    voucher.usedCount = (voucher.usedCount || 0) + 1;
    const userRecord = voucher.usersUsed.find(u => u.user.toString() === userId.toString());
    if (userRecord) userRecord.count += 1;
    else voucher.usersUsed.push({ user: userId, count: 1 });

    await voucher.save();
    return res.json({ message: 'Voucher đã được ghi nhận' });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};