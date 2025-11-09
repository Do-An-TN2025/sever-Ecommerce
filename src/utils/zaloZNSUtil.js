require("dotenv").config({
  path: require("path").join(__dirname, "../../.env"),
});
const { sendZNS: sendZNSService } = require("../services/zaloZNSService");

const TEMPLATE_CONFIRM = process.env.ZALO_TEMPLATE_ORDER_CONFIRM;
const TEMPLATE_COMPLETE = process.env.ZALO_TEMPLATE_ORDER_COMPLETE;

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
  if (status === "confirm") templateId = TEMPLATE_CONFIRM;
  else if (status === "complete") templateId = TEMPLATE_COMPLETE;
  else {
    console.warn(`Status không hợp lệ: ${status}`);
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
