// Wishlist handlers
exports.addToWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: "Thiếu productId" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Không tìm thấy user" });
    if (user.wishlist.includes(productId)) {
      return res.status(400).json({ message: "Sản phẩm đã có trong wishlist" });
    }
    user.wishlist.push(productId);
    await user.save();
    res.json({ message: "Đã thêm vào wishlist", wishlist: user.wishlist });
  } catch (error) {
    res.status(500).json({ message: "Lỗi thêm wishlist" });
  }
};

exports.removeFromWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const { productId } = req.body;
    if (!productId) return res.status(400).json({ message: "Thiếu productId" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "Không tìm thấy user" });
    user.wishlist = user.wishlist.filter(
      (id) => id.toString() !== productId.toString()
    );
    await user.save();
    res.json({ message: "Đã xóa khỏi wishlist", wishlist: user.wishlist });
  } catch (error) {
    res.status(500).json({ message: "Lỗi xóa wishlist" });
  }
};

exports.getWishlist = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId)
      .populate({
        path: "wishlist",
        populate: { path: "variants" }
      });
    if (!user) return res.status(404).json({ message: "Không tìm thấy user" });
    res.json({ wishlist: user.wishlist });
  } catch (error) {
    res.status(500).json({ message: "Lỗi lấy wishlist" });
  }
};


const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const { comparePassword, hashPassword } = require("../utils/hashPassword");
const { generateOtp, saveOtp, verifyOtp } = require("../utils/otpService");
const sendOtpMail = require("../utils/sendOtpMail");
const admin = require('../config/firebase');


exports.socialLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: "idToken required" });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      console.error("[SOCIAL] verifyIdToken failed:", e.errorInfo || e.message);
      return res.status(401).json({ message: "Invalid idToken", stage: "verify" });
    }

    const rawProvider = decoded.firebase?.sign_in_provider || "firebase";
    const provider = rawProvider.replace(".com", "");
    const providerId = decoded.uid;
    const emailRaw = decoded.email;
    const name = decoded.name || "";
    const picture = decoded.picture;

    // Fallback email (đảm bảo unique)
    const email = emailRaw || `${provider}_${providerId}@no-email.local`;

    // Tách tên
    const parts = name.trim().split(/\s+/);
    const firstName = parts.slice(0, -1).join(" ") || parts[0] || "User";
    const lastName = parts.slice(-1).join(" ") || "";

    // Xây query động
    const or = [{ socialLogins: { $elemMatch: { provider, providerId } } }];
    if (emailRaw) or.unshift({ email: emailRaw }); // chỉ push email thực sự có

    let user = await User.findOne({ $or: or });

    if (!user) {
      try {
        user = await User.create({
          firstName,
            lastName,
          email,
          avatar: picture,
          socialLogins: [{ provider, providerId }]
        });
      } catch (e) {
        if (e.code === 11000) {
          // Email đã tồn tại nhưng socialLogins chưa có => gắn thêm
          user = await User.findOne({ email: emailRaw || email });
          if (!user)
            return res.status(500).json({ message: "Duplicate email, user not found" });
          if (
            !user.socialLogins.some(
              (s) => s.provider === provider && s.providerId === providerId
            )
          ) {
            user.socialLogins.push({ provider, providerId });
          }
          if (picture && user.avatar !== picture) user.avatar = picture;
          await user.save();
        } else {
          console.error("[SOCIAL] create user error:", e);
          return res.status(500).json({ message: "Create user failed" });
        }
      }
    } else {
      // Có user: cập nhật provider nếu thiếu
      if (
        !user.socialLogins.some(
          (s) => s.provider === provider && s.providerId === providerId
        )
      ) {
        user.socialLogins.push({ provider, providerId });
      }
      if (picture && user.avatar !== picture) user.avatar = picture;
      await user.save();
    }

    const token = generateToken(user._id);

    return res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        providers: user.socialLogins.map((s) => s.provider)
      }
    });
  } catch (e) {
    console.error("socialLogin outer error:", e);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.register = async (req, res) => {
  try {
    const { firstName, lastName , email, password , phone } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "Email đã tồn tại" });

    const hashed = await hashPassword(password);

    const user = await User.create({ firstName, lastName, email, password: hashed , phone });

    const token = generateToken(user);

    res.status(201).json({
      message: "Đăng ký thành công",
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

exports.registerAdmin = async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body;
    if (!role || !["admin", "staff"].includes(role)) {
      return res.status(400).json({ message: "Role phải là 'admin' hoặc 'staff'" });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) 
      return res.status(400).json({ message: "Email đã tồn tại" });
    const hashed = await hashPassword(password);
    const user = await User.create({
      firstName,
      lastName,
      email,
      password: hashed,
      phone,
      role
    });

    res.status(201).json({
      message: `${role} đã được tạo thành công`,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Email không tồn tại" });

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Mật khẩu không đúng" });

    const token = generateToken(user._id, user.role);

    res.json({
      message: "Đăng nhập thành công",
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        firstName : user.firstName,
        lastName : user.lastName
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Lỗi server", error: error.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.updateMe = async (req, res) => {
  try {
    const updateFields = {
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      phone: req.body.phone,
      gender: req.body.gender,
      dateOfBirth: req.body.dateOfBirth,
      avatar: req.body.avatar,
    };

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true }
    ).select("-password");

    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


function sortAddresses(addresses) {
  return [...addresses].sort((a,b) => Number(b.isDefault) - Number(a.isDefault));
}

exports.getAddresses = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("addresses");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const sorted = [...user.addresses].sort((a, b) => b.isDefault - a.isDefault);
    res.json(sorted);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.addAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const newAddress = {
      receiverName: req.body.receiverName,
      phone: req.body.phone,
      addressLine: req.body.addressLine,
      city: req.body.city,
      district: req.body.district,
      ward: req.body.ward,
      isDefault: !!req.body.isDefault
    };

    if (newAddress.isDefault) {
      user.addresses.forEach(a => a.isDefault = false);
    } else {
      if (!user.addresses.some(a => a.isDefault)) {
        newAddress.isDefault = true;
      }
    }

    user.addresses.push(newAddress);
    await user.save();

    return res.status(201).json(sortAddresses(user.addresses));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


exports.updateAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ message: "Address not found" });

    Object.assign(address, req.body);
    if (req.body.isDefault) {
      user.addresses.forEach(addr => (addr.isDefault = false));
      address.isDefault = true;
    }

    await user.save();
    res.json(user.addresses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.deleteAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ message: "Address not found" });

    const wasDefault = address.isDefault;
    address.deleteOne();

    // Nếu vừa xóa default và còn địa chỉ khác, gán cái đầu tiên làm default
    if (wasDefault && user.addresses.length > 0 && !user.addresses.some(a => a.isDefault)) {
      user.addresses[0].isDefault = true;
    }

    await user.save();
    return res.json(sortAddresses(user.addresses));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


exports.setDefaultAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const address = user.addresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ message: "Address not found" });

    user.addresses.forEach(addr => (addr.isDefault = false));
    address.isDefault = true;

    await user.save();
    res.json(user.addresses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.sendOtpController = async (req, res) => {
  try {
    const { email } = req.body;

    const otp = generateOtp();
    saveOtp(email, otp);

    await sendOtpMail(email, otp);

    res.json({ message: "Đã gửi OTP, kiểm tra email" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.verifyOtpController = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!verifyOtp(email, otp)) {
      return res
        .status(400)
        .json({ message: "OTP không hợp lệ hoặc đã hết hạn" });
    }

    res.json({ message: "Xác thực OTP thành công" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// --- Admin: manage staff users ---
// List staff and admin users (filter by role)
exports.listStaffs = async (req, res) => {
  try {
    const { page = 1, limit = 20, role } = req.query;
    const filter = { role: { $in: ["staff", "admin"] } };
    if (role && ["staff", "admin"].includes(role)) filter.role = role;

    const skip = (Number(page) - 1) * Number(limit);
    const users = await User.find(filter)
      .select("firstName lastName email phone role status createdAt")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    const total = await User.countDocuments(filter);
    res.json({ data: users, meta: { total, page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error("listStaffs error:", error);
    res.status(500).json({ message: "Lỗi server" });
  }
};

// Create staff/admin by admin
exports.createStaffByAdmin = async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body;
    if (!firstName || !lastName || !email || !password || !role)
      return res.status(400).json({ message: "Thiếu trường bắt buộc" });
    if (!["staff", "admin"].includes(role))
      return res.status(400).json({ message: "Role phải là 'staff' hoặc 'admin'" });

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "Email đã tồn tại" });

    const hashed = await hashPassword(password);
    const user = await User.create({ firstName, lastName, email, password: hashed, phone, role });

    res.status(201).json({ message: `${role} đã được tạo`, user: { id: user._id, email: user.email, role: user.role } });
  } catch (error) {
    console.error("createStaffByAdmin error:", error);
    res.status(500).json({ message: "Lỗi server" });
  }
};

// Update staff (admin only)
exports.updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, phone,email, role, status, password } = req.body;

    const update = {};
    if (firstName !== undefined) update.firstName = firstName;
    if (lastName !== undefined) update.lastName = lastName;
    if (email !== undefined) update.email = email;
    if (phone !== undefined) update.phone = phone;
    if (role !== undefined && ["staff", "admin", "customer"].includes(role)) update.role = role;
    if (status !== undefined) update.status = status;
    if (password) {
      update.password = await hashPassword(password);
    }

    const user = await User.findByIdAndUpdate(id, { $set: update }, { new: true }).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User updated", user });
  } catch (error) {
    console.error("updateStaff error:", error);
    res.status(500).json({ message: "Lỗi server" });
  }
};

// Delete staff (soft delete by setting status or hard delete)
exports.deleteStaff = async (req, res) => {
  try {
    const { id } = req.params;
    // Prefer soft-delete: set status = 'inactive'
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.role === 'admin') {
      return res.status(400).json({ message: "Không thể xóa admin" });
    }

    user.status = 'inactive';
    await user.save();

    res.json({ message: "User đã bị deactivated" });
  } catch (error) {
    console.error("deleteStaff error:", error);
    res.status(500).json({ message: "Lỗi server" });
  }
};

// Public endpoint: list active staff for public view (no auth)
exports.listPublicStaffs = async (req, res) => {
  try {
    const { page = 1, limit = 20, q } = req.query;
    const filter = { role: 'staff', status: 'active' };

    if (q && q.trim()) {
      const regex = new RegExp(q.trim(), 'i');
      filter.$or = [
        { firstName: regex },
        { lastName: regex },
        { email: regex }
      ];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const users = await User.find(filter)
      .select('firstName lastName avatar phone email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const total = await User.countDocuments(filter);
    res.json({ data: users, meta: { total, page: Number(page), limit: Number(limit) } });
  } catch (error) {
    console.error('listPublicStaffs error:', error);
    res.status(500).json({ message: 'Lỗi server' });
  }
};
