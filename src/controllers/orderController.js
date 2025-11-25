const mongoose = require("mongoose");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Voucher = require("../models/Voucher");
const User = require("../models/User");
const OrderReport = require("../models/OrderReport");
const {
  hydrateItems,
  decreaseStock,
  restoreStock,
  createPayOSPayment
} = require("../services/orderService");
const { generateOrderCode } = require("../utils/orderUtils");
require('dotenv').config();
const { sendOrderCreatedEmail, sendOrderStatusUpdateEmail } = require("../services/emailService");
const { sendOrderZNSByStatus } = require("../utils/zaloZNSUtil");
const fs = require('fs');
const path = require('path');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = null; }


const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID;
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY;

// Helper: validate voucher and return snapshot { voucher, discount, snaps  hot }
async function prepareVoucherSnapshot(voucherCode, orderItems, subtotal, shippingFee, userId) {
  if (!voucherCode) return null;
  const code = (voucherCode || "").trim().toUpperCase();
  if (!code) return null;

  const voucher = await Voucher.findOne({ code, active: true });
  if (!voucher) throw new Error("Voucher không tồn tại hoặc không hợp lệ");

  const now = new Date();
  if (now < voucher.startAt || now > voucher.endAt) throw new Error("Voucher không còn hiệu lực");

  if (voucher.usageLimit !== null && voucher.usedCount >= voucher.usageLimit) {
    throw new Error("Voucher đã hết lượt sử dụng");
  }

  if (userId && voucher.perUserLimit !== null) {
    const rec = voucher.usersUsed?.find(u => u.user?.toString() === userId.toString());
    if (rec && rec.count >= voucher.perUserLimit) {
      throw new Error("Bạn đã sử dụng voucher này quá số lần cho phép");
    }
  }

  if (subtotal < (voucher.minOrderValue || 0)) {
    throw new Error(`Đơn hàng phải tối thiểu ${voucher.minOrderValue}`);
  }

  // compute applicable amount
  let applicableAmount = subtotal;
  if ((voucher.applicableProducts?.length || 0) > 0 || (voucher.applicableCategories?.length || 0) > 0) {
    applicableAmount = 0;
    for (const it of orderItems) {
      const prodId = it.productId?.toString();
      const inProducts = (voucher.applicableProducts || []).some(p => p.toString() === prodId);
      const inCategories = (voucher.applicableCategories || []).some(c => {
        // item may include category if hydrateItems provides it
        return it.category && c.toString() === it.category.toString();
      });
      if (inProducts || inCategories) {
        applicableAmount += (it.price || 0) * (it.quantity || 1);
      }
    }
    if (applicableAmount === 0) throw new Error("Voucher không áp dụng cho sản phẩm trong giỏ");
  }

  // calculate discount
  let discount = 0;
  if (voucher.type === "percent") {
    discount = (applicableAmount * voucher.value) / 100;
    if (voucher.maxDiscount) discount = Math.min(discount, voucher.maxDiscount);
  } else {
    discount = Math.min(voucher.value, applicableAmount);
  }

  discount = Math.round(discount || 0);
  const totalBefore = subtotal + (shippingFee || 0);
  const totalAfter = Math.max(0, totalBefore - discount);

  const snapshot = {
    voucherId: voucher._id,
    code: voucher.code,
    type: voucher.type,
    value: voucher.value,
    discountAmount: discount,
    totalBeforeVoucher: totalBefore,
    totalAfterVoucher: totalAfter,
    appliedItems: orderItems.map(it => ({
      productId: it.productId,
      quantity: it.quantity,
      lineTotal: (it.price || 0) * (it.quantity || 1)
    }))
  };

  return { voucher, discount, snapshot };
}
async function sendZNS(order, type) {
  try {
    const phone = String(
      order.shippingAddress?.phone || order.guestInfo?.phone || ""
    );

    if (!phone) {
      console.warn("Không có số điện thoại để gửi ZNS");
      return;
    }

    const statusTextMap = {
      confirmed: "Đã xác nhận",
      shipped: "Đang vận chuyển",
      delivered: "Đã giao hàng",
      cancelled: "Đã hủy",
    };

    // =============================
    // 1️⃣ TEMPLATE CHUNG CHO 4 TRẠNG THÁI
    // =============================
    if (["confirmed", "shipped", "delivered", "cancelled"].includes(type)) {
      console.log("Gửi ZNS đơn hàng với template chung, status=", type);
      return await sendOrderZNSByStatus({
        phone,
        status: type,
        templateData: {
          company_name: "SHOPNOW",
          customer_name: String(
            order.shippingAddress?.fullName ||
              order.guestInfo?.fullName ||
              "Quý khách"
          ),
          id: String(order.orderCode || ""),
          price: `${order.totalAmount || 0} VND`,
          address: String(
            order.shippingAddress?.addressLine1 ||
              order.shippingAddress?.addressLine2 ||
              ""
          ),
          mobile: phone,
          payment: order.paymentMethod?.status === "paid"
            ? "Đã thanh toán"
            : "Chưa thanh toán",

          // ⭐ Auto status theo param template Zalo
          status: statusTextMap[type],
        },

        trackingId: `order_${order._id}`,
      });
    }

    // =============================
    // 2️⃣ TEMPLATE RIÊNG CHO "completed"
    // =============================
    if (type === "completed") {
      return await sendOrderZNSByStatus({
        phone,
        status: "completed",
        templateData: {
          customer_name: String(
            order.shippingAddress?.fullName ||
              order.guestInfo?.fullName ||
              "Quý khách"
          ),
          date: new Date().toLocaleDateString("vi-VN"),
          order_id: String(order.orderCode || ""),

          // template khác → status riêng
          status: "Đơn hàng đã hoàn tất",
        },
        trackingId: `order_${order._id}`,
      });
    }

  } catch (err) {
    console.error(`ZNS send error [${type}]`, err);
  }
}
exports.createOrder = async (req, res) => {
  try {
    const {
      items,
      shippingAddress,
      paymentMethod,
      guestInfo = {},
      customerNote,
      returnUrl,
      cancelUrl,
      voucherCode
    } = req.body;

    if (!items?.length) return res.status(400).json({ message: "Giỏ hàng trống" });
    if (!shippingAddress?.fullName || !shippingAddress?.phone) {
      return res.status(400).json({ message: "Thiếu thông tin giao hàng" });
    }
    if (!shippingAddress?.email && !guestInfo?.email && !req.body.contactEmail) return res.status(400).json({ message: "Thiếu email liên hệ" });
    if (!paymentMethod?.type) {
      return res.status(400).json({ message: "Thiếu phương thức thanh toán" });
    }

    const orderItems = await hydrateItems(items);
    const subtotal = orderItems.reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 0), 0);
    const shippingFee = Number(req.body.shippingFee || 0);

    const userId = req.user?.id || req.user?._id || req.user?.userId || null;
    console.log("Auth header:", req.headers.authorization);
    console.log("req.user:", userId);

    // voucher handling
    let voucherSnapshot = null;
    let discount = 0;
    try {
      const prepared = await prepareVoucherSnapshot(voucherCode, orderItems, subtotal, shippingFee, userId);
      if (prepared) {
        voucherSnapshot = prepared.snapshot;
        discount = prepared.discount;
      }
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const totalAmount = Math.max(0, subtotal + shippingFee - discount);

    const baseOrder = {
      items: orderItems,
      shippingAddress: {
        fullName: shippingAddress.fullName,
        phone: shippingAddress.phone,
        email: guestInfo.email || req.body.contactEmail || shippingAddress.email || null,
        addressLine1: shippingAddress.addressLine || shippingAddress.addressLine1 || "",
        addressLine2: shippingAddress.addressLine2 || "",
        ward: shippingAddress.ward || "",
        district: shippingAddress.district || "",
        city: shippingAddress.city || "",
        postalCode: shippingAddress.postalCode || ""
      },
      paymentMethod: {
        type: paymentMethod.type,
        status: "pending",
        note: paymentMethod.note || ""
      },
      customerNote,
      orderStatus: "pending",
      subtotal,
      shippingFee,
      discount,
      totalAmount,
      voucher: voucherSnapshot || undefined
    };

    if (userId) baseOrder.userId = userId;
    else {
      const guestName = guestInfo.fullName || shippingAddress.fullName;
      const guestPhone = guestInfo.phone || shippingAddress.phone;
      if (!guestName || !guestPhone) {
        return res.status(400).json({ message: "Khách vãng lai cần cung cấp họ tên và số điện thoại" });
      }
      baseOrder.guestInfo = {
        fullName: guestName,
        phone: guestPhone,
       email: guestInfo.email || req.body.contactEmail || shippingAddress.email || null
      };
    }

    if (paymentMethod.type !== "PayOS") {
      baseOrder.orderCode = generateOrderCode();
      const order = await Order.create(baseOrder);
      if (userId) {
        await Cart.updateOne(
          { userId },
          {
            $pull: {
              items: { variantId: { $in: orderItems.map((i) => i.variantId) } },
            },
          }
        );
      }

      // Send confirmation email immediately for non-online payment
      try {
        const recipient = order.shippingAddress?.email || order.guestInfo?.email || null;
        if (recipient) sendOrderCreatedEmail(order, recipient).catch(err => console.warn("Send order email failed:", err));
      } catch (e) {
        console.warn("send order email error:", e);
      }

      return res.status(201).json({ order });
    }

    // PayOS flow
    if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY || !PAYOS_CHECKSUM_KEY) {
      return res.status(500).json({ message: "PayOS chưa được cấu hình" });
    }

    const orderCode = generateOrderCode();
    const successUrl = returnUrl || `${process.env.CLIENT_URL || "http://localhost:3000"}/payment/success`;
    const failUrl = cancelUrl || `${process.env.CLIENT_URL || "http://localhost:3000"}/payment/cancel`;

    const paymentBody = {
      orderCode,
      amount: totalAmount,
      description: `Order ${orderCode}`,
      returnUrl: successUrl,
      cancelUrl: failUrl,
      buyerName: shippingAddress.fullName,
      buyerEmail: baseOrder.guestInfo?.email || "customer@example.com",
      buyerPhone: shippingAddress.phone,
      buyerAddress: shippingAddress.addressLine1 || "",
      items: orderItems.map(item => ({ name: item.name, quantity: item.quantity, price: item.price })),
      expiredAt: Math.floor(Date.now() / 1000) + 900
    };

    let paymentData;
    try {
      paymentData = await createPayOSPayment(paymentBody);
    } catch (err) {
      console.error("PayOS create link error:", err?.response?.data || err.message);
      return res.status(502).json({ message: "Không tạo được liên kết thanh toán PayOS" });
    }

    baseOrder.orderCode = orderCode;
    baseOrder.paymentMethod.transactionId = paymentData.data?.orderCode || paymentData.data?.paymentLinkId || null;
    baseOrder.paymentMethod.invoiceUrl = paymentData.data?.checkoutUrl;
    baseOrder.paymentMethod.expiresAt = paymentData.data?.expiredAt ? new Date(paymentData.data.expiredAt * 1000) : null;

    const order = await Order.create(baseOrder);

    // DO NOT send email here for PayOS — wait for webhook confirmation
    // Optional: if you want client to force finalize immediately, use req.body.finalize as before
    const finalize = !!req.body.finalize;
    if (userId && finalize === true) {
      await Cart.updateOne(
        { userId },
        {
          $pull: {
            items: { variantId: { $in: orderItems.map((i) => i.variantId) } },
          },
        }
      );
    }

    return res.status(201).json({
      order,
      payment: {
        checkoutUrl: paymentData.data?.checkoutUrl,
        qrCode: paymentData.data?.qrCode || null
      }
    });
  } catch (error) {
    console.error("createOrder error:", error);
     res.status(500).json({ message: error.message, stack: error.stack });
  }
};

exports.handlePayOSWebhook = async (req, res) => {
  try {
    const payload = req.body;
    console.log("PayOS Webhook received:", payload);
    const orderCode = payload.orderCode || payload.data?.orderCode;
    const order = await Order.findOne({ orderCode });
    if (!order) {
      console.log("Order not found:", payload.orderCode);
      return res.status(200).json({ message: "Không tìm thấy đơn" });
    }

    if (order.paymentMethod.status === "paid" || order.paymentMethod.status === "cancelled") {
      console.log("Order already processed:", order._id);
      return res.json({ message: "Order already processed" });
    }

    if (payload.code === "00" || payload.status === "PAID") {
      // success
      order.paymentMethod.status = "paid";
      order.orderStatus = "confirmed";
      order.paymentMethod.paidAt = new Date();

      // decrease stock (existing logic)
      try {
        await decreaseStock(order.items);
      } catch (err) {
        console.error("decreaseStock error:", err);
        // proceed but log
      }

      // redeem voucher in transaction to avoid race
      if (order.voucher?.voucherId && !order.voucher?.redeemed) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          const v = await Voucher.findById(order.voucher.voucherId).session(session);
          if (v) {
            if (v.usageLimit !== null && v.usedCount >= v.usageLimit) {
              console.warn("Voucher already exhausted at redeem time:", v.code);
            } else {
              v.usedCount = (v.usedCount || 0) + 1;
              if (order.userId) {
                const rec = v.usersUsed.find(u => u.user?.toString() === order.userId.toString());
                if (rec) rec.count = (rec.count || 0) + 1;
                else v.usersUsed.push({ user: order.userId, count: 1 });
              }
              await v.save({ session });
              order.voucher.redeemed = true;
              order.voucher.redeemedAt = new Date();
              await order.save({ session });
            }
          } else {
            // voucher not found: still mark order saved below
            console.warn("Voucher referenced by order not found:", order.voucher.voucherId);
            await order.save(); // save status without voucher changes
          }
          await session.commitTransaction();
        } catch (err) {
          await session.abortTransaction();
          console.error("Voucher redeem transaction error:", err);
          // don't block payment success; leave order.voucher.redeemed false for manual reconciliation
          await order.save();
        } finally {
          session.endSession();
        }
      } else {
        await order.save();
      }

      console.log("✅ Payment successful for order:", order._id);
    } else if (payload.status === "CANCELLED") {
      // cancelled
      order.paymentMethod.status = "cancelled";
      order.orderStatus = "cancelled";
      order.paymentMethod.cancelledAt = new Date();

      if (order.userId) {
        const cartItems = order.items.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
          size: item.size,
          price: item.price
        }));
        await Cart.updateOne(
          { userId: order.userId },
          { $push: { items: { $each: cartItems } } },
          { upsert: true }
        );
      }

      await order.save();
      console.log("❌ Payment cancelled for order:", order._id);
    } else {
      // failed or other status
      order.paymentMethod.status = "failed";
      order.paymentMethod.failedAt = new Date();
      await order.save();
      console.log("⚠️ Payment failed for order:", order._id);
    }

    order.paymentMethod.transactionId = payload.transactionId || payload.paymentLinkId || order.paymentMethod.transactionId;
    await order.save();

    res.json({
      message: "Webhook handled successfully",
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentMethod.status
    });
  } catch (error) {
    console.error("handlePayOSWebhook error:", error);
    res.status(500).json({ message: "Webhook error" });
  }
};

exports.checkPaymentStatus = async (req, res) => {
  try {
    const { orderCode } = req.params;
    const order = await Order.findOne({ orderCode });
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng" });

    res.json({
      orderCode: order.orderCode,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentMethod.status,
      totalAmount: order.totalAmount,
      createdAt: order.createdAt,
      paidAt: order.paymentMethod.paidAt || null,
      cancelledAt: order.paymentMethod.cancelledAt || null
    });
  } catch (error) {
    console.error("checkPaymentStatus error:", error);
    res.status(500).json({ message: "Lỗi kiểm tra trạng thái" });
  }
};

exports.cancelOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const order = await Order.findOne({ _id: id, ...(userId && { userId }) });
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    if (order.orderStatus !== "pending") return res.status(400).json({ message: "Chỉ có thể hủy đơn hàng đang chờ xử lý" });
    if (order.paymentMethod.status === "paid") return res.status(400).json({ message: "Không thể hủy đơn hàng đã thanh toán" });

    order.orderStatus = "cancelled";
    order.paymentMethod.status = "cancelled";
    order.paymentMethod.cancelledAt = new Date();

    if (userId) {
      const cartItems = order.items.map(item => ({
        variantId: item.variantId,
        quantity: item.quantity,
        size: item.size,
        price: item.price
      }));
      await Cart.updateOne({ userId }, { $push: { items: { $each: cartItems } } }, { upsert: true });
    }

    await order.save();
    res.json({ message: "Đã hủy đơn hàng thành công", order });
  } catch (error) {
    console.error("cancelOrder error:", error);
    res.status(500).json({ message: "Lỗi hủy đơn hàng" });
  }
};

// User: request cancellation -> create a report and mark order as 'reported'
exports.requestOrderCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user?.id;

    if (!reason || !String(reason).trim()) return res.status(400).json({ message: 'Vui lòng cung cấp lý do hủy đơn' });

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });

    // Only the owner can request cancellation (if order has userId)
    if (order.userId && userId && order.userId.toString() !== userId.toString()) {
      return res.status(403).json({ message: 'Không có quyền trên đơn hàng này' });
    }

    // allow only pending or confirmed
    if (!['pending', 'confirmed'].includes(order.orderStatus)) {
      return res.status(400).json({ message: 'Chỉ có thể yêu cầu hủy đơn ở trạng thái pending hoặc confirmed' });
    }

    const report = await OrderReport.create({
      orderId: order._id,
      userId: order.userId || userId || undefined,
      reason: String(reason).trim(),
      previousStatus: order.orderStatus
    });

    order.orderStatus = 'reported';
    await order.save();

    return res.json({ message: 'Yêu cầu hủy đã được gửi lên hệ thống', report });
  } catch (err) {
    console.error('requestOrderCancellation error:', err);
    return res.status(500).json({ message: 'Lỗi khi gửi yêu cầu hủy' });
  }
};

// Admin: list reports (with pagination)
exports.getOrderReportsAdmin = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.orderId) filter.orderId = req.query.orderId;

    const total = await OrderReport.countDocuments(filter);
    const reports = await OrderReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('orderId')
      .populate('userId', 'firstName lastName email phone')
      .lean();

    return res.json({ meta: { total, page, limit, pages: Math.ceil(total / limit) }, data: reports });
  } catch (err) {
    console.error('getOrderReportsAdmin error:', err);
    return res.status(500).json({ message: 'Lỗi khi lấy danh sách báo cáo' });
  }
};

// Admin: approve a report -> actually cancel the order
exports.approveOrderReport = async (req, res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });

    const { id } = req.params; // report id
    const adminId = req.user?.id;

    const report = await OrderReport.findById(id);
    if (!report) return res.status(404).json({ message: 'Không tìm thấy báo cáo' });
    if (report.status !== 'pending') return res.status(400).json({ message: 'Báo cáo đã được xử lý' });

    const order = await Order.findById(report.orderId);
    if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng liên quan' });

    // Only proceed if order is in reported state (safety check)
    if (order.orderStatus !== 'reported') {
      // still allow admin to cancel, but warn
      console.warn('approveOrderReport: order not in reported state, proceeding to cancel anyway', order._id.toString());
    }

    // mark cancelled
    order.orderStatus = 'cancelled';
    if (!order.paymentMethod) order.paymentMethod = {};
    order.paymentMethod.status = 'cancelled';
    order.paymentMethod.cancelledAt = order.paymentMethod.cancelledAt || new Date();

    // restore stock
    try {
      await restoreStock(order.items);
    } catch (err) {
      console.error('restoreStock error (approve report):', err);
    }

    // return items to user's cart
    if (order.userId) {
      const cartItems = order.items.map(item => ({
        variantId: item.variantId,
        productId: item.productId,
        quantity: item.quantity,
        size: item.size,
        price: item.price,
        discountPrice: item.discountPrice || item.price || 0,
        finalPrice: item.finalPrice || item.price || 0,
        name: item.name || ''
      }));
      try {
        await Cart.updateOne({ userId: order.userId }, { $push: { items: { $each: cartItems } } }, { upsert: true });
      } catch (err) {
        console.error('push back to cart error (approve report):', err);
      }
    }

    await order.save();

    report.status = 'approved';
    report.processedBy = adminId;
    report.processedAt = new Date();
    await report.save();

    return res.json({ message: 'Báo cáo đã được duyệt và đơn hàng đã hủy', report, order });
  } catch (err) {
    console.error('approveOrderReport error:', err);
    return res.status(500).json({ message: 'Lỗi khi xử lý báo cáo' });
  }
};

exports.getMyOrders = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10);
    const status = req.query.status; // optional: filter by orderStatus
    const sortBy = req.query.sortBy || "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const filter = { userId };
    if (status) filter.orderStatus = status;

    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("items.productId", "name slug")
      .populate("items.variantId", "color colorCode sizes images")
      .lean();

    res.json({
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit)
      },
      data: orders
    });
  } catch (error) {
    console.error("getMyOrders error:", error);
    res.status(500).json({ message: "Không lấy được danh sách đơn hàng" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    res.json(order);
  } catch (error) {
    console.error("getOrderById error:", error);
    res.status(500).json({ message: "Không lấy được đơn hàng" });
  }
};

exports.getOrderByCode = async (req, res) => {
  try {
    const { orderCode } = req.params;
    
    const order = await Order.findOne({ orderCode })
      .populate("items.productId", "name slug")
      .populate("items.variantId", "color colorCode sizes images sku")
      .populate("userId", "firstName lastName email phone avatar")
      .lean();

    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    res.json(order);
  } catch (error) {
    console.error("getOrderByCode error:", error);
    res.status(500).json({ message: "Lỗi lấy thông tin đơn hàng" });
  }
};

// Single API: accepts either query `id` (order _id) or `orderCode` — renders HTML template with Puppeteer
function fmtVND(value) {
  try { return new Intl.NumberFormat('vi-VN').format(value) + ' ₫'; } catch (e) { return String(value || 0) + ' ₫'; }
}

async function renderInvoicePdfFromTemplate(order) {
  if (!puppeteer) throw new Error('puppeteer not installed');

  // Read template - prefer repository-level `templates/`, fall back to `src/templates/`
  let tplPath = path.join(process.cwd(), 'templates', 'invoice.html');
  if (!fs.existsSync(tplPath)) {
    // fallback for older layout where templates live under src/
    const alt = path.join(__dirname, '..', 'templates', 'invoice.html');
    if (fs.existsSync(alt)) tplPath = alt;
  }

  if (!fs.existsSync(tplPath)) {
    throw new Error(`Invoice template not found. Looked for: ${path.join(process.cwd(), 'templates', 'invoice.html')} and ${path.join(__dirname, '..', 'templates', 'invoice.html')}`);
  }

  const tpl = fs.readFileSync(tplPath, 'utf8');

  // Company placeholders
  const company_name = process.env.COMPANY_NAME || 'SHOPNOW';
  const company_address = process.env.COMPANY_ADDRESS || '';
  const company_phone = process.env.COMPANY_PHONE || '';
  const company_email = process.env.COMPANY_EMAIL || '';
  const tax_id = process.env.TAX_ID || 'Chưa có mã số thuế';
  const logoUrl = process.env.COMPANY_LOGO_URL || '';
  const logoHtml = logoUrl ? `<img src="${logoUrl}" alt="logo" style="max-height:60px"/>` : '';
  // Signature support: seller signature from env, recipient signature from order if available
  const sellerSignatureUrl = process.env.COMPANY_SIGNATURE_URL || '';
  const sellerSignatureHtml = sellerSignatureUrl ? `<img src="${sellerSignatureUrl}" class="signature-img" alt="signature"/>` : `<div style="margin-top:60px">(Ký, ghi rõ họ tên)</div>`;
  const recipientSignatureImg = order.recipientSignature || order.signatureImage || (order.signatures && order.signatures.recipient) || '';
  const recipientSignatureHtml = recipientSignatureImg ? `<img src="${recipientSignatureImg}" class="signature-img" alt="recipient-signature"/>` : `<div style="margin-top:60px">(Ký, ghi rõ họ tên)</div>`;

  // Items rows
  const items = order.items || [];
  const itemsRows = items.map(it => {
    const name = it.name || (it.productId && it.productId.name) || '';
    const qty = it.quantity || 0;
    const price = fmtVND(it.price || 0);
    const total = fmtVND((it.price || 0) * qty);
    // image fallback: item.image, item.images[0], product.images[0], variant images
    const img = (it.image || (it.images && it.images[0]) || (it.productId && it.productId.images && it.productId.images[0]) || (it.variantId && it.variantId.images && it.variantId.images[0]) || '');
    const imgTag = img ? `<img class="product-thumb" src="${img}" alt="" />` : '';
    const meta = [];
    if (it.sku) meta.push(it.sku);
    if (it.size) meta.push('Size: ' + it.size); 
    const metaHtml = meta.length ? `<div class="product-meta">${meta.join(' • ')}</div>` : '';
    // product cell now includes image + name/meta in one column for cleaner layout
    const productCell = `<td><div class="product-item">${imgTag}<div><div class="product-name">${name}</div>${metaHtml}</div></div></td>`;
    return `<tr>${productCell}<td class="text-right">${qty}</td><td class="text-right">${price}</td><td class="text-right">${total}</td></tr>`;
  }).join('');

  const html = tpl
    .replace(/{{company_logo}}/g, logoHtml)
    .replace(/{{company_name}}/g, company_name)
    .replace(/{{company_address}}/g, company_address)
    .replace(/{{company_phone}}/g, company_phone)
    .replace(/{{company_email}}/g, company_email)
    .replace(/{{tax_id}}/g, tax_id)
    .replace(/{{ship_fullName}}/g, (order.shippingAddress?.fullName || order.guestInfo?.fullName || ''))
    .replace(/{{ship_address}}/g, (order.shippingAddress?.addressLine1 || '') + ' ' + (order.shippingAddress?.addressLine2 || ''))
    .replace(/{{ship_phone}}/g, (order.shippingAddress?.phone || order.guestInfo?.phone || ''))
    .replace(/{{ship_email}}/g, (order.shippingAddress?.email || order.guestInfo?.email || ''))
    .replace(/{{order_code}}/g, order.orderCode || '')
    .replace(/{{order_date}}/g, new Date(order.createdAt || Date.now()).toLocaleString('vi-VN'))
    .replace(/{{order_status}}/g, order.orderStatus || '')
    .replace(/{{items_rows}}/g, itemsRows)
    .replace(/{{seller_signature}}/g, sellerSignatureHtml)
    .replace(/{{recipient_signature}}/g, recipientSignatureHtml)
    .replace(/{{subtotal}}/g, fmtVND(order.subtotal || 0))
    .replace(/{{shippingFee}}/g, fmtVND(order.shippingFee || 0))
    .replace(/{{discount}}/g, fmtVND(order.discount || 0))
    .replace(/{{totalAmount}}/g, fmtVND(order.totalAmount || 0))
    .replace(/{{company_name}}/g, company_name);

  // Launch puppeteer and render
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });

  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } });

  await browser.close();
  return pdfBuffer;
}

exports.getOrderInvoice = async (req, res) => {
  try {
    const { id, orderCode } = req.query;
    if (!id && !orderCode) return res.status(400).json({ message: 'Vui lòng cung cấp `id` hoặc `orderCode`' });

    let order;
    if (id) {
      if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
      order = await Order.findById(id).populate('items.productId', 'name').lean();
      if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
      if (req.user.role !== 'admin') {
        if (!order.userId && order.guestInfo) return res.status(403).json({ message: 'Không có quyền truy cập hóa đơn' });
        const orderUserId = order.userId && order.userId._id ? order.userId._id : order.userId;
        if (orderUserId && req.user.id && orderUserId.toString() !== req.user.id.toString()) return res.status(403).json({ message: 'Không có quyền truy cập hóa đơn' });
      }
    } else {
      order = await Order.findOne({ orderCode }).populate('items.productId', 'name').lean();
      if (!order) return res.status(404).json({ message: 'Không tìm thấy đơn hàng' });
    }

    // Render PDF using Puppeteer
    if (!puppeteer) {
      return res.status(500).json({ message: 'PDF renderer not available. Please run `npm install puppeteer`.' });
    }

    const pdfBuffer = await renderInvoicePdfFromTemplate(order);

    const filename = `invoice_${order.orderCode || order._id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('getOrderInvoice error:', err);
    return res.status(500).json({ message: 'Lỗi xuất hóa đơn' });
  }
};

exports.getOrdersAdmin = async (req, res) => {
  try {
    // authorization: chỉ admin (guess: req.user.role)
    if (req.user?.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    // whitelist sort fields to avoid arbitrary field injection
    const allowedSort = ["createdAt", "totalAmount", "orderCode", "orderStatus", "shippingFee", "subtotal"];
    const sortBy = allowedSort.includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    const {
      status,            // orderStatus
      paymentStatus,     // paymentMethod.status
      orderCode,         // exact or partial
      userId,            // filter by user
      q,                 // general text search
      dateFrom,
      dateTo,
      date
    } = req.query;

  const filter = {};

    // support multiple statuses: comma separated list or single
    if (status) {
      if (typeof status === "string" && status.includes(",")) {
        filter.orderStatus = { $in: status.split(",").map(s => s.trim()).filter(Boolean) };
      } else {
        filter.orderStatus = status;
      }
    }
    if (paymentStatus) filter["paymentMethod.status"] = paymentStatus;
    if (userId) filter.userId = userId;
    if (orderCode) filter.orderCode = new RegExp(orderCode, "i");

    // full text / flexible search: try to find matching users first (name/email) and include by userId
    if (q) {
      const r = new RegExp(q, "i");
      // find users matching q (name, email, phone)
      const matchedUsers = await User.find({
        $or: [
          { firstName: r },
          { lastName: r },
          { email: r },
          { phone: r }
        ]
      }).select("_id").lean();

      const userIds = (matchedUsers || []).map(u => u._id);

      filter.$or = [
        { "shippingAddress.fullName": r },
        { "shippingAddress.phone": r },
        { "shippingAddress.email": r },
        { customerNote: r },
        { orderCode: r },
        { "items.name": r }
      ];

      if (userIds.length) filter.$or.push({ userId: { $in: userIds } });
    }

    // support a single `date` param to filter by that whole day (YYYY-MM-DD)
    if (date) {
      const parsed = new Date(date);
      if (!isNaN(parsed.getTime())) {
        const start = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
        const end = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999);
        filter.createdAt = { $gte: start, $lte: end };
      }
    } else if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const d = new Date(dateTo);
        // include whole day for dateTo (guess)
        d.setHours(23,59,59,999);
        filter.createdAt.$lte = d;
      }
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    // compute total count and total amount for the full filter
    const aggMatch = { $match: filter };
    const aggTotals = await Order.aggregate([
      aggMatch,
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
          count: { $sum: 1 }
        }
      }
    ]).allowDiskUse(true);

    const total = (aggTotals[0] && aggTotals[0].count) || 0;
    const totalAmount = (aggTotals[0] && aggTotals[0].totalAmount) || 0;

    // Tabs data for admin UI: always compute simple numeric counts so frontend không cần gọi riêng.
    const [statusAgg, paymentAgg, unconfirmedCount] = await Promise.all([
      Order.aggregate([
        aggMatch,
        { $group: { _id: "$orderStatus", count: { $sum: 1 }, totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } } } }
      ]).allowDiskUse(true),
      Order.aggregate([
        aggMatch,
        { $group: { _id: "$paymentMethod.status", count: { $sum: 1 } } }
      ]).allowDiskUse(true),
      Order.countDocuments({ ...filter, unconfirmed: true })
    ]);

    const byStatus = {};
    (statusAgg || []).forEach(s => { byStatus[s._id || 'unknown'] = { count: s.count || 0, totalAmount: s.totalAmount || 0 }; });

    const byPayment = {};
    (paymentAgg || []).forEach(p => { byPayment[p._id || 'unknown'] = p.count || 0; });

    // helpers to sum groups
    const sumOf = keys => keys.reduce((acc, k) => acc + ((byStatus[k] && byStatus[k].count) || 0), 0);
    const sumAmountOf = keys => keys.reduce((acc, k) => acc + ((byStatus[k] && byStatus[k].totalAmount) || 0), 0);

    // simple numeric tabs object (always returned)
    const tabs = {
      all: total,
      unconfirmed: unconfirmedCount || 0,
      pending: (byStatus.pending && byStatus.pending.count) || 0,
      confirmed: (byStatus.confirmed && byStatus.confirmed.count) || 0,
      processing: sumOf(['pending', 'confirmed']),
      paid: byPayment.paid || 0,
      shipped: (byStatus.shipped && byStatus.shipped.count) || 0,
      delivered: (byStatus.delivered && byStatus.delivered.count) || 0,
      completed: (byStatus.completed && byStatus.completed.count) || 0,
      cancelled: (byStatus.cancelled && byStatus.cancelled.count) || 0,
      problems: byPayment.failed || 0,
      // keep raw maps for potential UI needs
      byStatus,
      byPayment
    };
      // If the caller only wants numeric counts for tabs, return a minimal object with numbers.
      if (req.query.countsOnly === 'true' || req.query.countsOnly === '1') {
        const simple = {
          all: total,
          unconfirmed: unconfirmedCount || 0,
          pending: (byStatus.pending && byStatus.pending.count) || 0,
          confirmed: (byStatus.confirmed && byStatus.confirmed.count) || 0,
          processing: sumOf(['pending', 'confirmed']),
          paid: byPayment.paid || 0,
          shipped: (byStatus.shipped && byStatus.shipped.count) || 0,
          delivered: (byStatus.delivered && byStatus.delivered.count) || 0,
          completed: (byStatus.completed && byStatus.completed.count) || 0,
          cancelled: (byStatus.cancelled && byStatus.cancelled.count) || 0,
          problems: byPayment.failed || 0
        };
        return res.json({ tabs: simple });
      }

    // fetch paged orders
    const orders = await Order.find(filter)
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("items.productId", "name slug")
      .populate("items.variantId", "sku images color")
      .populate("userId", "firstName lastName email phone")
      .lean();

    // page sum of totalAmount
    const pageTotal = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);

    // Optional CSV export
    if (req.query.export === "csv") {
      // simple CSV generator (comma separated, basic escaping)
      const cols = ["orderCode", "customerName", "phone", "email", "orderStatus", "paymentStatus", "subtotal", "shippingFee", "discount", "totalAmount", "createdAt"];
      const lines = [];
      lines.push(cols.join(","));
      for (const o of orders) {
        const name = o.shippingAddress?.fullName || o.guestInfo?.fullName || (o.userId && `${o.userId.firstName || ""} ${o.userId.lastName || ""}`) || "";
        const phone = o.shippingAddress?.phone || o.guestInfo?.phone || (o.userId && o.userId.phone) || "";
        const email = o.shippingAddress?.email || o.guestInfo?.email || (o.userId && o.userId.email) || "";
        const row = [
          o.orderCode || "",
          `"${(name || "").replace(/"/g, '""') }"`,
          `"${(phone || "").replace(/"/g, '""') }"`,
          `"${(email || "").replace(/"/g, '""') }"`,
          o.orderStatus || "",
          o.paymentMethod?.status || "",
          o.subtotal || 0,
          o.shippingFee || 0,
          o.discount || 0,
          o.totalAmount || 0,
          o.createdAt ? new Date(o.createdAt).toISOString() : ""
        ];
        lines.push(row.join(","));
      }
      const csv = lines.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=orders_page_${page}.csv`);
      return res.send(Buffer.from(csv, "utf8"));
    }

    res.json({
      meta: { total, totalAmount, pageTotal, page, limit, pages: Math.ceil(total / limit) },
      tabs,
      data: orders
    });
  } catch (err) {
    console.error("getOrdersAdmin error:", err);
    res.status(500).json({ message: "Lỗi lấy danh sách đơn hàng" });
  }
};

exports.updateOrderStatus = async (req, res) => {
  try {
    if (req.user?.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const { id } = req.params;
    const { orderStatus, paymentStatus } = req.body; // both optional

    const allowedStatuses = ["pending", "confirmed", "shipped", "delivered", "cancelled", "completed"];
    const allowedPayment = ["pending", "paid", "failed", "cancelled"];

    if (orderStatus && !allowedStatuses.includes(orderStatus)) {
      return res.status(400).json({ message: "orderStatus không hợp lệ" });
    }
    if (paymentStatus && !allowedPayment.includes(paymentStatus)) {
      return res.status(400).json({ message: "paymentStatus không hợp lệ" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng" });

    const prevOrderStatus = order.orderStatus;
    const prevPaymentStatus = order.paymentMethod?.status;

    // If changing to paid (either via paymentStatus or orderStatus -> confirmed with paid)
    const willBePaid = (paymentStatus === "paid") || (orderStatus === "confirmed" && prevPaymentStatus === "pending");

    // If moving to cancelled
    const willBeCancelled = orderStatus === "cancelled" || paymentStatus === "cancelled";

    // Update requested fields
    if (orderStatus) order.orderStatus = orderStatus;
    if (paymentStatus) order.paymentMethod.status = paymentStatus;
    const znsStatuses = [
      "confirmed",
      "completed",
      "shipped",
      "delivered",
      "cancelled",
    ];

    if (znsStatuses.includes(orderStatus)) {
      await sendZNS(order, orderStatus);
    }
    // Handle paid flow: decrease stock and redeem voucher (similar to webhook)
    if (willBePaid && prevPaymentStatus !== "paid") {
      order.paymentMethod.paidAt = new Date();
      try {
        await decreaseStock(order.items);
      } catch (err) {
        console.error("decreaseStock error (admin update):", err);
        // continue
      }

      if (order.voucher?.voucherId && !order.voucher?.redeemed) {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          const v = await Voucher.findById(order.voucher.voucherId).session(session);
          if (v) {
            if (v.usageLimit === null || v.usedCount < v.usageLimit) {
              v.usedCount = (v.usedCount || 0) + 1;
              if (order.userId) {
                const rec = v.usersUsed?.find(u => u.user?.toString() === order.userId?.toString());
                if (rec) rec.count = (rec.count || 0) + 1;
                else v.usersUsed = [...(v.usersUsed || []), { user: order.userId, count: 1 }];
              }
              await v.save({ session });
              order.voucher.redeemed = true;
              order.voucher.redeemedAt = new Date();
              await order.save({ session });
            } else {
              console.warn("Voucher already exhausted at admin redeem time:", v.code);
              await order.save({ session });
            }
          } else {
            await order.save({ session });
          }
          await session.commitTransaction();
        } catch (err) {
          await session.abortTransaction();
          console.error("Voucher redeem transaction error (admin):", err);
          await order.save();
        } finally {
          session.endSession();
        }
      } else {
        await order.save();
      }
    }

    // Handle cancelled: restore stock and return items to user's cart
    if (willBeCancelled && prevOrderStatus !== "cancelled") {
      try {
        await restoreStock(order.items);
      } catch (err) {
        console.error("restoreStock error (admin cancel):", err);
      }

      if (order.userId) {
        const cartItems = order.items.map(item => ({
          variantId: item.variantId,
          productId: item.productId,
          quantity: item.quantity,
          size: item.size,
          price: item.price,
          discountPrice: item.discountPrice || item.price || 0,
          finalPrice: item.finalPrice || item.price || 0,
          name: item.name || ""
        }));
        try {
          await Cart.updateOne(
            { userId: order.userId },
            { $push: { items: { $each: cartItems } } },
            { upsert: true }
          );
        } catch (err) {
          console.error("push back to cart error (admin):", err);
        }
      }
    }

    // Handle completed: ensure payment is marked as paid and add to user's order history
    const willBeCompleted = orderStatus === "completed" && prevOrderStatus !== "completed";
    if (willBeCompleted) {
      // Đơn hàng hoàn tất phải đã thanh toán
      if (order.paymentMethod.status !== "paid") {  
        order.paymentMethod.status = "paid";
        order.paymentMethod.paidAt = order.paymentMethod.paidAt || new Date();
      }

      // Thêm vào order history của user
      if (order.userId) {
        try {
          await User.updateOne(
            { _id: order.userId },
            {
              $push: {
                orderHistory: {
                  orderId: order._id,
                  purchasedAt: new Date()
                }
              }
            }
          );
          console.log("✅ Order added to user history:", order._id);
        } catch (err) {
          console.error("Add to orderHistory error:", err);
          // continue anyway
        }
      }
    }

    order.updatedAt = new Date();
    await order.save();

    // Gửi email thông báo cập nhật trạng thái
    try {
      const customerEmail = order.userId 
        ? (await User.findById(order.userId))?.email 
        : order.guestInfo?.email || order.shippingAddress?.email;
      
      if (customerEmail) {
        // Gửi email nếu có thay đổi trạng thái đơn hàng
        if (orderStatus && orderStatus !== prevOrderStatus) {
          await sendOrderStatusUpdateEmail(order, customerEmail, 'order', orderStatus);
          console.log(`📧 Email cập nhật trạng thái đơn hàng đã gửi đến: ${customerEmail}`);
        }
        
        // Gửi email nếu có thay đổi trạng thái thanh toán
        if (paymentStatus && paymentStatus !== prevPaymentStatus) {
          await sendOrderStatusUpdateEmail(order, customerEmail, 'payment', paymentStatus);
          console.log(`📧 Email cập nhật trạng thái thanh toán đã gửi đến: ${customerEmail}`);
        }
      }
    } catch (emailError) {
      console.error("Lỗi khi gửi email thông báo:", emailError);
      // Không throw error để không làm fail toàn bộ request
    }

    
    res.json({ message: "Cập nhật trạng thái thành công", order });
  } catch (error) {
    console.error("updateOrderStatus error:", error);
    res.status(500).json({ message: "Lỗi cập nhật trạng thái đơn hàng" });
  }
};

exports.confirmOrderByToken = async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ message: 'Token required' });

    const order = await Order.findOne({ 'confirmation.token': token });
    if (!order) return res.status(404).json({ message: 'Order không tồn tại' });

    if (order.confirmation.confirmed) return res.status(200).json({ message: 'Đã xác nhận' });
    if (new Date() > new Date(order.confirmation.expiresAt)) {
      order.orderStatus = 'cancelled';
      order.confirmation.confirmed = false;
      await order.save();
      return res.status(410).json({ message: 'Token hết hạn, đơn đã hủy' });
    }
    order.confirmation.confirmed = true;
    order.unconfirmed = false;
    order.paymentMethod.status = 'pending';
    await order.save();

    try { await decreaseStock(order.items); } catch(e){ console.warn('decreaseStock', e); }
    if (order.userId) {
      await Cart.updateOne({ userId: order.userId }, { $pull: { items: { variantId: { $in: order.items.map(i => i.variantId) } } } });
    }

    // send order created email
    const recipient = order.shippingAddress?.email || order.guestInfo?.email || null;
    if (recipient) sendOrderCreatedEmail(order, recipient).catch(e => console.warn('send order email failed', e));
    
    await sendZNS(order, "confirmed");
    return res.json({ message: 'Xác nhận thành công', order });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
};




