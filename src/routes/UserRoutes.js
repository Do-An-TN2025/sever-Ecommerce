const express = require("express");
const router = express.Router();
const { 
    register, login , getMe , updateMe ,
    getAddresses,
    addAddress,
    updateAddress,
    deleteAddress,
    setDefaultAddress
} = require("../controllers/userController");
const authMiddleware = require("../middlewares/authMiddleware");

router.post("/register", register);
router.post("/login", login);
router.get("/me", authMiddleware, getMe);
router.put("/me", authMiddleware, updateMe);

// address routes
router.get("/address", authMiddleware, getAddresses);
router.post("/address", authMiddleware, addAddress);
router.put("/address/:addressId", authMiddleware, updateAddress);
router.delete("/address/:addressId", authMiddleware, deleteAddress);
router.patch("/address/:addressId/default", authMiddleware, setDefaultAddress);

module.exports = router;
