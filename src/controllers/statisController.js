const mongoose = require("mongoose");
const Order = require("../models/Order");
const User = require("../models/User");
const ProductVariant = require("../models/ProductVariant");
const Product = require("../models/Product");
const { Types } = mongoose;
const { spawn } = require('child_process');
const path = require('path');
const ExcelJS = require('exceljs');
const axios = require('axios');

/**
 * GET /api/admin/stats/overview
 * Trả về thống kê tổng quan cho admin
 */
exports.getAdminStats = async (req, res) => {
  try {
    // tổng số đơn, tổng doanh thu (paid), tổng đơn theo trạng thái, khách hàng unique
    const [overview] = await Order.aggregate([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalOrders: { $sum: 1 },
                totalRevenueAll: { $sum: "$totalAmount" },
                totalPaidRevenue: {
                  $sum: {
                    $cond: [{ $eq: ["$paymentMethod.status", "paid"] }, "$totalAmount", 0]
                  }
                },
                totalPaidOrders: {
                  $sum: {
                    $cond: [{ $eq: ["$paymentMethod.status", "paid"] }, 1, 0]
                  }
                }
              }
            }
          ],
          byStatus: [
            {
              $group: {
                _id: "$orderStatus",
                count: { $sum: 1 }
              }
            }
          ],
          byPayment: [
            {
              $group: {
                _id: "$paymentMethod.status",
                count: { $sum: 1 }
              }
            }
          ],
          uniqueCustomers: [
            {
              $group: {
                _id: {
                  $ifNull: ["$userId", "$guestInfo.email"]
                }
              }
            },
            { $group: { _id: null, count: { $sum: 1 } } }
          ],
          recentOrders: [
            { $sort: { createdAt: -1 } },
            { $limit: 8 },
            {
              $project: {
                _id: 1,
                orderCode: 1,
                orderStatus: 1,
                "paymentMethod.status": 1,
                totalAmount: 1,
                createdAt: 1
              }
            }
          ]
        }
      }
    ]);

    const totals = (overview.totals && overview.totals[0]) || {};
    const statusCounts = (overview.byStatus || []).reduce((acc, s) => { acc[s._id || "unknown"] = s.count; return acc; }, {});
    const paymentCounts = (overview.byPayment || []).reduce((acc, p) => { acc[p._id || "unknown"] = p.count; return acc; }, {});
    const uniqueCustomers = (overview.uniqueCustomers && overview.uniqueCustomers[0] && overview.uniqueCustomers[0].count) || 0;

    return res.json({
      totalOrders: totals.totalOrders || 0,
      totalRevenueAll: totals.totalRevenueAll || 0,
      totalPaidRevenue: totals.totalPaidRevenue || 0,
      totalPaidOrders: totals.totalPaidOrders || 0,
      statusCounts,
      paymentCounts,
      uniqueCustomers,
      recentOrders: overview.recentOrders || []
    });
  } catch (err) {
    console.error("getAdminStats error:", err);
    return res.status(500).json({ message: "Lỗi khi lấy thống kê" });
  }
};

/**
 * GET /api/admin/stats/sales?period=day|week|month&range=30
 * Trả về doanh thu/đơn theo ngày/tuần/tháng trong khoảng range (số đơn vị thời gian)
 */
exports.getSalesByPeriod = async (req, res) => {
  try {
    const period = (req.query.period || "day").toLowerCase(); // day|week|month
    const range = Math.max(1, parseInt(req.query.range, 10) || 30); // number of units
    const now = new Date();

    // compute start date
    let startDate = new Date();
    if (period === "day") startDate.setDate(now.getDate() - (range - 1));
    else if (period === "week") startDate.setDate(now.getDate() - (range * 7 - 1));
    else startDate.setMonth(now.getMonth() - (range - 1));

    // group format
    let groupId;
    if (period === "day") {
      groupId = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        day: { $dayOfMonth: "$createdAt" }
      };
    } else if (period === "week") {
      // ISO week is complex, approximate by weekStart (year + week number)
      groupId = {
        year: { $isoWeekYear: "$createdAt" },
        week: { $isoWeek: "$createdAt" }
      };
    } else {
      groupId = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" }
      };
    }

    const pipeline = [
      { $match: { createdAt: { $gte: startDate } } },
      { $match: { "paymentMethod.status": "paid" } }, 
      {
        $group: {
          _id: groupId,
          orders: { $sum: 1 },
          revenue: { $sum: "$totalAmount" }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.week": 1, "_id.day": 1 } }
    ];

    const rows = await Order.aggregate(pipeline);

    // normalize to series with labels
    const labels = [];
    const data = [];

    const mapKey = (g) => {
      if (period === "day") return `${g._id.year}-${String(g._id.month).padStart(2,"0")}-${String(g._id.day).padStart(2,"0")}`;
      if (period === "week") return `${g._id.year}-W${String(g._id.week).padStart(2,"0")}`;
      return `${g._id.year}-${String(g._id.month).padStart(2,"0")}`;
    };

    // build map for quick lookup
    const rowMap = {};
    for (const r of rows) {
      rowMap[mapKey(r)] = { orders: r.orders, revenue: r.revenue };
    }

    // generate series from startDate to now by period
    const cursor = new Date(startDate);
    for (let i = 0; i < range; i++) {
      let label;
      if (period === "day") {
        label = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}-${String(cursor.getDate()).padStart(2,"0")}`;
        cursor.setDate(cursor.getDate() + 1);
      } else if (period === "week") {
        // compute ISO week label by taking Monday of that week
        const tmp = new Date(cursor);
        const weekStart = new Date(tmp.setDate(tmp.getDate() - tmp.getDay() + 1)); // Monday
        const weekYear = new Date(weekStart).getFullYear();
        // approximate week number by counting weeks since epoch is complex; use label by start date
        label = `${weekYear}-W${String(Math.ceil((((weekStart - new Date(weekStart.getFullYear(),0,1))/(1000*60*60*24))+1)/7)).padStart(2,"0")}`;
        cursor.setDate(cursor.getDate() + 7);
      } else {
        label = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,"0")}`;
        cursor.setMonth(cursor.getMonth() + 1);
      }
      labels.push(label);
      const val = rowMap[label] || { orders: 0, revenue: 0 };
      data.push(val);
    }

    return res.json({ period, range, labels, data });
  } catch (err) {
    console.error("getSalesByPeriod error:", err);
    return res.status(500).json({ message: "Lỗi khi lấy doanh thu theo thời gian" });
  }
};

/**
 * GET /api/admin/stats/top-products?limit=10&periodDays=90
 * Trả về top sản phẩm theo số lượng bán trong khoảng periodDays (mặc định 90)
 */ 
exports.getTopProducts = async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 10);
    const periodDays = Math.max(1, parseInt(req.query.periodDays, 10) || 90);
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    // unwind items and sum qty + revenue for paid orders
    const pipeline = [
      { $match: { createdAt: { $gte: since }, "paymentMethod.status": "paid" } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          productName: { $first: "$items.name" },
          sku: { $first: "$items.sku" },
          qtySold: { $sum: "$items.quantity" },
          revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } }
        }
      },
      { $sort: { qtySold: -1, revenue: -1 } },
      { $limit: limit }
    ];

    const rows = await Order.aggregate(pipeline);

    return res.json({ periodDays, limit, data: rows });
  } catch (err) {
    console.error("getTopProducts error:", err);
    return res.status(500).json({ message: "Lỗi khi lấy top sản phẩm" });
  }
};

/**
 * GET /api/admin/stats/forecast?period=day&limit=1
 * Trả về forecast được lưu trong collection `revenue_forecasts`.
 * Nếu `limit` > 1 trả về nhiều bản ghi (mới nhất trước).
 */
exports.getRevenueForecast = async (req, res) => {
  try {
    const period = (req.query.period || null);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 1);

    // use native driver to access arbitrary collection
    const db = (await require('mongoose').connection).db;
    const coll = db.collection('revenue_forecasts');

    const q = {};
    if (period) q.period = period;

    const docs = await coll.find(q).sort({ createdAt: -1 }).limit(limit).toArray();

    if (!docs || docs.length === 0) {
      return res.status(404).json({ message: 'No forecast found' });
    }

    // if limit==1 return single object for convenience
    if (limit === 1) return res.json(docs[0]);
    return res.json(docs);
  } catch (err) {
    console.error('getRevenueForecast error:', err);
    return res.status(500).json({ message: 'Lỗi khi lấy forecast' }); 
  }
};

/**
 * GET /api/admin/stats/export-excel
 * Exports multiple statistic sheets into an Excel file
 */
exports.exportStatsExcel = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.created = new Date();

    // Helper to try generate chart PNG from QuickChart
    async function fetchChartPng(chartConfig, width = 800, height = 300) {
      try {
        const body = { chart: chartConfig, width, height, format: 'png' };
        const resp = await axios.post('https://quickchart.io/chart', body, { responseType: 'arraybuffer', timeout: 10000 });
        return Buffer.from(resp.data);
      } catch (e) {
        console.warn('Chart generation failed:', e.message || e);
        return null;
      }
    }

    // Vietnamese label mappings for statuses and payment states
    const STATUS_LABELS = {
      pending: 'Đang chờ',
      confirm: 'Chờ xác nhận',
      confirmed: 'Đã xác nhận',
      completed: 'Hoàn thành',
      shipped: 'Đã giao',
      cancelled: 'Đã hủy'
    };
    const PAYMENT_LABELS = {
      paid: 'Đã thanh toán',
      pending: 'Chưa thanh toán',
      cancelled: 'Đã hủy'
    };

    // 1) Overview sheet (Vietnamese labels + styling)
    const overviewSheet = workbook.addWorksheet('Tổng quan');
    const [overview] = await Order.aggregate([
      {
        $facet: {
          totals: [
            { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenueAll: { $sum: '$totalAmount' }, totalPaidRevenue: { $sum: { $cond: [{ $eq: ['$paymentMethod.status', 'paid'] }, '$totalAmount', 0] } }, totalPaidOrders: { $sum: { $cond: [{ $eq: ['$paymentMethod.status', 'paid'] }, 1, 0] } } } }
          ],
          byStatus: [ { $group: { _id: '$orderStatus', count: { $sum: 1 } } } ],
          byPayment: [ { $group: { _id: '$paymentMethod.status', count: { $sum: 1 } } } ],
          uniqueCustomers: [ { $group: { _id: { $ifNull: ['$userId', '$guestInfo.email'] } } }, { $group: { _id: null, count: { $sum: 1 } } } ]
        }
      }
    ]);

    const totals = (overview.totals && overview.totals[0]) || {};
    overviewSheet.columns = [{ width: 36 }, { width: 22 }];
    // Build key/value table rows and keep index to style as table
    overviewSheet.addRow(['Khóa', 'Giá trị']);
    const rowStart = overviewSheet.rowCount + 0; // header row index will be row 1 after next lines
    overviewSheet.addRow(['Tổng đơn', totals.totalOrders || 0]);
    overviewSheet.addRow(['Tổng doanh thu (tất cả)', totals.totalRevenueAll || 0]);
    overviewSheet.addRow(['Tổng doanh thu (đã thanh toán)', totals.totalPaidRevenue || 0]);
    overviewSheet.addRow(['Tổng đơn đã thanh toán', totals.totalPaidOrders || 0]);
    const uniqueCustomers = (overview.uniqueCustomers && overview.uniqueCustomers[0] && overview.uniqueCustomers[0].count) || 0;
    overviewSheet.addRow(['Khách hàng duy nhất', uniqueCustomers]);
    const tableEndRow = overviewSheet.rowCount;
    overviewSheet.addRow([]);
    overviewSheet.addRow(['Đơn theo trạng thái', 'Số lượng']);
    const statusStart = overviewSheet.rowCount + 1;
    (overview.byStatus || []).forEach(s => {
      const label = STATUS_LABELS[s._id] || s._id || 'unknown';
      overviewSheet.addRow([label, s.count]);
    });
    const statusEnd = overviewSheet.rowCount;
    overviewSheet.addRow([]);
    overviewSheet.addRow(['Đơn theo trạng thái thanh toán', 'Số lượng']);
    const payStart = overviewSheet.rowCount + 1;
    (overview.byPayment || []).forEach(p => {
      const label = PAYMENT_LABELS[p._id] || p._id || 'unknown';
      overviewSheet.addRow([label, p.count]);
    });
    const payEnd = overviewSheet.rowCount;

    // style header rows
    // Style header row and table area
    const headerRow = overviewSheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF7FF' } };
    // Add borders and number format for key/value table
    for (let r = 1; r <= tableEndRow; r++) {
      const row = overviewSheet.getRow(r);
      row.eachCell((cell, colNumber) => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        if (typeof cell.value === 'number') cell.numFmt = '#,##0 "₫"';
      });
    }
    // Bold the section titles
    overviewSheet.getRow(statusStart - 1).font = { bold: true };
    overviewSheet.getRow(payStart - 1).font = { bold: true };

    // Highlight the status block and payment block: add light fill and medium border
    const highlightFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7FCFF' } };
    for (let r = statusStart; r <= statusEnd; r++) {
      const row = overviewSheet.getRow(r);
      row.eachCell((cell) => {
        cell.fill = highlightFill;
        cell.border = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };
      });
    }
    for (let r = payStart; r <= payEnd; r++) {
      const row = overviewSheet.getRow(r);
      row.eachCell((cell) => {
        cell.fill = highlightFill;
        cell.border = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };
      });
    }

    // Try to create a pie chart for order status
    try {
      const statusLabels = (overview.byStatus || []).map(s => STATUS_LABELS[s._id] || s._id || 'unknown');
      const statusData = (overview.byStatus || []).map(s => s.count || 0);
        if (statusLabels.length) {
          const pieConfig = { type: 'pie', data: { labels: statusLabels, datasets: [{ data: statusData }] }, options: { plugins: { legend: { position: 'right' } } } };
          const piePng = await fetchChartPng(pieConfig, 600, 360);
          if (piePng) {
            const imgId = workbook.addImage({ buffer: piePng, extension: 'png' });
            overviewSheet.addImage(imgId, { tl: { col: 2, row: 1 }, ext: { width: 520, height: 320 } });
          }
        }
    } catch (e) {
      console.warn('Failed to insert status chart:', e.message || e);
    }

    // 2) Sales sheet with chart (Vietnamese headers)
    const period = (req.query.period || 'day').toLowerCase();
    const range = Math.max(1, parseInt(req.query.range, 10) || 30);
    let startDate = new Date();
    const now = new Date();
    if (period === 'day') startDate.setDate(now.getDate() - (range - 1));
    else if (period === 'week') startDate.setDate(now.getDate() - (range * 7 - 1));
    else startDate.setMonth(now.getMonth() - (range - 1));

    let groupId;
    if (period === 'day') groupId = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };
    else if (period === 'week') groupId = { year: { $isoWeekYear: '$createdAt' }, week: { $isoWeek: '$createdAt' } };
    else groupId = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };

    const salesRows = await Order.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      { $match: { 'paymentMethod.status': 'paid' } },
      { $group: { _id: groupId, orders: { $sum: 1 }, revenue: { $sum: '$totalAmount' } } },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.week': 1, '_id.day': 1 } }
    ]);

    const mapKey = (g) => {
      if (period === 'day') return `${g._id.year}-${String(g._id.month).padStart(2,'0')}-${String(g._id.day).padStart(2,'0')}`;
      if (period === 'week') return `${g._id.year}-W${String(g._id.week).padStart(2,'0')}`;
      return `${g._id.year}-${String(g._id.month).padStart(2,'0')}`;
    };
    const rowMap = {};
    for (const r of salesRows) rowMap[mapKey(r)] = { orders: r.orders, revenue: r.revenue };

    const salesSheet = workbook.addWorksheet('Doanh thu');
    salesSheet.columns = [{ header: 'Thời gian', width: 22 }, { header: 'Số đơn', width: 12 }, { header: 'Doanh thu', width: 18 }];
    salesSheet.addRow(['Thời gian', 'Số đơn', 'Doanh thu']);
    const cursor = new Date(startDate);
    const salesLabels = [];
    const salesRevenue = [];
    for (let i = 0; i < range; i++) {
      let label;
      if (period === 'day') {
        label = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
        cursor.setDate(cursor.getDate() + 1);
      } else if (period === 'week') {
        const tmp = new Date(cursor);
        const weekStart = new Date(tmp.setDate(tmp.getDate() - tmp.getDay() + 1));
        const weekYear = new Date(weekStart).getFullYear();
        label = `${weekYear}-W${String(Math.ceil((((weekStart - new Date(weekStart.getFullYear(),0,1))/(1000*60*60*24))+1)/7)).padStart(2,'0')}`;
        cursor.setDate(cursor.getDate() + 7);
      } else {
        label = `${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`;
        cursor.setMonth(cursor.getMonth() + 1);
      }
      const val = rowMap[label] || { orders: 0, revenue: 0 };
      salesSheet.addRow([label, val.orders, val.revenue]);
      salesLabels.push(label);
      salesRevenue.push(val.revenue || 0);
    }

    // style header and freeze header row
    salesSheet.views = [{ state: 'frozen', ySplit: 1 }];
    const salesHeader = salesSheet.getRow(1);
    salesHeader.font = { bold: true };
    salesHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF7FF' } };
    // add borders and format numbers for data rows
    salesSheet.eachRow((row, rowNumber) => {
      row.eachCell(cell => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      if (rowNumber > 1) {
        const cell = row.getCell(3);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0 "₫"';
      }
    });

    // add a sales chart image below the data (use QuickChart)
    try {
      const chartConfig = {
        type: 'line',
        data: { labels: salesLabels, datasets: [{ label: 'Doanh thu', data: salesRevenue, borderColor: 'rgba(10,88,202,0.9)', backgroundColor: 'rgba(10,88,202,0.2)', fill: true }] },
        options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
      };
      const png = await fetchChartPng(chartConfig, 1000, 380);
      if (png) {
        const imgId = workbook.addImage({ buffer: png, extension: 'png' });
        // Place chart on the right side of the sheet (column D / index 3), near the top
        salesSheet.addImage(imgId, { tl: { col: 3, row: 1 }, ext: { width: 520, height: 320 } });
      }
    } catch (e) {
      console.warn('Sales chart failed:', e.message || e);
    }

    // 3) Top products (Vietnamese headers)
    const topLimit = Math.min(500, parseInt(req.query.top || req.query.limit, 10) || 50);
    const periodDays = Math.max(1, parseInt(req.query.periodDays, 10) || 90);
    const since = new Date();
    since.setDate(since.getDate() - periodDays);
    const topPipeline = [ { $match: { createdAt: { $gte: since }, 'paymentMethod.status': 'paid' } }, { $unwind: '$items' }, { $group: { _id: '$items.productId', productName: { $first: '$items.name' }, sku: { $first: '$items.sku' }, productImage: { $first: '$items.image' }, qtySold: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.quantity', '$items.price'] } } } }, { $sort: { qtySold: -1, revenue: -1 } }, { $limit: topLimit } ];
    const topRows = await Order.aggregate(topPipeline);
    // --- Redesigned top products sheet ---
    const topSheet = workbook.addWorksheet('Sản phẩm bán chạy');
    // Column layout: Rank | Image | Product name | SKU | Qty | Revenue
    topSheet.columns = [
      { header: 'Xếp hạng', width: 6 },
      { header: 'Hình ảnh', width: 14 },
      { header: 'Tên sản phẩm', width: 56 },
      { header: 'Mã SP', width: 28 },
      { header: 'Số lượng bán', width: 14 },
      { header: 'Doanh thu', width: 18 }
    ];
    topSheet.addRow(['Xếp hạng', 'Hình ảnh', 'Tên sản phẩm', 'Mã SP', 'Số lượng bán', 'Doanh thu']);
    // Styling for header
    topSheet.getRow(1).font = { bold: true };
    topSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF7FF' } };
    topSheet.views = [{ state: 'frozen', ySplit: 1 }];
    // Wrap product name and vertically center image column
    topSheet.getColumn(3).alignment = { wrapText: true, vertical: 'middle' };
    topSheet.getColumn(2).alignment = { vertical: 'middle', horizontal: 'center' };
    topSheet.getColumn(6).alignment = { horizontal: 'right', vertical: 'middle' };
    // freeze header and style
    topSheet.views = [{ state: 'frozen', ySplit: 1 }];
    topSheet.getRow(1).font = { bold: true };
    topSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF7FF' } };
    // add rows: put empty placeholder for image column (we'll insert images over these cells)
    topRows.forEach((r, idx) => topSheet.addRow([idx + 1, '', r.productName || '', r.sku || (r._id ? r._id.toString() : ''), r.qtySold || 0, r.revenue || 0]));
    // set a comfortable row height to fit images and center content, apply borders
    topSheet.eachRow((row, rn) => {
      if (rn > 1) row.height = 96;
      row.eachCell(cell => {
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      if (rn > 1) {
        const cell = row.getCell(6);
        if (typeof cell.value === 'number') cell.numFmt = '#,##0 "₫"';
      }
    });

    // Try to add top products revenue bar chart
    try {
      const labels = topRows.map(r => (r.productName || '').slice(0, 60));
      const revenues = topRows.map(r => r.revenue || 0);
      if (labels.length) {
        const cfg = { type: 'bar', data: { labels, datasets: [{ label: 'Doanh thu', data: revenues, backgroundColor: 'rgba(10,88,202,0.8)' }] }, options: { indexAxis: 'y', scales: { x: { beginAtZero: true } }, plugins: { legend: { display: false } } } };
        const png2 = await fetchChartPng(cfg, 1000, Math.min(800, 40 * labels.length + 160));
        if (png2) {
          const imgId2 = workbook.addImage({ buffer: png2, extension: 'png' });
          const lastRow = topSheet.rowCount + 1;
          topSheet.addImage(imgId2, { tl: { col: 0, row: lastRow }, ext: { width: 880, height: Math.min(1000, 40 * labels.length + 160) } });
        }
      }
    } catch (e) {
      console.warn('Top products chart failed:', e.message || e);
    }

    // Embed product images into the 'Hình ảnh' column for each row (if available)
    // Note: images are placed over cells as floating images anchored to the cell coordinates
    for (let idx = 0; idx < topRows.length; idx++) {
      const r = topRows[idx];
      if (!r.productImage) continue;
      try {
        const resp = await axios.get(r.productImage, { responseType: 'arraybuffer', timeout: 8000 });
        const ct = (resp.headers && resp.headers['content-type']) || '';
        let ext = 'png';
        if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpeg';
        else if (ct.includes('gif')) ext = 'gif';
        const imgId = workbook.addImage({ buffer: Buffer.from(resp.data), extension: ext });
        // place image in column index 1 (zero-based), row corresponding to data row (header at row 1)
        const dataRow = 2 + idx; // header row is 1, first data row is 2
        // small offsets center the image within the image column cell
        topSheet.addImage(imgId, { tl: { col: 1.12, row: dataRow - 1 + 0.06 }, ext: { width: 110, height: 88 } });
      } catch (err) {
        // ignore image fetch failures
        console.warn('Failed to fetch product image for top product:', r._id, err.message || err);
      }
    }

    // --- Sheet: Khách hàng hàng đầu ---
    try {
      const custLimit = Math.min(500, parseInt(req.query.customersLimit, 10) || 50);
      const custPeriodDays = Math.max(1, parseInt(req.query.customersPeriodDays, 10) || 90);
      const custSince = new Date(); custSince.setDate(custSince.getDate() - custPeriodDays);

      const topUsers = await Order.aggregate([
        { $match: { createdAt: { $gte: custSince }, 'paymentMethod.status': 'paid', userId: { $ne: null } } },
        { $group: { _id: '$userId', totalSpent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { totalSpent: -1 } },
        { $limit: custLimit },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        { $project: { userId: '$_id', name: { $concat: ['$user.firstName', ' ', '$user.lastName'] }, email: '$user.email', totalSpent: 1, orders: 1 } }
      ]);

      const topGuests = await Order.aggregate([
        { $match: { createdAt: { $gte: custSince }, 'paymentMethod.status': 'paid', userId: null, 'guestInfo.email': { $exists: true, $ne: '' } } },
        { $group: { _id: '$guestInfo.email', totalSpent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
        { $sort: { totalSpent: -1 } },
        { $limit: custLimit }
      ]);

      const custSheet = workbook.addWorksheet('Khách hàng hàng đầu');
      custSheet.columns = [
        { header: 'Hạng', width: 6 },
        { header: 'Tên / Email', width: 44 },
        { header: 'Email', width: 30 },
        { header: 'Số đơn', width: 12 },
        { header: 'Tổng chi tiêu', width: 18 }
      ];
      custSheet.addRow(['Hạng', 'Tên / Email', 'Email', 'Số đơn', 'Tổng chi tiêu']);
      custSheet.getRow(1).font = { bold: true };
      custSheet.views = [{ state: 'frozen', ySplit: 1 }];

      let rank = 1;
      for (const u of topUsers) {
        custSheet.addRow([rank++, u.name || (u.email || ''), u.email || '', u.orders || 0, u.totalSpent || 0]);
      }
      for (const g of topGuests) {
        custSheet.addRow([rank++, g._id || '', g._id || '', g.orders || 0, g.totalSpent || 0]);
      }
      custSheet.eachRow((row, rn) => {
        row.eachCell(cell => { cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
        if (rn > 1) { const c = row.getCell(5); if (typeof c.value === 'number') c.numFmt = '#,##0 "₫"'; }
      });
    } catch (e) {
      console.warn('Top customers sheet failed:', e.message || e);
    }

    // --- Sheet: Tồn kho sắp hết ---
    try {
      const lowStockThreshold = Math.max(0, parseInt(req.query.lowStockThreshold, 10) || 5);
      const invLimit = Math.min(1000, parseInt(req.query.invLimit, 10) || 200);
      const invPipeline = [
        { $unwind: '$sizes' },
        { $group: { _id: '$productId', totalStock: { $sum: '$sizes.stock' }, sampleSku: { $first: '$sizes.sku' }, sampleImage: { $first: '$images' } } },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'product' } },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        { $project: { productId: '$_id', productName: '$product.name', totalStock: 1, sampleSku: 1, sampleImage: { $arrayElemAt: ['$sampleImage', 0] } } },
        { $match: { totalStock: { $lte: lowStockThreshold } } },
        { $sort: { totalStock: 1 } },
        { $limit: invLimit }
      ];
      const invRows = await ProductVariant.aggregate(invPipeline);

      const invSheet = workbook.addWorksheet('Tồn kho sắp hết');
      invSheet.columns = [
        { header: 'Mã SP', width: 36 },
        { header: 'Tên sản phẩm', width: 56 },
        { header: 'SKU', width: 20 },
        { header: 'Tồn kho', width: 12 },
        { header: 'Hình ảnh', width: 14 }
      ];
      invSheet.addRow(['Mã SP', 'Tên sản phẩm', 'SKU', 'Tồn kho', 'Hình ảnh']);
      invSheet.getRow(1).font = { bold: true };
      invSheet.views = [{ state: 'frozen', ySplit: 1 }];
      // fill rows
      for (const r of invRows) {
        invSheet.addRow([r.productId ? (r.productId.toString ? r.productId.toString() : r.productId) : '', r.productName || '', r.sampleSku || '', r.totalStock || 0, '']);
      }
      // row heights and formatting
      invSheet.eachRow((row, rn) => {
        if (rn > 1) row.height = 80;
        row.eachCell(cell => { cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
      });
      // embed images
      for (let i = 0; i < invRows.length; i++) {
        const r = invRows[i];
        if (!r.sampleImage) continue;
        try {
          const resp = await axios.get(r.sampleImage, { responseType: 'arraybuffer', timeout: 8000 });
          const ct = (resp.headers && resp.headers['content-type']) || '';
          let ext = 'png'; if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpeg'; else if (ct.includes('gif')) ext = 'gif';
          const imgId = workbook.addImage({ buffer: Buffer.from(resp.data), extension: ext });
          const dataRow = 2 + i;
          invSheet.addImage(imgId, { tl: { col: 4.1, row: dataRow - 1 + 0.05 }, ext: { width: 110, height: 78 } });
        } catch (err) { console.warn('Failed to fetch inv image:', r.productId, err.message || err); }
      }
    } catch (e) {
      console.warn('Inventory sheet failed:', e.message || e);
    }

    // --- Sheet: Dự báo doanh thu (redesigned) ---
    try {
      const db = (await require('mongoose').connection).db;
      const coll = db.collection('revenue_forecasts');
      const forecastPeriod = (req.query.forecastPeriod || period || 'day');
      const stored = await coll.find({ period: forecastPeriod }).sort({ createdAt: -1 }).limit(5).toArray();

      const forecastSheet = workbook.addWorksheet('Dự báo doanh thu');
      // Title row (merged)
      forecastSheet.mergeCells('A1:C1');
      forecastSheet.getCell('A1').value = 'BÁO CÁO DỰ BÁO DOANH THU';
      forecastSheet.getCell('A1').font = { bold: true, size: 14 };
      forecastSheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };

      // Summary area (right side) will live in columns E/F
      forecastSheet.columns = [
        { header: 'Bước', width: 8 },
        { header: 'Mốc thời gian', width: 22 },
        { header: 'Dự báo (₫)', width: 18 },
        { header: '', width: 4 },
        { header: 'Chỉ số', width: 18 },
        { header: 'Giá trị', width: 18 }
      ];

      forecastSheet.views = [{ state: 'frozen', ySplit: 3 }];

      if (stored && stored.length) {
        const doc = stored[0];
        const fLabels = (doc.forecast && doc.forecast.labels) || [];
        const fVals = (doc.forecast && doc.forecast.values) || [];
        const histLabels = (doc.history && doc.history.labels) || [];
        const histVals = (doc.history && doc.history.values) || [];

        // KPI summary on the right
        const histSum = histVals.reduce((s,v) => s + (Number(v) || 0), 0);
        const fSum = fVals.reduce((s,v) => s + (Number(v) || 0), 0);
        const horizon = doc.horizon || fVals.length || 0;
        const growthPct = histSum ? ((fSum - histSum) / histSum) * 100 : 0;

        forecastSheet.getCell('E2').value = 'Tổng lịch sử';
        forecastSheet.getCell('F2').value = histSum; forecastSheet.getCell('F2').numFmt = '#,##0 "₫"';
        forecastSheet.getCell('E3').value = 'Tổng dự báo';
        forecastSheet.getCell('F3').value = fSum; forecastSheet.getCell('F3').numFmt = '#,##0 "₫"';
        forecastSheet.getCell('E4').value = 'Horizon'; forecastSheet.getCell('F4').value = horizon;
        forecastSheet.getCell('E5').value = 'Tăng trưởng'; forecastSheet.getCell('F5').value = `${growthPct.toFixed(2)} %`;
        // style KPI labels bold
        ['E2','E3','E4','E5'].forEach(k => forecastSheet.getCell(k).font = { bold: true });

        // Forecast table header (priority) - start at row 3 (under title and a spacer)
        const headerRowIdx = 7; // keep some space so sheet looks clean
        forecastSheet.getRow(headerRowIdx - 1).height = 8;
        forecastSheet.getCell(`A${headerRowIdx}`).value = 'Bước';
        forecastSheet.getCell(`B${headerRowIdx}`).value = 'Mốc thời gian';
        forecastSheet.getCell(`C${headerRowIdx}`).value = 'Dự báo (₫)';
        const headerRow = forecastSheet.getRow(headerRowIdx);
        headerRow.font = { bold: true };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF7FF' } };

        // write forecast rows first (prominent)
        const forecastStartRow = forecastSheet.rowCount + 1;
        for (let i = 0; i < fLabels.length; i++) {
          forecastSheet.addRow([i + 1, fLabels[i], fVals[i] || 0]);
        }
        const forecastEndRow = forecastSheet.rowCount;

        // spacer
        forecastSheet.addRow([]);

        // History table below the forecast table
        forecastSheet.addRow(['', 'LỊCH SỬ', '']);
        const histHeaderIdx = forecastSheet.rowCount + 1;
        forecastSheet.getRow(histHeaderIdx).font = { bold: true };
        for (let i = 0; i < histLabels.length; i++) {
          forecastSheet.addRow([i + 1, histLabels[i], histVals[i] || 0]);
        }

        // format value column as currency and highlight today's forecast row
        const today = new Date();
        const formatDateLabel = (dt, p) => {
          if (p === 'month') return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
          if (p === 'year') return `${dt.getFullYear()}`;
          return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
        };
        const todayLabel = formatDateLabel(today, forecastPeriod);

        for (let rn = 1; rn <= forecastSheet.rowCount; rn++) {
          const row = forecastSheet.getRow(rn);
          // currency format for value column (C)
          const valCell = row.getCell(3);
          if (typeof valCell.value === 'number') valCell.numFmt = '#,##0 "₫"';
          row.eachCell(c => { c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }; });
          // highlight forecast row matching today
          if (rn >= forecastStartRow && rn <= forecastEndRow) {
            const dateCell = forecastSheet.getRow(rn).getCell(2);
            if (dateCell && String(dateCell.value) === String(todayLabel)) {
              const redFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
              const redFont = { color: { argb: 'FF9C0006' }, bold: true };
              row.eachCell(cell => { cell.fill = redFill; cell.font = redFont; });
            }
          }
        }

        // Chart: forecast vs history, place to the right of the forecast table
        try {
          const chartLabels = histLabels.concat(fLabels);
          const chartHistory = histVals.concat(new Array(fLabels.length).fill(null));
          const chartForecast = new Array(histVals.length).fill(null).concat(fVals);
          const cfg = { type: 'line', data: { labels: chartLabels, datasets: [ { label: 'Lịch sử', data: chartHistory, borderColor: 'rgba(10,88,202,0.9)', backgroundColor: 'rgba(10,88,202,0.15)', fill: false }, { label: 'Dự báo', data: chartForecast, borderColor: 'rgba(220,50,50,0.9)', backgroundColor: 'rgba(220,50,50,0.15)', fill: false } ] }, options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } } };
          const png = await fetchChartPng(cfg, 1000, 360);
          if (png) {
            const imgId = workbook.addImage({ buffer: png, extension: 'png' });
            // place chart to the right of the forecast table (start at column D / index 3)
            forecastSheet.addImage(imgId, { tl: { col: 3, row: headerRowIdx - 1 }, ext: { width: 520, height: 320 } });
          }
        } catch (err) { console.warn('Forecast chart failed:', err.message || err); }

      } else {
        forecastSheet.addRow(['', 'No forecast found', '']);
      }
    } catch (e) {
      console.warn('Forecast sheet failed:', e.message || e);
    }

    // finalize and send workbook
    const buf = await workbook.xlsx.writeBuffer();
    const filename = `thongke_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buf));
  } catch (err) {
    console.error('exportStatsExcel error:', err);
    return res.status(500).json({ message: 'Lỗi khi xuất Excel' });
  }
};

/**
 * GET /api/admin/stats/slow-products?periodDays=90&limit=20
 * Trả về danh sách sản phẩm bán chậm nhưng còn tồn kho nhiều.
 */
exports.getSlowestProducts = async (req, res) => {
  try {
    const periodDays = Math.max(1, parseInt(req.query.periodDays, 10) || 90);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 20);
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    // Aggregate from products: compute totalStock from productvariants and qtySold from orders
    const pipeline = [
      {
        $lookup: {
          from: 'productvariants',
          let: { pid: '$_id' },
          pipeline: [
            { $unwind: { path: '$sizes', preserveNullAndEmptyArrays: true } },
            { $match: { $expr: { $eq: ['$productId', '$$pid'] } } },
            { $group: { _id: '$productId', totalStock: { $sum: { $ifNull: ['$sizes.stock', 0] } }, sampleImage: { $first: { $arrayElemAt: ['$images', 0] } } } }
          ],
          as: 'inv'
        }
      },
      {
        $lookup: {
          from: 'orders',
          let: { pid: '$_id' },
          pipeline: [
            { $match: { 'paymentMethod.status': 'paid', createdAt: { $gte: since } } },
            { $unwind: '$items' },
            { $match: { $expr: { $eq: ['$items.productId', '$$pid'] } } },
            { $group: { _id: '$items.productId', qtySold: { $sum: '$items.quantity' } } }
          ],
          as: 'sold'
        }
      },
      {
        $addFields: {
          totalStock: { $ifNull: [{ $arrayElemAt: ['$inv.totalStock', 0] }, 0] },
          sampleImage: { $ifNull: [{ $arrayElemAt: ['$inv.sampleImage', 0] }, null] },
          qtySold: { $ifNull: [{ $arrayElemAt: ['$sold.qtySold', 0] }, 0] }
        }
      },
      { $match: { totalStock: { $gt: 0 } } },
      { $addFields: { score: { $divide: ['$totalStock', { $add: ['$qtySold', 1] }] } } },
      { $sort: { score: -1, totalStock: -1, qtySold: 1 } },
      { $limit: limit },
      { $project: { _id: 1, name: 1, slug: 1, totalStock: 1, qtySold: 1, score: 1, sampleImage: 1 } }
    ];

    const rows = await Product.aggregate(pipeline);

    return res.json({ periodDays, limit, data: rows });
  } catch (err) {
    console.error('getSlowestProducts error:', err);
    return res.status(500).json({ message: 'Lỗi khi lấy sản phẩm bán chậm' });
  }
};

/**
 * GET /api/admin/stats/top-customers?periodDays=90&limit=10
 * Trả về top khách hàng trả nhiều tiền nhất (chỉ khách có tài khoản)
 */
exports.getTopCustomers = async (req, res) => {
  try {
    // Mirror behavior from exportStatsExcel: include both registered users and guest emails
    const periodDays = Math.max(1, parseInt(req.query.customersPeriodDays || req.query.periodDays, 10) || 90);
    const limit = Math.min(500, parseInt(req.query.customersLimit || req.query.limit, 10) || 50);
    const since = new Date();
    since.setDate(since.getDate() - periodDays);

    // Top registered users
    const topUsers = await Order.aggregate([
      { $match: { createdAt: { $gte: since }, 'paymentMethod.status': 'paid', userId: { $ne: null } } },
      { $group: { _id: '$userId', totalSpent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: limit },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $project: { userId: '$_id', name: { $trim: { input: { $concat: [{ $ifNull: ['$user.firstName',''] }, ' ', { $ifNull: ['$user.lastName',''] }] } } }, email: '$user.email', phone: '$user.phone', totalSpent: 1, orders: 1 } }
    ]);

    // Top guests by guestInfo.email
    const topGuests = await Order.aggregate([
      { $match: { createdAt: { $gte: since }, 'paymentMethod.status': 'paid', userId: null, 'guestInfo.email': { $exists: true, $ne: '' } } },
      { $group: { _id: '$guestInfo.email', totalSpent: { $sum: '$totalAmount' }, orders: { $sum: 1 } } },
      { $sort: { totalSpent: -1 } },
      { $limit: limit }
    ]);

    // Combine results as in export: users first, then guests
    const combined = [];
    let rank = 1;
    for (const u of topUsers) {
      combined.push({ rank: rank++, name: u.name || (u.email || ''), email: u.email || '', phone: u.phone || '', orders: u.orders || 0, totalSpent: u.totalSpent || 0, userId: u.userId });
    }
    for (const g of topGuests) {
      combined.push({ rank: rank++, name: g._id || '', email: g._id || '', phone: '', orders: g.orders || 0, totalSpent: g.totalSpent || 0 });
    }

    return res.json({ periodDays, limit, data: combined });
  } catch (err) {
    console.error('getTopCustomers error:', err);
    return res.status(500).json({ message: 'Lỗi khi lấy top khách hàng' });
  }
};

