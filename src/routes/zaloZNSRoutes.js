const express = require("express");
const router = express.Router();
const { sendZNS } = require("../services/zaloZNSService");

router.post("/send", async (req, res) => {
  const { phone, templateId, templateData, trackingId, sendingMode } = req.body;

  if (!phone || !templateId || !templateData || !trackingId) {
    return res.status(400).json({ message: "Missing required parameters" });
  }

  try {
    await sendZNS({ phone, templateId, templateData, trackingId, sendingMode });
  } catch (_) {}

  return res.status(200).json({ success: true, message: "Request processed" });
});

module.exports = router;
