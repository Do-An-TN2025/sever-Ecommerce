const mongoose = require("mongoose");
const ProductVariant = require("../models/ProductVariant");
const Cart = require("../models/Cart");
const crypto = require("crypto");

const PAYOS_CLIENT_ID = process.env.PAYOS_CLIENT_ID;
const PAYOS_API_KEY = process.env.PAYOS_API_KEY;
const PAYOS_CHECKSUM_KEY = process.env.PAYOS_CHECKSUM_KEY;

async function hydrateItems(inputItems) {
  const variantIds = inputItems.map(
    (item) => new mongoose.Types.ObjectId(item.variantId)
  );
  const variants = await ProductVariant.find({
    _id: { $in: variantIds },
  }).populate("productId", "name thumbnail sku images");

  if (variants.length !== inputItems.length) {
    throw new Error("Một số sản phẩm không còn khả dụng");
  }

  return inputItems.map((item) => {
    const variant = variants.find((v) => v._id.equals(item.variantId));
    if (!variant) throw new Error("Variant không tồn tại");

    const product = variant.productId;
    let price = variant.price || 0;
    let sizeLabel = item.size || null;

    if (Array.isArray(variant.sizes) && variant.sizes.length) {
      const matched = variant.sizes.find((s) =>
        item.size ? s.size === item.size : s.stock > 0
      );
      if (!matched) throw new Error(`Size ${item.size || ""} đã hết hàng`);
      sizeLabel = matched.size;
      price =
        matched.discountPrice && matched.discountPrice > 0
          ? matched.discountPrice
          : matched.price;
    } else if (item.price) {
      price = item.price;
    }

    return {
      productId: product?._id || variant.productId,
      variantId: variant._id,
      name: product?.name || item.name || "",
      sku: variant.sku || product?.sku || "",
      color: variant.color || item.color || "",
      size: sizeLabel,
      quantity: item.quantity,
      price,
      image:
        (variant.images && variant.images[0]) ||
        product?.thumbnail ||
        item.image ||
        "",
    };
  });
}

async function decreaseStock(orderItems) {
  for (const item of orderItems) {
    const variant = await ProductVariant.findById(item.variantId);
    if (!variant) continue;

    if (Array.isArray(variant.sizes) && variant.sizes.length && item.size) {
      const sizeIndex = variant.sizes.findIndex(s => s.size === item.size);
      if (sizeIndex !== -1) {
        variant.sizes[sizeIndex].stock = Math.max(0, variant.sizes[sizeIndex].stock - item.quantity);
      }
    } else if (variant.stock !== undefined) {
      variant.stock = Math.max(0, variant.stock - item.quantity);
    }

    await variant.save();
  }
}

async function restoreStock(orderItems) {
  for (const item of orderItems) {
    const variant = await ProductVariant.findById(item.variantId);
    if (!variant) continue;

    if (Array.isArray(variant.sizes) && variant.sizes.length && item.size) {
      const sizeIndex = variant.sizes.findIndex(s => s.size === item.size);
      if (sizeIndex !== -1) {
        variant.sizes[sizeIndex].stock += item.quantity;
      }
    } else if (variant.stock !== undefined) {
      variant.stock += item.quantity;
    }

    await variant.save();
  }
}

async function createPayOSPayment(paymentBody) {
  const axios = require('axios');
  const data = `amount=${paymentBody.amount}&cancelUrl=${paymentBody.cancelUrl}&description=${paymentBody.description}&orderCode=${paymentBody.orderCode}&returnUrl=${paymentBody.returnUrl}`;
  const signature = crypto
    .createHmac('sha256', PAYOS_CHECKSUM_KEY)
    .update(data)
    .digest('hex');

  const requestBody = {
    ...paymentBody,
    signature
  };

  try {
    console.log('PayOS request body:', JSON.stringify(requestBody));
    const response = await axios.post(
      'https://api-merchant.payos.vn/v2/payment-requests',
      requestBody,
      {
        headers: {
          'x-client-id': PAYOS_CLIENT_ID,
          'x-api-key': PAYOS_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('PayOS response:', JSON.stringify(response.data));

    // If PayOS did not return expected checkoutUrl/qrCode, throw with details
    if (!response.data || !response.data.data || (!response.data.data.checkoutUrl && !response.data.data.qrCode)) {
      const msg = 'PayOS did not return checkoutUrl/qrCode';
      console.error(msg, JSON.stringify(response.data));
      const err = new Error(msg);
      err.remote = response.data;
      throw err;
    }

    return response.data;
  } catch (error) {
    console.error('PayOS API Error:', error.response?.data || error.message || error);
    throw error;
  }
}

module.exports = {
  hydrateItems,
  decreaseStock,
  restoreStock,
  createPayOSPayment
};