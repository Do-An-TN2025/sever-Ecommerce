
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const {
  hydrateItems,
  decreaseStock,
  restoreStock,
  createPayOSPayment
} = require("../services/orderService");
const { generateOrderCode } = require("../utils/orderUtils");
require('dotenv').config();
const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID;
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY;

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
    } = req.body;

    if (!items?.length)
      return res.status(400).json({ message: "Giỏ hàng trống" });
    if (!shippingAddress?.fullName || !shippingAddress?.phone) {
      return res.status(400).json({ message: "Thiếu thông tin giao hàng" });
    }
    if (!paymentMethod?.type) {
      return res.status(400).json({ message: "Thiếu phương thức thanh toán" });
    }

    const orderItems = await hydrateItems(items);
    const subtotal = orderItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const shippingFee = Number(req.body.shippingFee || 0);
    const discount = Number(req.body.discount || 0);
    const totalAmount = subtotal + shippingFee - discount;

    const baseOrder = {
      items: orderItems,
      shippingAddress: {
        fullName: shippingAddress.fullName,
        phone: shippingAddress.phone,
        addressLine1:
          shippingAddress.addressLine || shippingAddress.addressLine1 || "",
        addressLine2: shippingAddress.addressLine2 || "",
        ward: shippingAddress.ward || "",
        district: shippingAddress.district || "",
        city: shippingAddress.city || "",
        postalCode: shippingAddress.postalCode || "",
      },
      paymentMethod: {
        type: paymentMethod.type,
        status: "pending",
        note: paymentMethod.note || "",
      },
      customerNote,
      orderStatus: "pending",
      subtotal,
      shippingFee,
      discount,
      totalAmount,
    };

    const userId = req.user?.id || null;
    if (userId) {
      baseOrder.userId = userId;
    } else {
      const guestName = guestInfo.fullName || shippingAddress.fullName;
      const guestPhone = guestInfo.phone || shippingAddress.phone;
      if (!guestName || !guestPhone) {
        return res
          .status(400)
          .json({
            message: "Khách vãng lai cần cung cấp họ tên và số điện thoại",
          });
      }
      baseOrder.guestInfo = {
        fullName: guestName,
        phone: guestPhone,
        email: guestInfo.email || req.body.contactEmail || null,
      };
    }

    if (paymentMethod.type !== "PayOS") {
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
      return res.status(201).json({ order });
    }

    if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY || !PAYOS_CHECKSUM_KEY) {
      return res.status(500).json({ message: "PayOS chưa được cấu hình" });
    }

    const orderCode = generateOrderCode();
    console.log("orderCode:", orderCode);
    
    const successUrl =
      returnUrl ||
      `${process.env.CLIENT_URL || "http://localhost:3000"}/payment/success`;
    const failUrl =
      cancelUrl ||
      `${process.env.CLIENT_URL || "http://localhost:3000"}/payment/cancel`;
    
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
      items: orderItems.map(item => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price
      })),
      expiredAt: Math.floor(Date.now() / 1000) + 900 // 15 phút
    };
    
    console.log("PAYOS paymentBody:", paymentBody);

    let paymentData;
    try {
      paymentData = await createPayOSPayment(paymentBody);
    } catch (err) {
      console.error(
        "PayOS create link error:",
        err?.response?.data || err.message
      );
      return res
        .status(502)
        .json({ message: "Không tạo được liên kết thanh toán PayOS" });
    }

    baseOrder.orderCode = orderCode;
    baseOrder.paymentMethod.transactionId =
      paymentData.data?.orderCode || paymentData.data?.paymentLinkId || null;
    baseOrder.paymentMethod.invoiceUrl = paymentData.data?.checkoutUrl;
    baseOrder.paymentMethod.expiresAt = paymentData.data?.expiredAt
      ? new Date(paymentData.data.expiredAt * 1000)
      : null;

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

    return res.status(201).json({
      order,
      payment: {
        checkoutUrl: paymentData.data?.checkoutUrl,
        qrCode: paymentData.data?.qrCode || null,
      },
    });
  } catch (error) {
    console.error("createOrder error:", error);
    res.status(500).json({ message: "Tạo đơn hàng thất bại" });
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

    // Tránh xử lý trùng lặp
    if (order.paymentMethod.status === "paid" || order.paymentMethod.status === "cancelled") {
      console.log("Order already processed:", order._id);
      return res.json({ message: "Order already processed" });
    }

    if (payload.code === "00" || payload.status === "PAID") {
      // THANH TOÁN THÀNH CÔNG
      order.paymentMethod.status = "paid";
      order.orderStatus = "confirmed";
      order.paymentMethod.paidAt = new Date();
      
      // Giảm stock sản phẩm
      await decreaseStock(order.items);
      
      console.log("✅ Payment successful for order:", order._id);
      
    } else if (payload.status === "CANCELLED") {
      // HỦY THANH TOÁN
      order.paymentMethod.status = "cancelled";
      order.orderStatus = "cancelled";
      order.paymentMethod.cancelledAt = new Date();
      
      // Hoàn lại sản phẩm vào giỏ hàng (nếu là user đã đăng nhập)
      if (order.userId) {
        const cartItems = order.items.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
          size: item.size,
          price: item.price
        }));
        
        await Cart.updateOne(
          { userId: order.userId },
          { 
            $push: { items: { $each: cartItems } }
          },
          { upsert: true }
        );
      }
      
      console.log("❌ Payment cancelled for order:", order._id);
      
    } else {
      // THANH TOÁN THẤT BẠI
      order.paymentMethod.status = "failed";
      order.paymentMethod.failedAt = new Date();
      console.log("⚠️ Payment failed for order:", order._id);
    }

    order.paymentMethod.transactionId =
      payload.transactionId ||
      payload.paymentLinkId ||
      order.paymentMethod.transactionId;

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
    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

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

    const order = await Order.findOne({
      _id: id,
      ...(userId && { userId })
    });

    if (!order) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }
    if (order.orderStatus !== "pending") {
      return res.status(400).json({ 
        message: "Chỉ có thể hủy đơn hàng đang chờ xử lý" 
      });
    }

    if (order.paymentMethod.status === "paid") {
      return res.status(400).json({ 
        message: "Không thể hủy đơn hàng đã thanh toán" 
      });
    }

    order.orderStatus = "cancelled";
    order.paymentMethod.status = "cancelled";
    order.paymentMethod.cancelledAt = new Date();

    // Hoàn lại sản phẩm vào giỏ hàng
    if (userId) {
      const cartItems = order.items.map(item => ({
        variantId: item.variantId,
        quantity: item.quantity,
        size: item.size,
        price: item.price
      }));
      
      await Cart.updateOne(
        { userId },
        { 
          $push: { items: { $each: cartItems } }
        },
        { upsert: true }
      );
    }

    await order.save();

    res.json({ 
      message: "Đã hủy đơn hàng thành công",
      order 
    });
    
  } catch (error) {
    console.error("cancelOrder error:", error);
    res.status(500).json({ message: "Lỗi hủy đơn hàng" });
  }
};

exports.getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id }).sort({
      createdAt: -1,
    });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Không lấy được danh sách đơn hàng" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!order)
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: "Không lấy được đơn hàng" });
  }
};