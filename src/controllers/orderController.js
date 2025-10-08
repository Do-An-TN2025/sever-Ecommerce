const axios = require("axios");
const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");

const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID;
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY;
const PAYOS_API = process.env.PAYOS_API || "https://api.payos.vn";

function signPayload(payload) {
  const sorted = Object.keys(payload)
    .filter((k) => payload[k] !== undefined && payload[k] !== null)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join("&");
  return crypto.createHmac("sha256", PAYOS_CHECKSUM_KEY).update(sorted).digest("hex");
}

async function hydrateOrderItems(rawItems) {
  const variantIds = rawItems.map((item) => new mongoose.Types.ObjectId(item.variantId));
  const variants = await ProductVariant.find({ _id: { $in: variantIds } })
    .populate("productId", "name slug images thumbnail sku");

  if (variants.length !== rawItems.length) {
    throw new Error("Một số sản phẩm không còn khả dụng");
  }

  return rawItems.map((input) => {
    const variant = variants.find((v) => v._id.equals(input.variantId));
    const product = variant.productId;
    const color = variant.color || input.color || null;

    let price = variant.price || 0;
    let sizeLabel = input.size || null;

    if (Array.isArray(variant.sizes) && variant.sizes.length) {
      const matchedSize = variant.sizes.find((s) =>
        input.size ? s.size === input.size : s.stock > 0
      );
      if (!matchedSize) {
        throw new Error(`Size ${input.size || ""} hiện không còn hàng`);
      }
      sizeLabel = matchedSize.size;
      price = matchedSize.discountPrice && matchedSize.discountPrice > 0
        ? matchedSize.discountPrice
        : matchedSize.price;
    } else if (input.price) {
      price = input.price;
    }

    return {
      productId: product?._id || variant.productId,
      variantId: variant._id,
      name: product?.name || input.name || "",
      sku: variant.sku || product?.sku || "",
      color,
      size: sizeLabel,
      quantity: input.quantity,
      price,
      image: (variant.images && variant.images[0]) || product?.thumbnail || input.image || ""
    };
  });
}

exports.createOrder = async (req, res) => {
  try {
    const { items, shippingAddress, paymentMethod, guestInfo, customerNote } = req.body;

    if (!items?.length) return res.status(400).json({ message: "Giỏ hàng trống" });
    if (!shippingAddress?.fullName || !shippingAddress?.phone || !shippingAddress?.addressLine)
      return res.status(400).json({ message: "Thiếu thông tin địa chỉ giao hàng" });
    if (!paymentMethod?.type) return res.status(400).json({ message: "Thiếu phương thức thanh toán" });

    const userId = req.user?.id || null;
    if (!userId && !guestInfo?.fullName) {
      return res.status(400).json({ message: "Khách vãng lai cần cung cấp họ tên/ liên hệ" });
    }

    const orderItems = await hydrateOrderItems(items);

    const subtotal = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shippingFee = Number(req.body.shippingFee || 0);
    const discount = Number(req.body.discount || 0);
    const totalAmount = subtotal + shippingFee - discount;

    const order = await Order.create({
      userId,
      guestInfo: userId ? undefined : {
        fullName: guestInfo.fullName,
        email: guestInfo.email,
        phone: guestInfo.phone || shippingAddress.phone
      },
      items: orderItems,
      shippingAddress: {
        fullName: shippingAddress.fullName,
        phone: shippingAddress.phone,
        addressLine1: shippingAddress.addressLine,
        addressLine2: shippingAddress.addressLine2,
        ward: shippingAddress.ward,
        district: shippingAddress.district,
        city: shippingAddress.city,
        postalCode: shippingAddress.postalCode
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
      totalAmount
    });

    if (userId) {
      await Cart.updateOne(
        { userId },
        { $pull: { items: { variantId: { $in: orderItems.map((i) => i.variantId) } } } }
      );
    }

    if (paymentMethod.type === "PayOS") {
      if (!PAYOS_CLIENT_ID || !PAYOS_API_KEY || !PAYOS_CHECKSUM_KEY) {
        return res.status(500).json({ message: "PayOS chưa được cấu hình" });
      }

      const payload = {
        orderCode: order._id.toString(),
        amount: totalAmount,
        description: `Order ${order._id}`,
        returnUrl: req.body.returnUrl,
        cancelUrl: req.body.cancelUrl,
        buyerName: shippingAddress.fullName,
        buyerEmail: guestInfo?.email || req.body.buyerEmail,
        buyerPhone: shippingAddress.phone
      };
      payload.signature = signPayload(payload);

      const payRes = await axios.post(`${PAYOS_API}/v2/payment-requests`, payload, {
        headers: {
          "x-client-id": PAYOS_CLIENT_ID,
          "x-api-key": PAYOS_API_KEY
        }
      });

      const data = payRes.data?.data || {};
      order.paymentMethod.transactionId = data.orderCode || data.paymentLinkId;
      order.paymentMethod.invoiceUrl = data.checkoutUrl;
      order.paymentMethod.expiresAt = data.expiredAt ? new Date(data.expiredAt) : null;
      await order.save();

      return res.status(201).json({
        order,
        payment: { checkoutUrl: data.checkoutUrl, qrCode: data.qrCode }
      });
    }

    return res.status(201).json({ order });
  } catch (error) {
    console.error("createOrder error:", error);
    res.status(500).json({ message: "Tạo đơn hàng thất bại" });
  }
};

exports.getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    res.status(500).json({ message: "Không lấy được danh sách đơn hàng" });
  }
};

exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, userId: req.user.id });
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: "Không lấy được đơn hàng" });
  }
};

exports.handlePayOSWebhook = async (req, res) => {
  try {
    const payload = req.body;
    const receivedSignature = req.headers["x-signature"];
    if (!receivedSignature) return res.status(400).json({ message: "Thiếu chữ ký" });

    const expectedSignature = signPayload(payload);
    if (receivedSignature !== expectedSignature) {
      return res.status(400).json({ message: "Sai chữ ký" });
    }

    const order = await Order.findById(payload.orderCode);
    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn" });

    if (payload.code === "00" || payload.status === "PAID") {
      order.paymentMethod.status = "paid";
      order.orderStatus = "confirmed";
    } else if (payload.status === "CANCELLED") {
      order.paymentMethod.status = "cancelled";
      order.orderStatus = "cancelled";
    } else {
      order.paymentMethod.status = "failed";
    }
    order.paymentMethod.transactionId = payload.transactionId || payload.paymentLinkId;
    await order.save();

    res.json({ message: "Webhook handled" });
  } catch (error) {
    console.error("handlePayOSWebhook error:", error);
    res.status(500).json({ message: "Webhook error" });
  }
};