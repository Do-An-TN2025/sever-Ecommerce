require("dotenv").config({
  path: require("path").join(__dirname, "../../.env"),
});
const { sendZNS: sendZNSService } = require("../services/zaloZNSService");

// Template IDs (configure in environment)
const TEMPLATE_CONFIRM = process.env.ZALO_TEMPLATE_ORDER_CONFIRM;
const TEMPLATE_COMPLETE = process.env.ZALO_TEMPLATE_ORDER_COMPLETE;
const TEMPLATE_PENDING = process.env.ZALO_TEMPLATE_ORDER_PENDING;
const TEMPLATE_SHIPPED = process.env.ZALO_TEMPLATE_ORDER_SHIPPED;
const TEMPLATE_DELIVERED = process.env.ZALO_TEMPLATE_ORDER_DELIVERED;
const TEMPLATE_CANCELLED = process.env.ZALO_TEMPLATE_ORDER_CANCELLED;
const TEMPLATE_PAID = process.env.ZALO_TEMPLATE_ORDER_PAID;
const TEMPLATE_PAYMENT_FAILED = process.env.ZALO_TEMPLATE_ORDER_PAYMENT_FAILED;
const TEMPLATE_PAYMENT_CANCELLED = process.env.ZALO_TEMPLATE_ORDER_PAYMENT_CANCELLED;

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
  switch (status) {
    case "confirm":
      templateId = TEMPLATE_CONFIRM;
      break;
    case "complete":
      templateId = TEMPLATE_COMPLETE;
      break;
    case "pending":
      templateId = TEMPLATE_PENDING;
      break;
    case "shipped":
      templateId = TEMPLATE_SHIPPED;
      break;
    case "delivered":
      templateId = TEMPLATE_DELIVERED;
      break;
    case "cancelled":
      templateId = TEMPLATE_CANCELLED;
      break;
    case "paid":
      templateId = TEMPLATE_PAID;
      break;
    case "failed":
      templateId = TEMPLATE_PAYMENT_FAILED;
      break;
    case "payment_cancelled":
      templateId = TEMPLATE_PAYMENT_CANCELLED || TEMPLATE_CANCELLED;
      break;
    default:
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
