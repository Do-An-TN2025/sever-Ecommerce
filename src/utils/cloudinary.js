const cloudinary = require("cloudinary").v2;
require("dotenv").config();
const fs = require("fs");
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
    

const uploadImage = async (filePath, folder = "variants") => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: folder, 
      upload_preset: "products_preset"
    });
    fs.unlinkSync(filePath);
    return result.secure_url;
  } catch (error) {
    throw new Error("Upload thất bại: " + error.message);
  }
};



const deleteImage = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    return true;
  } catch (error) {
    throw new Error("Xóa ảnh thất bại: " + error.message);
  }
};

module.exports = { uploadImage, deleteImage };
