const axios = require("axios");

function normalizePhone(phone) {
  if (!phone) return phone;
  phone = phone.trim();
  if (phone.startsWith("0")) {
    return "84" + phone.slice(1);
  }
  return phone;
}

async function sendZNS({
  phone,
  templateId,
  templateData,
  trackingId,
  sendingMode = "1",
}) {
  phone = normalizePhone(phone);

  try {
    const accessToken = process.env.ZALO_ACCESS_TOKEN;
    if (!accessToken) {
      console.warn("Chưa cấu hình ZALO_ACCESS_TOKEN");
      return;
    }
    const response = await axios.post(
      "https://business.openapi.zalo.me/message/template",
      {
        phone,
        template_id: templateId,
        template_data: templateData,
        tracking_id: trackingId,
      },
      {
        headers: {
          "Content-Type": "application/json",
          access_token: accessToken,
        },
      }
    );

    return response.data;
  } catch (err) {
    if (err.response) {
      console.error("Zalo API lỗi (bỏ qua):", err.response.data);
    } else if (err.request) {
      console.error(
        "Không nhận được phản hồi từ Zalo API (bỏ qua):",
        err.request
      );
    } else {
      console.error("Lỗi gửi ZNS (bỏ qua):", err.message);
    }
  }
}

module.exports = { sendZNS };
