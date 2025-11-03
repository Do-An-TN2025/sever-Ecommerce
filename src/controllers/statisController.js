const mongoose = require("mongoose");
const Order = require("../models/Order");
const { Types } = mongoose;
const { spawn } = require('child_process');
const path = require('path');

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
    // translation maps (EN -> VN)
    const statusLabelMap = {
      created: 'Đã tạo',
      pending: 'Đang chờ',
      processing: 'Đang xử lý',
      confirmed: 'Đã xác nhận',
      paid: 'Đã thanh toán',
      shipped: 'Đã gửi hàng',
      delivered: 'Đã giao',
      cancelled: 'Đã hủy',
      refunded: 'Đã hoàn tiền',
      unknown: 'Không xác định'
    };
    const paymentLabelMap = {
      paid: 'Đã thanh toán',
      pending: 'Đang chờ',
      failed: 'Thanh toán thất bại',
      cancelled: 'Đã hủy',
      refunded: 'Đã hoàn tiền',
      unpaid: 'Chưa thanh toán',
      unknown: 'Không xác định'
    };

    // translated count objects (keep original counts as well)
    const statusCountsVN = {};
    for (const [k, v] of Object.entries(statusCounts)) {
      const label = statusLabelMap[k] || k;
      statusCountsVN[label] = v;
    }
    const paymentCountsVN = {};
    for (const [k, v] of Object.entries(paymentCounts)) {
      const label = paymentLabelMap[k] || k;
      paymentCountsVN[label] = v;
    }
    const uniqueCustomers = (overview.uniqueCustomers && overview.uniqueCustomers[0] && overview.uniqueCustomers[0].count) || 0;

    // translate recentOrders fields for display convenience
    const recentOrders = (overview.recentOrders || []).map(o => ({
      ...o,
      orderStatusVN: statusLabelMap[o.orderStatus] || o.orderStatus,
      paymentStatusVN: (o.paymentMethod && o.paymentMethod.status) ? (paymentLabelMap[o.paymentMethod.status] || o.paymentMethod.status) : null
    }));

    return res.json({
      totalOrders: totals.totalOrders || 0,
      totalRevenueAll: totals.totalRevenueAll || 0,
      totalPaidRevenue: totals.totalPaidRevenue || 0,
      totalPaidOrders: totals.totalPaidOrders || 0,
      statusCounts,
      statusCountsVN,
      paymentCounts,
      paymentCountsVN,
      uniqueCustomers,
      recentOrders
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
      { $match: { "paymentMethod.status": "paid" } }, // only paid orders count to revenue
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
