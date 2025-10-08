require('dotenv').config();
const mongoose = require('mongoose');

const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT || 8080),
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:3000',
  MONGO_URI: process.env.MONGO_URI,
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret',
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-1.5-flash-latest',
  CHAT_DEBUG: process.env.CHAT_DEBUG === '1',
  CLOUDINARY: {
    CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    API_KEY: process.env.CLOUDINARY_API_KEY,
    API_SECRET: process.env.CLOUDINARY_API_SECRET
  },
  PAYOS_CLIENT_ID: process.env.PAYOS_CLIENT_ID,
  PAYOS_API_KEY : process.env.PAYOS_API_KEY,
  PAYOS_CHECKSUM_KEY : process.env.PAYOS_CHECKSUM_KEY,
  PAYOS_API: process.env.PAYOS_API || "https://api.payos.vn"
};

let _dbConnected = false;
async function connectDB() {
  if (_dbConnected) return;
  if (!ENV.MONGO_URI) throw new Error('MONGO_URI missing');
  await mongoose.connect(ENV.MONGO_URI, { autoIndex: true });
  _dbConnected = true;
  console.log('Mongo connected');
}

// Simple central error builder (có thể mở rộng)
function buildError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

module.exports = {
  ENV,
  connectDB,
  buildError
};