const express = require("express");
const dotenv = require("dotenv");
const connectDB = require("./src/config/DB");

dotenv.config(); 

const app = express();
app.use(express.json());



const userRoutes = require("./src/routes/UserRoutes");
const categoryRoutes = require("./src/routes/categoryRoutes");
const productRoutes = require("./src/routes/productRoutes");
const variantRoutes = require("./src/routes/variantRoutes");

app.use("/api/users", userRoutes);  
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/variants", variantRoutes);


connectDB();
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server run on port ${PORT}`));
