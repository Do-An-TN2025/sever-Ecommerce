require("dotenv").config({
  path: require("path").join(__dirname, "../../.env"),
});
const { sendZNS: sendZNSService } = require("../services/zaloZNSService");

// Template chung & template riêng
const TEMPLATE_COMMON = process.env.ZALO_TEMPLATE_ORDER_COMMON;
const TEMPLATE_COMPLETE = process.env.ZALO_TEMPLATE_ORDER_COMPLETE;

// Danh sách các trạng thái sử dụng TEMPLATE_COMMON
const COMMON_STATUSES = new Set([
  "confirmed",
  "pending",
  "shipped",
  "delivered",
  "cancelled",
  "paid",
  "failed",
  "payment_cancelled",
]);

async function sendOrderZNSByStatus({
  phone,
  status,
  templateData,
  trackingId,
}) {
  if (!phone || !status || !templateData || !trackingId) {
    console.warn(
      "Thiếu dữ liệu gửi ZNS: phone, status, templateData hoặc trackingId"
    );
    return;
  }

  let templateId;

  if (status === "completed") {
    templateId = TEMPLATE_COMPLETE;
  } else if (COMMON_STATUSES.has(status)) {
    templateId = TEMPLATE_COMMON;
  } else {
    console.warn(`Status không hợp lệ: ${status}`);
    return;
  }

  if (!templateId) {
    console.warn(`Không có TEMPLATE_ID cho status='${status}'. Bỏ qua gửi ZNS.`);
    return;
  }

  try {
    await sendZNSService({ phone, templateId, templateData, trackingId });
    console.log(`Đã gửi ZNS đơn hàng với status=${status} đến ${phone}`);
  } catch (err) {
    console.error(
      "Lỗi gửi ZNS (bỏ qua):",
      err.response?.data || err.message || err
    );
  }
}

module.exports = { sendOrderZNSByStatus };
