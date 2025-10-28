const cron = require("node-cron");
const { exec } = require("child_process");

const TRAIN_CMD = `python scripts/train_als.py \
--mongo-uri "${process.env.MONGO_URI}" \
--orders-collection orders \
--out-collection cfrecommendations \
--topk 12`;

cron.schedule("0 */4 * * *", () => {
  console.log("🚀 Running CF training job every 4 hours:", new Date().toLocaleString());

  exec(TRAIN_CMD, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ Training failed:", error.message);
      return;
    }

    console.log("✅ Training completed successfully at", new Date().toLocaleString());
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
  });
});
