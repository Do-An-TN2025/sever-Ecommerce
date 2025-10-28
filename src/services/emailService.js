const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true", 
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function formatCurrency(v) {
  try {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(Number(v) || 0);
  } catch (e) {
    return (Number(v) || 0).toLocaleString() + ' ₫';
  }
}

function buildOrderHtml(order = {}) {
  const shopName = (process.env.SITE_NAME || 'SHOPNOW').toUpperCase();
  const orderCode = order.orderCode || `SHOPNOW-${(order._id || '').toString().slice(-6)}`;
  const customer = order.shippingAddress || order.guestInfo || {};
  const items = order.items || [];
  const subtotal = order.subtotal || items.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0);
  const discount = order.discount || 0;
  const shippingFee = order.shippingFee || 0;
  const total = order.totalAmount || Math.max(0, subtotal - discount + shippingFee);
  const orderUrl = order.paymentMethod?.invoiceUrl || `${process.env.CLIENT_URL || ''}/orders/${order._id || ''}`;

  const itemsHtml = items.map(it => {
    const attrs = [it.size, it.color].filter(Boolean).join(' / ');
    const img = it.image ? `<img src="${it.image}" alt="${(it.name||'')}" style="width:64px;height:64px;object-fit:cover;border-radius:6px;margin-right:12px;vertical-align:middle;display:inline-block">` : '';
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #eee;vertical-align:middle">
          <div style="display:flex;align-items:center">
            ${img}
            <div style="line-height:1.2">
              <div style="font-weight:600;color:#111">${it.name || '-'}</div>
              <div style="color:#666;font-size:13px;margin-top:6px">${attrs}</div>
            </div>
          </div>
        </td>
        <td style="padding:12px 0;text-align:center;border-bottom:1px solid #eee">${it.quantity || 0}</td>
        <td style="padding:12px 0;text-align:right;border-bottom:1px solid #eee">${formatCurrency(it.price)}</td>
      </tr>
    `;
  }).join('');

  // responsive-friendly CSS (email-safe)
  const style = `
    <style type="text/css">
      body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100% }
      img { border:0; line-height:100%; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic }
      a { color:inherit; text-decoration:none }
      .container { width:680px; max-width:100%; margin:0 auto; }
      .card { background:#fff; border-radius:6px; overflow:hidden; }
      .header { background:#000; color:#fff; padding:18px 22px; }
      .content { padding:22px; }
      .btn { display:inline-block; padding:10px 16px; border-radius:6px; font-weight:700; text-decoration:none; }
      .muted { color:#666 }
      .table { width:100%; border-collapse:collapse }
      @media only screen and (max-width:600px) {
        .stack { display:block !important; width:100% !important; }
        .stack td { display:block !important; width:100% !important; box-sizing:border-box; }
        .img-sm { width:56px !important; height:56px !important; }
        .content { padding:14px !important; }
        .header { padding:12px !important; }
        .btn { padding:10px 12px !important; display:block; width:100%; text-align:center; }
        .h2 { font-size:18px !important; }
      }
    </style>
  `;

  return `
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${style}
  </head>
  <body style="font-family:Arial,Helvetica,sans-serif;background:#f5f6f8;margin:0;padding:24px;color:#222">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table class="container" cellpadding="0" cellspacing="0">
        <tr><td>
          <table class="card" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
            <tr>
              <td class="header" style="background:#000;color:#fff">
                <div style="font-size:18px;font-weight:800">${shopName}</div>
                <div style="font-size:13px;opacity:0.9">Đơn hàng ${orderCode}</div>
              </td>
            </tr>

            <tr>
              <td class="content" style="padding:22px">
                <h2 class="h2" style="margin:0 0 8px 0;color:#111">Thanh toán đơn hàng thành công!</h2>
                <p style="margin:0 0 16px 0;color:#444">Xin chào ${customer.fullName || ''}, đơn hàng của bạn đã được thanh toán thành công. Cám ơn bạn đã mua hàng.</p>

                <div style="text-align:center;margin:14px 0">
                  <a href="${orderUrl}" class="btn" style="background:#ffb200;color:#111;margin-right:8px">Xem đơn hàng</a>
                  <a href="${process.env.CLIENT_URL || '#'}" class="btn" style="background:#eee;color:#111">Đến cửa hàng của chúng tôi</a>
                </div>

                <h3 style="margin:18px 0 8px 0;color:#111">Thông tin đơn hàng</h3>

                <table class="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                  ${itemsHtml || '<tr><td colspan="3" style="padding:12px;color:#777">Không có sản phẩm</td></tr>'}
                </table>

                <table width="100%" cellpadding="6" cellspacing="0" style="margin-top:12px">
                  <tr><td class="muted">Tổng giá trị sản phẩm</td><td style="text-align:right;font-weight:700">${formatCurrency(subtotal)}</td></tr>
                  <tr><td class="muted">Khuyến mãi</td><td style="text-align:right">${formatCurrency(discount)}</td></tr>
                  <tr><td class="muted">Phí vận chuyển</td><td style="text-align:right">${formatCurrency(shippingFee)}</td></tr>
                  <tr style="border-top:2px solid #eee"><td style="font-weight:800;padding-top:10px">Tổng cộng</td><td style="text-align:right;font-weight:800;padding-top:10px">${formatCurrency(total)}</td></tr>
                </table>

                <h3 style="margin:18px 0 8px 0;color:#111">Thông tin khách hàng</h3>

                <table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="stack">
                  <tr>
                    <td style="vertical-align:top;padding-right:12px;width:50%;box-sizing:border-box">
                      <div style="font-weight:600;margin-bottom:6px">Địa chỉ giao hàng</div>
                      <div style="color:#555">
                        ${customer.fullName || ''}<br/>
                        ${customer.addressLine1 || customer.addressLine || ''}<br/>
                        ${customer.ward || ''} ${customer.district || ''} ${customer.city || ''}<br/>
                        Điện thoại: ${customer.phone || ''}<br/>
                        Email: ${customer.email || ''}
                      </div>
                    </td>
                    <td style="vertical-align:top;padding-left:12px;width:50%;box-sizing:border-box">
                      <div style="font-weight:600;margin-bottom:6px">Địa chỉ thanh toán</div>
                      <div style="color:#555">
                        ${order.billingAddress?.fullName || customer.fullName || ''}<br/>
                        ${order.billingAddress?.addressLine1 || customer.addressLine1 || ''}<br/>
                        ${order.billingAddress?.ward || customer.ward || ''} ${order.billingAddress?.district || customer.district || ''} ${order.billingAddress?.city || customer.city || ''}<br/>
                        Điện thoại: ${order.billingAddress?.phone || customer.phone || ''}<br/>
                      </div>
                    </td>
                  </tr>
                </table>

                <table width="100%" cellpadding="6" cellspacing="0" style="margin-top:12px">
                  <tr><td class="muted">Phương thức vận chuyển</td><td style="text-align:right">${order.shippingMethod || 'Giao hàng tận nơi'}</td></tr>
                  <tr><td class="muted">Phương thức thanh toán</td><td style="text-align:right">${order.paymentMethod?.type === 'COD' ? 'Thanh toán khi giao hàng (COD)' : (order.paymentMethod?.type || '—')}</td></tr>
                </table>

                <p style="color:#777;font-size:13px;margin-top:18px">Mã đơn: <strong>${orderCode}</strong></p>
              </td>
            </tr>

            <tr>
              <td style="background:#fafafa;padding:14px 22px;color:#666;font-size:13px">
                <div>Liên hệ hỗ trợ: <a href="mailto:${process.env.SUPPORT_EMAIL || 'support@shopnow.com'}" style="color:#111;text-decoration:none">${process.env.SUPPORT_EMAIL || 'support@shopnow.com'}</a></div>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
    </td></tr></table>
  </body>
  </html>
  `;
}

async function sendMail(opts) {
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const info = await transporter.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
  return info;
}

async function sendOrderCreatedEmail(order, to) {
  if (!to) return null;
  const subject = `Đơn hàng ${order.orderCode} đã được tạo`;
  const html = buildOrderHtml(order);
  const text = `Đơn hàng ${order.orderCode} - tổng: ${order.totalAmount || 0}`;
  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendOrderCreatedEmail,
};