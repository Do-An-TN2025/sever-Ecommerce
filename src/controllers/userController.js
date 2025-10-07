const User = require("../models/User");
const generateToken = require("../utils/generateToken");
const { comparePassword, hashPassword } = require("../utils/hashPassword");
const { generateOtp, saveOtp, verifyOtp } = require("../utils/otpService");
const sendOtpMail = require("../utils/sendOtpMail");
const admin = require('../config/firebase');


exports.socialLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: 'idToken required' });

    if (process.env.FIREBASE_DEBUG === '1') {
      console.log('[SOCIAL] raw length:', idToken.length);
      try {
        const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'));
        console.log('[SOCIAL] payload.aud:', payload.aud, 'iss:', payload.iss);
        console.log('[SOCIAL] service project_id:', process.env.FIREBASE_SERVICE_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_JSON).project_id : 'none');
      } catch (e) {
        console.log('[SOCIAL] cannot decode payload', e.message);
      }
    }
    const decoded = await admin.auth().verifyIdToken(idToken);
    const provider = decoded.firebase?.sign_in_provider || 'firebase';
    const providerId = decoded.uid;
    const email = decoded.email;
    const name = decoded.name || '';
    const picture = decoded.picture;

    let user = await User.findOne({
      $or: [
        { email },
        { socialLogins: { $elemMatch: { provider, providerId } } }
      ]
    });

    if (!user) {
      const parts = name.trim().split(/\s+/);
      user = await User.create({
        firstName: parts.slice(0, -1).join(' ') || parts[0] || 'User',
        lastName: parts.slice(-1).join(' ') || '',
        email,
        avatar: picture,
        socialLogins: [{ provider, providerId }]
      });
    } else {
      if (!user.socialLogins.some(sl => sl.provider === provider && sl.providerId === providerId)) {
        user.socialLogins.push({ provider, providerId });
      }
      if (picture && user.avatar !== picture) user.avatar = picture;
      await user.save();
    }

    const token = generateToken(user._id);

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        role: user.role,
        providers: user.socialLogins.map(s => s.provider)
      }
    });
  } catch (e) {
   console.error('socialLogin error detail:', e.errorInfo || e.message);
    return res.status(401).json({ message: 'Invalid idToken' });
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
