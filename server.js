const express = require("express");
const cors = require("cors");
const { ENV, connectDB } = require("./src/config");

const app = express();
app.use(express.json());
app.use(cors({ origin: ENV.CLIENT_URL, credentials: true }));

// Routes
app.use("/api/users", require("./src/routes/userRoutes"));
app.use("/api/categories", require("./src/routes/categoryRoutes"));
app.use("/api/products", require("./src/routes/productRoutes"));
app.use("/api/variants", require("./src/routes/variantRoutes"));
app.use("/api/chat", require("./src/routes/chatRoutes"));
app.use("/api/cart", require("./src/routes/cartRoutes"));
app.use ("/api/orders", require("./src/routes/orderRoutes"));
// Global error handler (sau cùng)
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

connectDB().then(() => {
  app.listen(ENV.PORT, () => console.log(`Server on ${ENV.PORT}`));
});
