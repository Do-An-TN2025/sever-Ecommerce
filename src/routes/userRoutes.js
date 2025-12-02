const express = require("express");
const router = express.Router();
const { 
    register, login , getMe , updateMe ,
    getAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress,
    registerAdmin,
    socialLogin,
    addToWishlist,
    removeFromWishlist,
    getWishlist,
    listStaffs, createStaffByAdmin, updateStaff, deleteStaff,
    listPublicStaffs
} = require("../controllers/userController");



const {authMiddleware , adminOnly} = require("../middlewares/authMiddleware");





router.get('/public/staffs', listPublicStaffs);
// api wishlist
router.get("/wishlist", authMiddleware, getWishlist);
router.post("/wishlist", authMiddleware, addToWishlist);
router.delete("/wishlist", authMiddleware, removeFromWishlist);

router.post("/social-login" , socialLogin);
router.post("/register", register);
router.post("/register-admin",authMiddleware,adminOnly,registerAdmin);
router.post("/login", login);
router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);

// address routes
router.get("/address", authMiddleware, getAddresses);
router.post("/address", authMiddleware, addAddress);
router.put("/address/:addressId", authMiddleware, updateAddress);
router.delete("/address/:addressId", authMiddleware, deleteAddress);
router.patch("/address/:addressId/default", authMiddleware, setDefaultAddress);


router.get('/admin/staffs', authMiddleware, adminOnly, listStaffs);
router.post('/admin/staffs', authMiddleware, adminOnly, createStaffByAdmin);
router.put('/admin/staffs/:id', authMiddleware, adminOnly, updateStaff);
router.delete('/admin/staffs/:id', authMiddleware, adminOnly, deleteStaff);





module.exports = router;