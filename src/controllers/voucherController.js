const Voucher = require('../models/Voucher');
const Product = require('../models/Product');


exports.getAllVouchers = async (req, res) => {
  try {
    const { active, q } = req.query;
    const filter = {};
    if (typeof active !== 'undefined') filter.active = active === 'true';
    if (q) filter.code = { $regex: q.trim(), $options: 'i' };

    const vouchers = await Voucher.find(filter).sort({ createdAt: -1 }).lean();
    return res.json(vouchers);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.createVoucher = async (req, res) => {
  try {
    const data = req.body;
    const voucher = await Voucher.create({ ...data, createdBy: req.user.id });
    return res.status(201).json(voucher);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.deleteVoucher = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Voucher.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: 'Không tìm thấy voucher' });
    return res.json({ message: 'Đã xóa voucher', id: deleted._id });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
exports.updateVoucher = async (req, res) => {
  try {
    const { id } = req.params;
    const data = { ...req.body };
    if (data.code) data.code = data.code.toString().trim().toUpperCase();

    const updated = await Voucher.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ message: 'Không tìm thấy voucher' });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.applyVoucher = async (req, res, next) => {
  try {
    const raw = req.body?.code;
    const code = String(
      (typeof raw === 'object' && raw !== null)
        ? (raw.code ?? raw.value ?? '')
        : (raw ?? '')
    ).trim().toUpperCase();

    // debug log (tắt hoặc remove khi fixed)
    console.log('applyVoucher incoming raw:', raw, 'normalized code:', code, 'type raw:', typeof raw);

    if (!code) return res.status(400).json({ success: false, message: 'Mã voucher bắt buộc' });

    // tiếp tục xử lý với `code` an toàn
    const voucher = await Voucher.findOne({ code, active: true });
    if (!voucher) return res.status(404).json({ success: false, message: 'Mã không tồn tại' });

    const orderTotal = Number(req.body.orderTotal || 0);
    if (voucher.minAmount && orderTotal < voucher.minAmount) {
      return res.status(400).json({ success: false, message: `Yêu cầu tối thiểu ${voucher.minAmount}` });
    }
    if (voucher.expiresAt && new Date() > new Date(voucher.expiresAt)) {
      return res.status(400).json({ success: false, message: 'Mã đã hết hạn' });
    }

    let discount = 0;
    if (voucher.type === 'percent') discount = Math.floor((orderTotal * (voucher.value || 0)) / 100);
    else discount = voucher.value || 0;

    const totalAfter = Math.max(0, orderTotal - discount);

    return res.json({
      success: true,
      data: {
        voucher: {
          id: voucher._id,
          code: voucher.code,
          title: voucher.title || voucher.code,
          type: voucher.type,
          value: voucher.value,
          maxDiscount: voucher.maxDiscount || null,
          minAmount: voucher.minAmount || 0,
          expiresAt: voucher.expiresAt || null
        },
        discount,
        totalBefore: orderTotal,
        totalAfter
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.getUserVouchers = async (req, res) => {
  try {
    const userId = req.user?.id;
    const now = new Date();

    const vouchers = await Voucher.find({
      active: true,
      startAt: { $lte: now },
      endAt: { $gte: now }
    }).lean();

    const result = vouchers.map(v => {
      const usedRecord = (v.usersUsed || []).find(u => u.user?.toString() === (userId || '').toString());
      const perUserUsed = usedRecord ? usedRecord.count : 0;
      const exhausted = v.usageLimit !== null && (v.usedCount || 0) >= v.usageLimit;
      const perUserExceeded = v.perUserLimit !== null && perUserUsed >= v.perUserLimit;

      return {
        _id: v._id,
        code: v.code,
        type: v.type,
        value: v.value,
        maxDiscount: v.maxDiscount,
        startAt: v.startAt,
        endAt: v.endAt,
        minOrderValue: v.minOrderValue,
        applicableProducts: v.applicableProducts || [],
        applicableCategories: v.applicableCategories || [],
        usageLimit: v.usageLimit,
        usedCount: v.usedCount || 0,
        perUserLimit: v.perUserLimit,
        perUserUsed,
        exhausted,
        perUserExceeded,
        usable: !exhausted && !perUserExceeded
      };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.redeemVoucher = async (req, res) => {
  try {
    const rawCode = req.body.code;
    const code = String(rawCode || '').trim().toUpperCase();
    const userId = req.user?.id;
    if (!code) return res.status(400).json({ message: 'code required' });

    const voucher = await Voucher.findOne({ code, active: true });
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