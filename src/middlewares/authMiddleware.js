const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Base authentication middleware
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select("_id email role status");
      
      if (!req.user) {
        return res.status(401).json({ message: "User not found" });
      }
      
      // Check if user account is active
      if (req.user.status !== "active") {
        return res.status(401).json({ message: "Account is not active" });
      }
      
      next();
    } catch (error) {
      return res.status(401).json({ message: "Invalid token" });
    }
  } else {
    return res.status(401).json({ message: "No token provided" });
  }
};

// Admin only middleware
const adminOnly = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  
  next();
};

// Staff or Admin middleware
const staffOrAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  if (req.user.role !== "staff" && req.user.role !== "admin") {
    return res.status(403).json({ message: "Staff or Admin access required" });
  }
  
  next();
};

const customerOnly = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  if (req.user.role !== "customer") {
    return res.status(403).json({ message: "Customer access required" });
  }
  
  next();
};

const requireRoles = (allowedRoles) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `Access denied. Required roles: ${allowedRoles.join(", ")}` 
      });
    }
    
    next();
  };
};

const ownerOrAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Authentication required" });
  }
  
  const resourceUserId = req.params.userId || req.params.id;
  
  if (req.user.role === "admin" || req.user._id.toString() === resourceUserId) {
    next();
  } else {
    return res.status(403).json({ message: "Access denied. You can only access your own resources" });
  }
};



const authOptional = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("_id email role status");
    if (!req.user) return next();
    if (req.user.status !== "active") return next();
    return next();
  } catch (err) {
    return next();
  }
};

module.exports = {
  authMiddleware,
  adminOnly,
  staffOrAdmin,
  customerOnly,
  requireRoles,
  ownerOrAdmin,
  authOptional
};