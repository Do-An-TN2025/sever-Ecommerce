function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

const otpStore = {};

function saveOtp(email, otp) {
  otpStore[email] = {
    otp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

function verifyOtp(email, otp) {
  const record = otpStore[email];
  if (!record) return false;

  if (Date.now() > record.expiresAt) {
    delete otpStore[email];
    return false;
  }

  const isValid = record.otp === otp;
  if (isValid) delete otpStore[email];
  return isValid;
}

module.exports = { generateOtp, saveOtp, verifyOtp };
