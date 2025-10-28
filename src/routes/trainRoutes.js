const express = require('express');
const { exec } = require('child_process');
const router = express.Router();

router.get("/run-train", (req, res) => {
  exec("python scripts/train_als.py --mongo-uri \"mongodb+srv://thanhvuphan2987:4rIP6qjKzcC3XZTk@ecommerce-data.vqrzjag.mongodb.net/KL-Data\" --orders-collection orders --out-collection cfrecommendations --topk 12", (error, stdout, stderr) => {
    if (error) return res.status(500).send(`Error: ${error.message}`);
    res.send(`✅ Done at ${new Date().toLocaleString()}`);
  });
});

module.exports = router;