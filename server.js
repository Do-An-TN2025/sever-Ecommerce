const express = require("express");
const cors = require("cors");
require('dotenv').config();
const { ENV, connectDB } = require("./src/config");
const app = express();
app.use(express.json());

// CORS: support multiple allowed origins via env `CLIENT_URLS` (comma separated)
// Fallback to single `CLIENT_URL` for backward compatibility.
const rawClientUrls = process.env.CLIENT_URLS || process.env.CLIENT_URL || "";
const allowedOrigins = rawClientUrls
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Always allow common local dev origins if not explicitly provided
if (process.env.NODE_ENV !== 'production') {
  if (!allowedOrigins.includes('http://localhost:3000')) allowedOrigins.push('http://localhost:3000');
  if (!allowedOrigins.includes('http://localhost:5173')) allowedOrigins.push('http://localhost:5173');
  if (!allowedOrigins.includes('https://web-ecom-omega.vercel.app')) allowedOrigins.push('https://web-ecom-omega.vercel.app');
  if (!allowedOrigins.includes('http://127.0.0.1:3000')) allowedOrigins.push('http://127.0.0.1:3000');
  if (!allowedOrigins.includes('http://127.0.0.1:5173')) allowedOrigins.push('http://127.0.0.1:5173');
  if (!allowedOrigins.includes('https://arc-ecommerce-pos.dfm-engineering.com')) allowedOrigins.push('https://arc-ecommerce-pos.dfm-engineering.com');
}

console.log('Allowed CORS origins:', allowedOrigins);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like curl, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
    console.warn('Blocked CORS origin:', origin);
    return callback(new Error('CORS policy: This origin is not allowed - ' + origin));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Requested-With']
};

app.use(cors(corsOptions));

const corstest=process.env.CLIENT_URL;
console.log('Test CORS DEPLOYD:', corstest);
// Routes
require("./src/cron/trainModelJob");

app.use("/api/users", require("./src/routes/userRoutes"));
app.use("/api/categories", require("./src/routes/categoryRoutes"));
app.use("/api/products", require("./src/routes/productRoutes"));
app.use("/api/variants", require("./src/routes/variantRoutes"));  
app.use("/api/chat", require("./src/routes/chatRoutes")); 
app.use("/api/cart", require("./src/routes/cartRoutes"));
app.use ("/api/orders", require("./src/routes/orderRoutes"));
app.use("/api/vouchers", require("./src/routes/voucherRoutes"));
app.use("/api/admin/stats", require("./src/routes/statisRoutes"));


app.get('/ping', (req, res) => {
  res.status(200).send('ok');
});
console.log('ĐỖ MINH HÀO 8386:', corstest);

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

connectDB().then(() => {
  app.listen(ENV.PORT, () => console.log(`Server on ${ENV.PORT}`));
});

