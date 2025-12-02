const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  // enable verbose logging for debugging SMTP issues
  logger: true,
  debug: true,
});

// Verify connection configuration early so logs show details when app starts
transporter.verify((err, success) => {
  if (err) {
    console.error('SMTP verify failed:', err);
  } else {
    console.log('SMTP server is ready to take messages');
  }
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
  const orderUrl = order.paymentMethod?.invoiceUrl || `${process.env.CLIENT_URL || ''}/orders/${order.orderCode || ''}`;

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

function getStatusLabel(status) {
  const statusMap = {
    pending: 'Chờ xác nhận',
    confirmed: 'Đã xác nhận',
    shipped: 'Đang giao hàng',
    delivered: 'Đã giao hàng',
    completed: 'Hoàn thành',
    cancelled: 'Đã hủy',
    paid: 'Đã thanh toán',
    failed: 'Thanh toán thất bại'
  };
  return statusMap[status] || status;
}

function buildOrderStatusUpdateHtml(order, statusType, newStatus) {
  const shopName = (process.env.SITE_NAME || 'SHOPNOW').toUpperCase();
  const orderCode = order.orderCode || `SHOPNOW-${(order._id || '').toString().slice(-6)}`;
  const customer = order.shippingAddress || order.guestInfo || {};
  const items = order.items || [];
  const subtotal = order.subtotal || items.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0);
  const discount = order.discount || 0;
  const shippingFee = order.shippingFee || 0;
  const total = order.totalAmount || Math.max(0, subtotal - discount + shippingFee);
  const orderUrl = `${process.env.CLIENT_URL || ''}/orders/${order.orderCode || ''}`;
  
  const statusLabel = getStatusLabel(newStatus);
  let statusColor = '#ffb200';
  let statusIcon = '📦';
  let message = '';
  let actionMessage = '';

  if (statusType === 'order') {
    switch(newStatus) {
      case 'confirmed':
        statusColor = '#4CAF50';
        statusIcon = '✅';
        message = 'Đơn hàng của bạn đã được xác nhận!';
        actionMessage = 'Chúng tôi đang chuẩn bị sản phẩm và sẽ sớm giao hàng cho bạn.';
        break;
      case 'shipped':
        statusColor = '#2196F3';
        statusIcon = '🚚';
        message = 'Đơn hàng đang trên đường giao đến bạn!';
        actionMessage = 'Đơn vị vận chuyển đang giao hàng đến địa chỉ của bạn. Vui lòng chú ý điện thoại.';
        break;
      case 'delivered':
        statusColor = '#4CAF50';
        statusIcon = '✅';
        message = 'Đơn hàng đã được giao thành công!';
        actionMessage = 'Cảm ơn bạn đã mua hàng. Hy vọng bạn hài lòng với sản phẩm!';
        break;
      case 'completed':
        statusColor = '#4CAF50';
        statusIcon = '🎉';
        message = 'Đơn hàng đã hoàn thành!';
        actionMessage = 'Cảm ơn bạn đã tin tưởng và mua sắm tại cửa hàng của chúng tôi. Hẹn gặp lại bạn!';
        break;
      case 'cancelled':
        statusColor = '#f44336';
        statusIcon = '❌';
        message = 'Đơn hàng đã bị hủy';
        actionMessage = 'Đơn hàng của bạn đã bị hủy. Nếu có thắc mắc hoặc cần hỗ trợ, vui lòng liên hệ với chúng tôi.';
        break;
      case 'pending':
        statusColor = '#ffb200';
        statusIcon = '⏳';
        message = 'Đơn hàng đang chờ xác nhận';
        actionMessage = 'Chúng tôi đang xác nhận đơn hàng của bạn và sẽ sớm phản hồi.';
        break;
      default:
        message = `Trạng thái đơn hàng đã được cập nhật thành: ${statusLabel}`;
        actionMessage = 'Cảm ơn bạn đã quan tâm đến đơn hàng.';
    }
  } else if (statusType === 'payment') {
    switch(newStatus) {
      case 'paid':
        statusColor = '#4CAF50';
        statusIcon = '💳';
        message = 'Thanh toán thành công!';
        actionMessage = 'Đơn hàng của bạn đã được thanh toán thành công. Chúng tôi sẽ xử lý và giao hàng sớm nhất.';
        break;
      case 'failed':
        statusColor = '#f44336';
        statusIcon = '❌';
        message = 'Thanh toán thất bại';
        actionMessage = 'Rất tiếc, thanh toán đơn hàng không thành công. Vui lòng thử lại hoặc liên hệ hỗ trợ.';
        break;
      case 'cancelled':
        statusColor = '#f44336';
        statusIcon = '❌';
        message = 'Thanh toán đã hủy';
        actionMessage = 'Thanh toán đơn hàng đã bị hủy. Nếu có thắc mắc, vui lòng liên hệ với chúng tôi.';
        break;
      case 'pending':
        statusColor = '#ffb200';
        statusIcon = '⏳';
        message = 'Đang chờ thanh toán';
        actionMessage = 'Vui lòng hoàn tất thanh toán để chúng tôi xử lý đơn hàng.';
        break;
      default:
        message = `Trạng thái thanh toán đã được cập nhật thành: ${statusLabel}`;
        actionMessage = 'Cảm ơn bạn đã quan tâm đến đơn hàng.';
    }
  }

  // Build items HTML
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
      .status-badge { display:inline-block; padding:12px 24px; border-radius:25px; font-weight:700; font-size:16px; margin:20px 0; }
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
                <div style="font-size:13px;opacity:0.9">Cập nhật đơn hàng ${orderCode}</div>
              </td>
            </tr>

            <tr>
              <td class="content" style="padding:22px">
                <div style="text-align:center;margin-bottom:24px">
                  <div style="font-size:56px;margin-bottom:12px">${statusIcon}</div>
                  <div class="status-badge" style="background:${statusColor};color:#fff">
                    ${statusLabel}
                  </div>
                </div>

                <h2 class="h2" style="margin:0 0 8px 0;color:#111;text-align:center">${message}</h2>
                <p style="margin:0 0 20px 0;color:#444;text-align:center;font-size:15px">
                  Xin chào <strong>${customer.fullName || 'quý khách'}</strong>, ${actionMessage}
                </p>

                <div style="text-align:center;margin:20px 0">
                  <a href="${orderUrl}" class="btn" style="background:#ffb200;color:#111;margin-right:8px">Xem đơn hàng</a>
                  <a href="${process.env.CLIENT_URL || '#'}" class="btn" style="background:#eee;color:#111">Đến cửa hàng</a>
                </div>

                <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:24px 0">
                  <table width="100%" cellpadding="6" cellspacing="0">
                    <tr>
                      <td style="color:#666;font-size:14px;padding:8px 0">Mã đơn hàng:</td>
                      <td style="text-align:right;font-weight:700;font-size:14px;padding:8px 0">${orderCode}</td>
                    </tr>
                    <tr>
                      <td style="color:#666;font-size:14px;padding:8px 0">Trạng thái đơn hàng:</td>
                      <td style="text-align:right;font-weight:700;font-size:14px;padding:8px 0">${getStatusLabel(order.orderStatus)}</td>
                    </tr>
                    <tr>
                      <td style="color:#666;font-size:14px;padding:8px 0">Trạng thái thanh toán:</td>
                      <td style="text-align:right;font-weight:700;font-size:14px;padding:8px 0">${getStatusLabel(order.paymentMethod?.status || 'pending')}</td>
                    </tr>
                    <tr style="border-top:2px solid #ddd">
                      <td style="color:#111;font-weight:700;font-size:15px;padding:12px 0 8px 0">Tổng tiền:</td>
                      <td style="text-align:right;font-weight:800;font-size:16px;color:#ffb200;padding:12px 0 8px 0">${formatCurrency(total)}</td>
                    </tr>
                  </table>
                </div>

                <h3 style="margin:24px 0 12px 0;color:#111;font-size:16px">Chi tiết sản phẩm</h3>
                <table class="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
                  <thead>
                    <tr style="background:#fafafa">
                      <th style="padding:10px 0;text-align:left;font-size:13px;color:#666;font-weight:600">Sản phẩm</th>
                      <th style="padding:10px 0;text-align:center;font-size:13px;color:#666;font-weight:600">SL</th>
                      <th style="padding:10px 0;text-align:right;font-size:13px;color:#666;font-weight:600">Giá</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemsHtml || '<tr><td colspan="3" style="padding:12px;color:#777;text-align:center">Không có sản phẩm</td></tr>'}
                  </tbody>
                </table>

                <table width="100%" cellpadding="6" cellspacing="0" style="margin-top:16px">
                  <tr><td class="muted">Tổng giá trị sản phẩm</td><td style="text-align:right;font-weight:700">${formatCurrency(subtotal)}</td></tr>
                  ${discount > 0 ? `<tr><td class="muted">Khuyến mãi</td><td style="text-align:right;color:#4CAF50">-${formatCurrency(discount)}</td></tr>` : ''}
                  <tr><td class="muted">Phí vận chuyển</td><td style="text-align:right">${formatCurrency(shippingFee)}</td></tr>
                  <tr style="border-top:2px solid #eee"><td style="font-weight:800;padding-top:10px">Tổng cộng</td><td style="text-align:right;font-weight:800;padding-top:10px;color:#ffb200;font-size:18px">${formatCurrency(total)}</td></tr>
                </table>

                <h3 style="margin:24px 0 12px 0;color:#111;font-size:16px">Thông tin giao hàng</h3>
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="stack">
                  <tr>
                    <td style="vertical-align:top;padding-right:12px;width:50%;box-sizing:border-box">
                      <div style="font-weight:600;margin-bottom:8px;color:#111">Địa chỉ giao hàng</div>
                      <div style="color:#555;font-size:14px;line-height:1.6">
                        <strong>${customer.fullName || ''}</strong><br/>
                        ${customer.addressLine1 || customer.addressLine || ''}<br/>
                        ${[customer.ward, customer.district, customer.city].filter(Boolean).join(', ')}<br/>
                        <span style="color:#666">📞 ${customer.phone || ''}</span><br/>
                        ${customer.email ? `<span style="color:#666">📧 ${customer.email}</span>` : ''}
                      </div>
                    </td>
                    <td style="vertical-align:top;padding-left:12px;width:50%;box-sizing:border-box">
                      <div style="font-weight:600;margin-bottom:8px;color:#111">Phương thức</div>
                      <div style="color:#555;font-size:14px;line-height:1.6">
                        <div style="margin-bottom:8px">
                          <strong>Vận chuyển:</strong><br/>
                          ${order.shippingMethod || 'Giao hàng tận nơi'}
                        </div>
                        <div>
                          <strong>Thanh toán:</strong><br/>
                          ${order.paymentMethod?.type === 'COD' ? 'COD (Thanh toán khi nhận hàng)' : (order.paymentMethod?.type || '—')}
                        </div>
                      </div>
                    </td>
                  </tr>
                </table>

                ${order.note ? `
                <div style="background:#fff8e1;border-left:4px solid #ffb200;padding:12px;margin-top:20px;border-radius:4px">
                  <div style="font-weight:600;color:#111;margin-bottom:4px">Ghi chú đơn hàng:</div>
                  <div style="color:#666;font-size:14px">${order.note}</div>
                </div>
                ` : ''}

                <div style="text-align:center;margin-top:24px;padding-top:20px;border-top:1px solid #eee">
                  <p style="color:#777;font-size:13px;margin:0 0 8px 0">
                    Nếu bạn có bất kỳ câu hỏi nào, vui lòng liên hệ với chúng tôi
                  </p>
                  <p style="margin:4px 0">
                    <a href="mailto:${process.env.SUPPORT_EMAIL || 'support@shopnow.com'}" style="color:#ffb200;font-weight:600;text-decoration:none">${process.env.SUPPORT_EMAIL || 'support@shopnow.com'}</a>
                  </p>
                </div>
              </td>
            </tr>

            <tr>
              <td style="background:#fafafa;padding:14px 22px;color:#666;font-size:13px;text-align:center">
                <div style="margin-bottom:6px">© ${new Date().getFullYear()} ${shopName}. All rights reserved.</div>
                <div style="font-size:12px">Email này được gửi tự động, vui lòng không trả lời trực tiếp.</div>
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

async function sendOrderStatusUpdateEmail(order, to, statusType, newStatus) {
  if (!to) return null;
  const orderCode = order.orderCode || `SHOPNOW-${(order._id || '').toString().slice(-6)}`;
  const statusLabel = getStatusLabel(newStatus);
  const subject = `Đơn hàng ${orderCode} - ${statusLabel}`;
  const html = buildOrderStatusUpdateHtml(order, statusType, newStatus);
  const text = `Đơn hàng ${orderCode} đã được cập nhật trạng thái: ${statusLabel}`;
  return sendMail({ to, subject, text, html });
}

module.exports = {
  sendOrderCreatedEmail,
  sendOrderStatusUpdateEmail,
};  