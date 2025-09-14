const nodemailer = require("nodemailer");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL,
    pass: process.env.GMAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

async function sendOtpMail(to, otp) {
  try {
    const mailOptions = {
      from: `"Vinapet" <${process.env.GMAIL}>`,
      to,
      subject: "Mã OTP xác thực",
      text: `Mã OTP của bạn là: ${otp}. Hết hạn sau 5 phút.`,
      html: `<p>Mã OTP của bạn là: <b>${otp}</b></p><p>Hết hạn sau 5 phút.</p>`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Đã gửi OTP:", info.messageId);
  } catch (error) {
    console.error("Lỗi khi gửi OTP:", error);
    throw new Error("Không thể gửi OTP, vui lòng thử lại sau");
  }
}

module.exports = sendOtpMail;
